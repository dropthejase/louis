import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
    buildDocContext,
    buildMessages,
    enrichWithPriorEvents,
    buildWorkflowStore,
    extractAnnotations,
    runLLMStream,
    type ChatMessage,
} from "../lib/chatTools";
import { completeText } from "../lib/llm";
import { getUserApiKeys, getUserModelSettings } from "../lib/userSettings";
import { checkProjectAccess } from "../lib/access";
import {
    S3Client,
    ListObjectsV2Command,
    GetObjectCommand,
} from "@aws-sdk/client-s3";

// Lazy singleton S3 client for reading session snapshots.
let _s3: S3Client | undefined;
function getSessionS3(): S3Client {
    if (!_s3) {
        _s3 = new S3Client({ region: process.env.AWS_REGION ?? "eu-west-1" });
    }
    return _s3;
}

// ---------------------------------------------------------------------------
// Types mirroring the Strands snapshot message format
// ---------------------------------------------------------------------------
interface SnapshotContentBlock {
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
    tool_use_id?: string;
    content?: unknown;
}
interface SnapshotMessage {
    role: "user" | "assistant";
    content: SnapshotContentBlock[];
}

// ---------------------------------------------------------------------------
// Local types for the /messages endpoint output
// ---------------------------------------------------------------------------
type MikeAssistantEvent =
    | { type: "content"; text: string }
    | { type: "doc_read"; filename: string; document_id?: string }
    | { type: "doc_find"; filename: string; query: string; total_matches: number }
    | { type: "doc_created"; filename: string; download_url: string; document_id?: string; version_id?: string }
    | { type: "doc_edited"; filename: string; document_id: string; version_id: string; download_url: string; annotations: MikeEditAnnotation[] }
    | { type: "doc_replicated"; filename: string; count: number; copies?: { new_filename: string; document_id: string; version_id: string }[] };

interface MikeEditAnnotation {
    edit_id: string;
    document_id: string;
    version_id: string;
    change_id: string;
    deleted_text: string;
    inserted_text: string;
    status: "pending" | "accepted" | "rejected";
}

interface MikeCitationAnnotation {
    type: "citation_data";
    ref: number;
    doc_id: string;
    document_id: string;
    filename: string;
    page: number | string;
    quote: string;
}

interface MikeMessage {
    role: "user" | "assistant";
    content: string;
    annotations?: MikeCitationAnnotation[];
    events?: MikeAssistantEvent[];
}

// Strip <CITATIONS>...</CITATIONS> from text blocks.
function stripCitationsTag(text: string): string {
    return text.replace(/<CITATIONS>[\s\S]*?<\/CITATIONS>/g, "").trim();
}

function extractCitationsFromText(
    text: string,
): MikeCitationAnnotation[] {
    const match = text.match(/<CITATIONS>([\s\S]*?)<\/CITATIONS>/);
    if (!match) return [];
    try {
        const parsed = JSON.parse(match[1]) as unknown;
        if (Array.isArray(parsed)) {
            return parsed as MikeCitationAnnotation[];
        }
    } catch {
        // ignore
    }
    return [];
}

