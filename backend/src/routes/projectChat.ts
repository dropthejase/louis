import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { queryOne, execute } from "../lib/db";
import { checkCredits } from "../lib/credits";
import {
    buildProjectDocContext,
    buildMessages,
    buildWorkflowStore,
    enrichWithPriorEvents,
    extractAnnotations,
    runLLMStream,
    PROJECT_EXTRA_TOOLS,
    type ChatMessage,
} from "../lib/chatTools";
import { checkProjectAccess } from "../lib/access";

const PROJECT_SYSTEM_PROMPT_EXTRA = `PROJECT CONTEXT:
You are operating within a project folder that contains a collection of legal documents the user has organised for a single matter. The user's questions will usually refer to one or more documents in this project — your job is to find the relevant files to work on. Use list_documents to see what is available and fetch_documents / read_document to pull in any documents you need before answering.

A document may currently be displayed in the user's side panel; when provided, treat it as context for the user's likely focus, but do NOT assume it is the only or definitive document the user is asking about. If the request could apply to other files in the project, identify and read those as well. Prefer coverage across the relevant project documents over an over-narrow reading of only the displayed one.

REPLICATING A DOCUMENT:
When the user wants to use an existing project document as a starting point for a new file (e.g. "use this NDA as a template", "make me a copy of the SOW so I can edit it", "duplicate this and adapt it for company X"), call the replicate_document tool with the source doc_id. This creates a byte-for-byte copy as a new project document, returns a fresh doc_id slug, and shows a download/open card in the UI. Then call edit_document on the returned slug to make the user's requested changes — do NOT call generate_docx for cases where the user clearly wants the existing document's structure and formatting preserved.`;

export const projectChatRouter = Router({ mergeParams: true });