// Convert Strands snapshot messages into MikeMessage[].
function snapshotMessagesToMikeMessages(
    messages: SnapshotMessage[],
): MikeMessage[] {
    const result: MikeMessage[] = [];

    // Build a map of tool_use_id -> tool result content for lookup.
    const toolResults = new Map<string, unknown>();
    for (const msg of messages) {
        if (msg.role === "user") {
            for (const block of msg.content) {
                if (
                    block.type === "tool_result" &&
                    typeof block.tool_use_id === "string"
                ) {
                    toolResults.set(block.tool_use_id, block.content);
                }
            }
        }
    }

    for (const msg of messages) {
        if (msg.role === "user") {
            // Only include user text blocks (skip tool_result blocks).
            const textBlocks = msg.content.filter(
                (b) => b.type === "text" && typeof b.text === "string",
            );
            if (textBlocks.length === 0) continue;
            const content = textBlocks
                .map((b) => b.text ?? "")
                .join("\n")
                .trim();
            if (!content) continue;
            result.push({ role: "user", content });
        } else {
            // assistant message
            const textBlocks = msg.content.filter(
                (b) => b.type === "text" && typeof b.text === "string",
            );
            const toolUseBlocks = msg.content.filter(
                (b) => b.type === "tool_use",
            );

            const fullText = textBlocks.map((b) => b.text ?? "").join("\n");
            const content = stripCitationsTag(fullText);
            const annotations = extractCitationsFromText(fullText);

            const events: MikeAssistantEvent[] = [];
            if (content) {
                events.push({ type: "content", text: content });
            }

            for (const toolUse of toolUseBlocks) {
                const toolName = toolUse.name ?? "";
                const toolId = toolUse.id ?? "";
                const resultRaw = toolResults.get(toolId);
                let resultObj: Record<string, unknown> = {};
                try {
                    if (typeof resultRaw === "string") {
                        resultObj = JSON.parse(resultRaw) as Record<
                            string,
                            unknown
                        >;
                    } else if (Array.isArray(resultRaw)) {
                        // content array from tool_result
                        const textEntry = (
                            resultRaw as { type: string; text?: string }[]
                        ).find((e) => e.type === "text" && e.text);
                        if (textEntry?.text) {
                            resultObj = JSON.parse(textEntry.text) as Record<
                                string,
                                unknown
                            >;
                        }
                    }
                } catch {
                    // ignore parse errors
                }

                switch (toolName) {
                    case "read_document":
                        events.push({
                            type: "doc_read",
                            filename: (resultObj.filename as string) ?? "",
                        });
                        break;
                    case "find_in_document":
                        events.push({
                            type: "doc_find",
                            filename: (resultObj.filename as string) ?? "",
                            query: (resultObj.query as string) ?? "",
                            total_matches:
                                (resultObj.total_matches as number) ?? 0,
                        });
                        break;
                    case "generate_docx":
                        events.push({
                            type: "doc_created",
                            filename: (resultObj.filename as string) ?? "",
                            download_url:
                                (resultObj.download_url as string) ?? "",
                            document_id:
                                (resultObj.document_id as string) ?? undefined,
                            version_id:
                                (resultObj.version_id as string) ?? undefined,
                        });
                        break;
                    case "edit_document":
                        events.push({
                            type: "doc_edited",
                            filename: (resultObj.filename as string) ?? "",
                            document_id:
                                (resultObj.document_id as string) ?? "",
                            version_id: (resultObj.version_id as string) ?? "",
                            download_url:
                                (resultObj.download_url as string) ?? "",
                            annotations: Array.isArray(resultObj.annotations)
                                ? (resultObj.annotations as MikeEditAnnotation[])
                                : [],
                        });
                        break;
                    case "replicate_document":
                        events.push({
                            type: "doc_replicated",
                            filename: (resultObj.filename as string) ?? "",
                            count: (resultObj.count as number) ?? 0,
                            copies: Array.isArray(resultObj.copies)
                                ? (resultObj.copies as {
                                      new_filename: string;
                                      document_id: string;
                                      version_id: string;
                                  }[])
                                : undefined,
                        });
                        break;
                    // list_documents, fetch_documents, read_table_cells,
                    // list_workflows, read_workflow → no UI card, skip.
                    default:
                        break;
                }
            }

            result.push({
                role: "assistant",
                content,
                annotations: annotations.length ? annotations : undefined,
                events,
            });
        }
    }

    return result;
}

export const chatRouter = Router();

// GET /chat
// Visible chats = the user's own chats + every chat under a project the
// user owns (so a project owner sees all collaborator chats in their
// own projects in the global recent-chats list). Chats in projects that
// are merely *shared with* the user are NOT included here — those are
// listed per-project via GET /projects/:projectId/chats.
chatRouter.get("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();

    const { data: ownProjects, error: projErr } = await db
        .from("projects")
        .select("id")
        .eq("user_id", userId);
    if (projErr) return void res.status(500).json({ detail: projErr.message });
    const ownProjectIds = ((ownProjects ?? []) as { id: string }[]).map(
        (p) => p.id,
    );

    const filter =
        ownProjectIds.length > 0
            ? `user_id.eq.${userId},project_id.in.(${ownProjectIds.join(",")})`
            : `user_id.eq.${userId}`;

    const { data, error } = await db
        .from("chats")
        .select("*")
        .or(filter)
        .order("created_at", { ascending: false });
    if (error) return void res.status(500).json({ detail: error.message });
    res.json(data ?? []);
});

// POST /chat/create
chatRouter.post("/create", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const projectId: string | null = req.body.project_id ?? null;
    const db = createServerSupabase();
    const { data, error } = await db
        .from("chats")
        .insert({ user_id: userId, project_id: projectId ?? undefined })
        .select("id")
        .single();

    if (error) return void res.status(500).json({ detail: error.message });
    res.json({ id: data.id });
});

// GET /chat/:chatId
chatRouter.get("/:chatId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const db = createServerSupabase();

    const { data: chat, error } = await db
        .from("chats")
        .select("*")
        .eq("id", chatId)
        .single();
    if (error || !chat)
        return void res.status(404).json({ detail: "Chat not found" });
    // Owner of the chat OR a member of the chat's project can view it.
    let canView = chat.user_id === userId;
    if (!canView && chat.project_id) {
        const access = await checkProjectAccess(
            chat.project_id,
            userId,
            userEmail,
            db,
        );
        canView = access.ok;
    }
    if (!canView)
        return void res.status(404).json({ detail: "Chat not found" });

    const { data: messages } = await db
        .from("chat_messages")
        .select("*")
        .eq("chat_id", chatId)
        .order("created_at", { ascending: true });

    const hydrated = await hydrateEditStatuses(messages ?? [], db);
    res.json({ chat, messages: hydrated });
});