// POST /projects/:projectId/chat — streaming
projectChatRouter.post("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;

    const credits = await checkCredits(userId);
    if (!credits.allowed) {
        return void res.status(429).json({ error: 'credits_exhausted', reset_date: credits.resetDate });
    }

    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params;
    const { messages, chat_id, model, displayed_doc, attached_documents } =
        req.body as {
            messages: ChatMessage[];
            chat_id?: string;
            model?: string;
            displayed_doc?: { filename: string; document_id: string };
            attached_documents?: { filename: string; document_id: string }[];
        };

    // Verify the user has access to the project (owner or shared member).
    const projectAccess = await checkProjectAccess(
        projectId,
        userId,
        userEmail,
    );
    if (!projectAccess.ok)
        return void res.status(404).json({ detail: "Project not found" });

    let chatId = chat_id ?? null;
    let chatTitle: string | null = null;

    if (chatId) {
        const existing = await queryOne<{
            id: string;
            title: string | null;
            project_id: string | null;
        }>(
            `SELECT id, title, project_id FROM chats WHERE id = :id`,
            [{ name: "id", value: { stringValue: chatId } }],
        );
        const canUse = !!existing && existing.project_id === projectId;
        if (!canUse) chatId = null;
        else chatTitle = existing!.title;
    }

    if (!chatId) {
        const newChat = await queryOne<{ id: string; title: string | null }>(
            `INSERT INTO chats (user_id, project_id)
             VALUES (:userId, :projectId)
             RETURNING id, title`,
            [
                { name: "userId", value: { stringValue: userId } },
                { name: "projectId", value: { stringValue: projectId } },
            ],
        );
        if (!newChat)
            return void res
                .status(500)
                .json({ detail: "Failed to create chat" });
        chatId = newChat.id;
        chatTitle = newChat.title;
    }

    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (lastUser) {
        await execute(
            `INSERT INTO chat_messages (chat_id, role, content, files, workflow)
             VALUES (:chatId, :role, :content, :files::jsonb, :workflow::jsonb)`,
            [
                { name: "chatId", value: { stringValue: chatId } },
                { name: "role", value: { stringValue: "user" } },
                {
                    name: "content",
                    value:
                        lastUser.content != null
                            ? { stringValue: JSON.stringify(lastUser.content) }
                            : { isNull: true },
                },
                {
                    name: "files",
                    value: lastUser.files != null
                        ? { stringValue: JSON.stringify(lastUser.files) }
                        : { isNull: true },
                },
                {
                    name: "workflow",
                    value: lastUser.workflow != null
                        ? { stringValue: JSON.stringify(lastUser.workflow) }
                        : { isNull: true },
                },
            ],
        );
    }

    const { docIndex, docStore, folderPaths } = await buildProjectDocContext(
        projectId,
        userId,
    );
    const docAvailability = Object.entries(docIndex).map(([doc_id, info]) => ({
        doc_id,
        filename: info.filename,
        folder_path: folderPaths.get(doc_id),
    }));

    const enrichedMessages = await enrichWithPriorEvents(
        messages,
        chatId,
        docIndex,
    );
    const messagesForLLM: ChatMessage[] = displayed_doc
        ? enrichedMessages.map((m, i) => {
              if (i !== enrichedMessages.length - 1 || m.role !== "user")
                  return m;
              return {
                  ...m,
                  content: `${m.content}\n\ndisplayed_doc: ${displayed_doc.filename}, displayed_doc_id: ${displayed_doc.document_id}`,
              };
          })
        : enrichedMessages;

    // The user-attached docs for this turn (dragged into / picked from
    // the chat input) come in as a request-level field. Surface them in
    // the system prompt with the current-turn doc_id slugs so the model
    // knows which docs the user is highlighting *now*, distinct from
    // the broader project doc list.
    let systemPromptExtra = PROJECT_SYSTEM_PROMPT_EXTRA;
    if (attached_documents?.length) {
        const slugByDocumentId = new Map<string, string>();
        for (const [slug, info] of Object.entries(docIndex)) {
            if (info.document_id)
                slugByDocumentId.set(info.document_id, slug);
        }
        const lines = attached_documents.map((d) => {
            const slug = slugByDocumentId.get(d.document_id);
            return slug ? `- ${slug}: ${d.filename}` : `- ${d.filename}`;
        });
        systemPromptExtra += `\n\nUSER-ATTACHED DOCUMENTS FOR THIS TURN:\nThe user has attached the following document(s) directly to their latest message. Treat these as the primary focus of the request unless their message clearly says otherwise.\n${lines.join("\n")}`;
    }

    const apiMessages = buildMessages(
        messagesForLLM,
        docAvailability,
        systemPromptExtra,
    );

    const workflowStore = await buildWorkflowStore(userId, userEmail);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const write = (line: string) => res.write(line);

    try {
        write(`data: ${JSON.stringify({ type: "chat_id", chatId })}\n\n`);

        const { fullText, events } = await runLLMStream({
            apiMessages,
            docStore,
            docIndex,
            userId,
            write,
            extraTools: PROJECT_EXTRA_TOOLS,
            workflowStore,
            model,
            projectId,
        });

        const annotations = extractAnnotations(fullText, docIndex, events);
        await execute(
            `INSERT INTO chat_messages (chat_id, role, content, annotations)
             VALUES (:chatId, :role, :content::jsonb, :annotations::jsonb)`,
            [
                { name: "chatId", value: { stringValue: chatId } },
                { name: "role", value: { stringValue: "assistant" } },
                {
                    name: "content",
                    value: events.length
                        ? { stringValue: JSON.stringify(events) }
                        : { isNull: true },
                },
                {
                    name: "annotations",
                    value: annotations.length
                        ? { stringValue: JSON.stringify(annotations) }
                        : { isNull: true },
                },
            ],
        );

        if (!chatTitle && lastUser?.content) {
            await execute(
                `UPDATE chats SET title = :title WHERE id = :id`,
                [
                    {
                        name: "title",
                        value: { stringValue: lastUser.content.slice(0, 120) },
                    },
                    { name: "id", value: { stringValue: chatId } },
                ],
            );
        }
    } catch (err) {
        console.error("[project-chat/stream] error:", err);
        try {
            write(
                `data: ${JSON.stringify({ type: "error", message: "Stream error" })}\n\n`,
            );
            write("data: [DONE]\n\n");
        } catch {
            /* ignore */
        }
    } finally {
        res.end();
    }
});