// Stored message annotations/events capture the `status` at the time the
// assistant produced the edit (always "pending"). If the user later accepts
// or rejects, `document_edits.status` is updated but the stored message
// annotation is not. On chat load we merge the current DB status in so
// EditCards render with the real state.
async function hydrateEditStatuses(
    messages: Record<string, unknown>[],
    db: ReturnType<typeof createServerSupabase>,
): Promise<Record<string, unknown>[]> {
    const editIds = new Set<string>();
    const versionIds = new Set<string>();
    const collectFromAnnList = (list: unknown) => {
        if (!Array.isArray(list)) return;
        for (const a of list as Record<string, unknown>[]) {
            if (typeof a?.edit_id === "string") editIds.add(a.edit_id);
            if (typeof a?.version_id === "string")
                versionIds.add(a.version_id);
        }
    };
    for (const m of messages) {
        collectFromAnnList(m.annotations);
        const content = m.content;
        if (Array.isArray(content)) {
            for (const ev of content as Record<string, unknown>[]) {
                if (ev?.type === "doc_edited") {
                    collectFromAnnList(ev.annotations);
                    if (typeof ev.version_id === "string")
                        versionIds.add(ev.version_id);
                }
            }
        }
    }
    if (editIds.size === 0 && versionIds.size === 0) return messages;

    // Edit status patch.
    const statusById = new Map<string, "pending" | "accepted" | "rejected">();
    if (editIds.size > 0) {
        const { data: rows } = await db
            .from("document_edits")
            .select("id, status")
            .in("id", Array.from(editIds));
        for (const r of (rows ?? []) as { id: string; status: string }[]) {
            if (
                r.status === "pending" ||
                r.status === "accepted" ||
                r.status === "rejected"
            ) {
                statusById.set(r.id, r.status);
            }
        }
    }

    // Version-number patch — old stored events don't carry `version_number`
    // because they predate the schema change. Look it up from
    // document_versions so the UI can render "V3" chips + download filenames.
    const versionNumberById = new Map<string, number | null>();
    if (versionIds.size > 0) {
        const { data: vrows } = await db
            .from("document_versions")
            .select("id, version_number")
            .in("id", Array.from(versionIds));
        for (const r of (vrows ?? []) as {
            id: string;
            version_number: number | null;
        }[]) {
            versionNumberById.set(r.id, r.version_number ?? null);
        }
    }

    const patchAnnList = (list: unknown): unknown => {
        if (!Array.isArray(list)) return list;
        return (list as Record<string, unknown>[]).map((a) => {
            let next = a;
            if (typeof a?.edit_id === "string" && statusById.has(a.edit_id)) {
                next = { ...next, status: statusById.get(a.edit_id) };
            }
            if (
                typeof a?.version_id === "string" &&
                versionNumberById.has(a.version_id)
            ) {
                next = {
                    ...next,
                    version_number: versionNumberById.get(a.version_id) ?? null,
                };
            }
            return next;
        });
    };
    return messages.map((m) => {
        const next: Record<string, unknown> = { ...m };
        next.annotations = patchAnnList(m.annotations);
        if (Array.isArray(m.content)) {
            next.content = (m.content as Record<string, unknown>[]).map(
                (ev) => {
                    if (ev?.type !== "doc_edited") return ev;
                    let patched: Record<string, unknown> = {
                        ...ev,
                        annotations: patchAnnList(ev.annotations),
                    };
                    if (
                        typeof ev.version_id === "string" &&
                        versionNumberById.has(ev.version_id)
                    ) {
                        patched = {
                            ...patched,
                            version_number:
                                versionNumberById.get(ev.version_id) ?? null,
                        };
                    }
                    return patched;
                },
            );
        }
        return next;
    });
}

// GET /chat/:chatId/messages — read conversation history from S3 snapshot
chatRouter.get("/:chatId/messages", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { chatId } = req.params;
    const db = createServerSupabase();

    // Look up the S3 session ID stored on the chat row.
    const { data: chat, error } = await db
        .from("chats")
        .select("agentcore_session_id, user_id")
        .eq("id", chatId)
        .single();

    if (error || !chat)
        return void res.status(404).json({ detail: "Chat not found" });
    if (chat.user_id !== userId)
        return void res.status(404).json({ detail: "Chat not found" });

    const sessionId = chat.agentcore_session_id as string | null;
    if (!sessionId) return void res.json({ messages: [] });

    const bucket = process.env.SESSIONS_BUCKET_NAME;
    if (!bucket)
        return void res.status(500).json({ detail: "Sessions bucket not configured" });

    try {
        const s3 = getSessionS3();

        // List objects under sessions/{sessionId}/scopes/agent/ to find the agentId.
        const prefix = `sessions/${sessionId}/scopes/agent/`;
        const listCmd = new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            MaxKeys: 10,
        });
        const listResult = await s3.send(listCmd);
        const keys = (listResult.Contents ?? []).map((o) => o.Key ?? "");

        // Extract the first path segment after "agent/" as the agentId.
        let agentId: string | undefined;
        for (const key of keys) {
            const rest = key.slice(prefix.length);
            const segment = rest.split("/")[0];
            if (segment) {
                agentId = segment;
                break;
            }
        }

        if (!agentId) return void res.json({ messages: [] });

        const snapshotKey = `sessions/${sessionId}/scopes/agent/${agentId}/snapshots/snapshot_latest.json`;
        const getCmd = new GetObjectCommand({ Bucket: bucket, Key: snapshotKey });

        let snapshotBody: string;
        try {
            const getResult = await s3.send(getCmd);
            const chunks: Uint8Array[] = [];
            for await (const chunk of getResult.Body as AsyncIterable<Uint8Array>) {
                chunks.push(chunk);
            }
            snapshotBody = Buffer.concat(chunks).toString("utf-8");
        } catch (err: unknown) {
            const code = (err as { name?: string }).name;
            if (code === "NoSuchKey" || code === "NoSuchBucket") {
                return void res.json({ messages: [] });
            }
            throw err;
        }

        const snapshot = JSON.parse(snapshotBody) as {
            data?: { messages?: SnapshotMessage[] };
        };
        const rawMessages = snapshot.data?.messages ?? [];
        const messages = snapshotMessagesToMikeMessages(rawMessages);

        res.json({ messages });
    } catch (err) {
        console.error("[chat/messages] error:", err);
        res.status(500).json({ detail: "Failed to read session snapshot" });
    }
});

// GET /chat/:chatId/session-id
chatRouter.get("/:chatId/session-id", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { chatId } = req.params;
    const db = createServerSupabase();
    const { data: chat, error } = await db
        .from("chats")
        .select("agentcore_session_id, user_id")
        .eq("id", chatId)
        .single();
    if (error || !chat || chat.user_id !== userId)
        return void res.status(404).json({ detail: "Chat not found" });
    res.json({ agentcore_session_id: chat.agentcore_session_id ?? null });
});

// PATCH /chat/:chatId
chatRouter.patch("/:chatId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { chatId } = req.params;
    const title = (req.body.title ?? "").trim();
    if (!title)
        return void res.status(400).json({ detail: "title is required" });

    const db = createServerSupabase();
    const { data, error } = await db
        .from("chats")
        .update({ title })
        .eq("id", chatId)
        .eq("user_id", userId)
        .select("id, title")
        .single();

    if (error || !data)
        return void res.status(404).json({ detail: "Chat not found" });
    res.json(data);
});

// DELETE /chat/:chatId
chatRouter.delete("/:chatId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { chatId } = req.params;
    const db = createServerSupabase();
    const { error } = await db
        .from("chats")
        .delete()
        .eq("id", chatId)
        .eq("user_id", userId);

    if (error) return void res.status(500).json({ detail: error.message });
    res.status(204).send();
});

// POST /chat/:chatId/generate-title
chatRouter.post("/:chatId/generate-title", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;
    const message: string = (req.body.message ?? "").trim();
    if (!message)
        return void res.status(400).json({ detail: "message is required" });

    const db = createServerSupabase();
    const { data: chat, error } = await db
        .from("chats")
        .select("id, user_id, project_id")
        .eq("id", chatId)
        .single();

    if (error || !chat)
        return void res.status(404).json({ detail: "Chat not found" });
    let canTitle = chat.user_id === userId;
    if (!canTitle && chat.project_id) {
        const access = await checkProjectAccess(
            chat.project_id,
            userId,
            userEmail,
            db,
        );
        canTitle = access.ok;
    }
    if (!canTitle)
        return void res.status(404).json({ detail: "Chat not found" });

    try {
        const { title_model, api_keys } = await getUserModelSettings(
            userId,
            db,
        );
        const titleText = await completeText({
            model: title_model,
            user: `Generate a concise title (3–6 words) for a chat in an AI Legal Platform that starts with this message. The title should describe the topic or document — do NOT include words like "Legal Assistant", "AI", "Chat", or any similar prefix. Return only the title, no quotes or punctuation.\n\nMessage: ${message.slice(0, 500)}`,
            maxTokens: 64,
        });
        const title = titleText.trim() || message.slice(0, 60);

        await db
            .from("chats")
            .update({ title })
            .eq("id", chatId)
            .eq("user_id", userId);

        res.json({ title });
    } catch (err) {
        console.error("[generate-title]", err);
        res.status(500).json({ detail: "Failed to generate title" });
    }
});

// POST /chat — streaming
chatRouter.post("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { messages, chat_id, project_id, model } = req.body as {
        messages: ChatMessage[];
        chat_id?: string;
        project_id?: string;
        model?: string;
    };

    console.log("[chat/stream] incoming request", {
        userId,
        chat_id,
        project_id,
        model,
        messageCount: messages?.length,
    });

    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    let chatId = chat_id ?? null;
    let chatTitle: string | null = null;

    if (chatId) {
        // Either chat owner OR a member of the chat's project can post.
        const { data: existing } = await db
            .from("chats")
            .select("id, title, user_id, project_id")
            .eq("id", chatId)
            .single();
        let canUse = !!existing && existing.user_id === userId;
        if (!canUse && existing?.project_id) {
            const access = await checkProjectAccess(
                existing.project_id,
                userId,
                userEmail,
                db,
            );
            canUse = access.ok;
        }
        if (!canUse || !existing) chatId = null;
        else chatTitle = existing.title;
    }

    if (!chatId) {
        // If creating a chat tied to a project, the user must have access
        // to the project (own or shared).
        if (project_id) {
            const access = await checkProjectAccess(
                project_id,
                userId,
                userEmail,
                db,
            );
            if (!access.ok)
                return void res
                    .status(404)
                    .json({ detail: "Project not found" });
        }
        const { data: newChat, error } = await db
            .from("chats")
            .insert({ user_id: userId, project_id: project_id ?? null })
            .select("id, title")
            .single();
        if (error || !newChat) {
            console.error("[chat/stream] failed to create chat", error);
            return void res
                .status(500)
                .json({ detail: "Failed to create chat" });
        }
        chatId = newChat.id as string;
        chatTitle = newChat.title;
    }

    console.log("[chat/stream] resolved chatId", chatId);

    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (lastUser) {
        await db.from("chat_messages").insert({
            chat_id: chatId,
            role: "user",
            content: lastUser.content,
            files: lastUser.files ?? null,
            workflow: lastUser.workflow ?? null,
        });
    }

    const { docIndex, docStore } = await buildDocContext(
        messages,
        userId,
        db,
        chatId,
    );
    const docAvailability = Object.entries(docIndex).map(([doc_id, info]) => ({
        doc_id,
        filename: info.filename,
    }));
    const enrichedMessages = await enrichWithPriorEvents(
        messages,
        chatId,
        db,
        docIndex,
    );
    const apiMessages = buildMessages(enrichedMessages, docAvailability);

    const workflowStore = await buildWorkflowStore(userId, userEmail, db);

    console.log("[chat/stream] starting LLM stream", {
        apiMessageCount: apiMessages.length,
        docCount: Object.keys(docIndex).length,
        workflowCount: Object.keys(workflowStore).length,
    });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const write = (line: string) => res.write(line);

    const apiKeys = await getUserApiKeys(userId, db);

    try {
        write(`data: ${JSON.stringify({ type: "chat_id", chatId })}\n\n`);

        const { fullText, events } = await runLLMStream({
            apiMessages,
            docStore,
            docIndex,
            userId,
            db,
            write,
            workflowStore,
            model,
            apiKeys,
            projectId: project_id ?? null,
        });

        console.log("[chat/stream] LLM stream finished", {
            fullTextLen: fullText?.length ?? 0,
            eventCount: events?.length ?? 0,
        });

        const annotations = extractAnnotations(fullText, docIndex, events);
        await db.from("chat_messages").insert({
            chat_id: chatId,
            role: "assistant",
            content: events.length ? events : null,
            annotations: annotations.length ? annotations : null,
        });

        if (!chatTitle && lastUser?.content) {
            await db
                .from("chats")
                .update({ title: lastUser.content.slice(0, 120) })
                .eq("id", chatId);
        }
    } catch (err) {
        console.error("[chat/stream] error:", err);
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
