/**
 * Chat session routes — CRUD for chat records and AgentCore session management.
 *
 * Chats are the top-level container for a user's conversation with the agent.
 * This router handles listing, creating, deleting, and renaming chats, as well
 * as reading AgentCore session history from S3 snapshots and persisting the
 * AgentCore session ID for multi-turn continuity. The `/messages` endpoint
 * reads raw Strands snapshot JSON from S3 and converts it to the client-facing
 * `MikeMessage[]` shape.
 */
import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { query, queryOne, execute } from "../lib/db";
import { completeText } from "../lib/llm";
import { getUserModelSettings } from "../lib/userSettings";
import { checkProjectAccess } from "../lib/access";
import {
    S3Client,
    ListObjectsV2Command,
    GetObjectCommand,
    DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import type { SqlParameter } from "@aws-sdk/client-rds-data";

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
    // Flat Bedrock Converse format (type field present)
    type?: string;
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
    tool_use_id?: string;
    content?: unknown;
    // Nested Strands SDK snapshot format (no type field, nested objects)
    toolUse?: { name: string; toolUseId: string; input?: unknown };
    toolResult?: { toolUseId: string; status?: string; content?: unknown };
    reasoning?: { text: string; signature?: string };
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
    | { type: "reasoning"; text: string }
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractCitationsFromText(
    text: string,
): MikeCitationAnnotation[] {
    const match = text.match(/<CITATIONS>([\s\S]*?)<\/CITATIONS>/);
    if (!match) return [];
    try {
        const parsed = JSON.parse(match[1]) as unknown;
        if (!Array.isArray(parsed)) return [];
        return (parsed as Record<string, unknown>[]).filter((c) => {
            const valid =
                typeof c.ref === 'number' &&
                typeof c.document_id === 'string' &&
                UUID_RE.test(c.document_id) &&
                (typeof c.page === 'number' || typeof c.page === 'string') &&
                typeof c.quote === 'string' &&
                c.quote.length > 0;
            if (!valid) console.warn('[chat] dropping malformed citation on history load', c);
            return valid;
        }) as unknown as MikeCitationAnnotation[];
    } catch {
        return [];
    }
}

// Convert Strands snapshot messages into MikeMessage[].
function snapshotMessagesToMikeMessages(
    messages: SnapshotMessage[],
): MikeMessage[] {
    const result: MikeMessage[] = [];

    // Build a map of tool_use_id -> tool result content for lookup.
    // Handles both flat Bedrock format ({ type: "tool_result", tool_use_id })
    // and nested Strands snapshot format ({ toolResult: { toolUseId, content } }).
    const toolResults = new Map<string, unknown>();
    for (const msg of messages) {
        if (msg.role === "user") {
            for (const block of msg.content) {
                if (block.toolResult && typeof block.toolResult.toolUseId === "string") {
                    toolResults.set(block.toolResult.toolUseId, block.toolResult.content);
                } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
                    toolResults.set(block.tool_use_id, block.content);
                }
            }
        }
    }

    for (const msg of messages) {
        if (msg.role === "user") {
            // Only include user text blocks (skip tool_result/toolResult blocks).
            // Strands SDK uses type "textBlock"; Bedrock Converse uses "text"; snapshot may omit type entirely — accept all.
            // Exclude nested-format toolResult blocks which have no type but are not text.
            const textBlocks = msg.content.filter(
                (b) => !b.toolResult && !b.toolUse &&
                    (!b.type || b.type === "text" || b.type === "textBlock") && typeof b.text === "string",
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
            // Strands SDK uses type "textBlock"; Bedrock Converse uses "text"; snapshot may omit type entirely — accept all.
            // Exclude nested-format blocks (toolUse/toolResult/reasoning) which have no type but are not text.
            const textBlocks = msg.content.filter(
                (b) => !b.toolUse && !b.toolResult && !b.reasoning &&
                    (!b.type || b.type === "text" || b.type === "textBlock") && typeof b.text === "string",
            );
            // Handles nested Strands format ({ toolUse: {...} }) and flat Bedrock format ({ type: "tool_use"|"toolUse" })
            const toolUseBlocks = msg.content.filter(
                (b) => !!b.toolUse || b.type === "tool_use" || b.type === "toolUse",
            );
            // Reasoning blocks: nested Strands format ({ reasoning: { text, signature } })
            const reasoningBlocks = msg.content.filter((b) => !!b.reasoning);

            const fullText = textBlocks.map((b) => b.text ?? "").join("\n");
            const content = stripCitationsTag(fullText);
            const annotations = extractCitationsFromText(fullText);

            const events: MikeAssistantEvent[] = [];

            for (const rb of reasoningBlocks) {
                if (rb.reasoning?.text) {
                    events.push({ type: "reasoning", text: rb.reasoning.text });
                }
            }

            if (content) {
                events.push({ type: "content", text: content });
            }

            for (const toolUse of toolUseBlocks) {
                // Support both nested ({ toolUse: { name, toolUseId } }) and flat ({ name, id }) formats
                const toolName = (toolUse.toolUse?.name ?? toolUse.name) ?? "";
                const toolId = (toolUse.toolUse?.toolUseId ?? toolUse.id) ?? "";
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
                        ).find((e) => (e.type === "text" || e.type === "textBlock") && e.text);
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

                // For read_document, result is raw doc text (not JSON) — extract filename from metadata block.
                let rawResultText = "";
                if (Array.isArray(resultRaw)) {
                    const textEntry = (resultRaw as { type?: string; text?: string }[])
                        .find((e) => e.text);
                    rawResultText = textEntry?.text ?? "";
                }
                const metaFilenameMatch = rawResultText.match(/^filename:\s*(.+)$/m);
                const metaFilename = metaFilenameMatch?.[1]?.trim() ?? "";

                switch (toolName) {
                    case "read_document":
                        events.push({
                            type: "doc_read",
                            filename: (resultObj.filename as string) || metaFilename,
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

interface ChatRow {
    id: string;
    user_id: string;
    project_id: string | null;
    title: string | null;
    agentcore_session_id: string | null;
    agentcore_session_created_at: string | null;
    created_at: string;
}

// GET /chat
// Visible chats = the user's own chats + every chat under a project the
// user owns (so a project owner sees all collaborator chats in their
// own projects in the global recent-chats list). Chats in projects that
// are merely *shared with* the user are NOT included here — those are
// listed per-project via GET /projects/:projectId/chats.
chatRouter.get("/", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;

    const ownProjects = await query<{ id: string }>(
        `SELECT id FROM projects WHERE user_id = :userId`,
        [{ name: "userId", value: { stringValue: userId } }],
    );
    const ownProjectIds = ownProjects.map((p) => p.id);

    let chats: ChatRow[];
    if (ownProjectIds.length > 0) {
        const placeholders = ownProjectIds.map((_, i) => `:pid${i}::uuid`).join(", ");
        const params: SqlParameter[] = [
            { name: "userId", value: { stringValue: userId } },
            ...ownProjectIds.map((id, i) => ({
                name: `pid${i}`,
                value: { stringValue: id },
            })),
        ];
        chats = await query<ChatRow>(
            `SELECT * FROM chats
             WHERE user_id = :userId OR project_id IN (${placeholders})
             ORDER BY created_at DESC`,
            params,
        );
    } else {
        chats = await query<ChatRow>(
            `SELECT * FROM chats WHERE user_id = :userId ORDER BY created_at DESC`,
            [{ name: "userId", value: { stringValue: userId } }],
        );
    }
    res.json(chats);
});

// POST /chat/create
chatRouter.post("/create", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const projectId: string | null = req.body.project_id ?? null;
    const data = await queryOne<{ id: string }>(
        `INSERT INTO chats (user_id, project_id) VALUES (:userId, :projectId) RETURNING id`,
        [
            { name: "userId", value: { stringValue: userId } },
            {
                name: "projectId",
                value: projectId != null ? { stringValue: projectId } : { isNull: true },
            },
        ],
    );
    if (!data)
        return void res.status(500).json({ detail: "Failed to create chat" });
    res.json({ id: data.id });
});

// GET /chat/:chatId
chatRouter.get("/:chatId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { chatId } = req.params;

    const chat = await queryOne<ChatRow>(
        `SELECT * FROM chats WHERE id = :id`,
        [{ name: "id", value: { stringValue: chatId } }],
    );
    if (!chat)
        return void res.status(404).json({ detail: "Chat not found" });
    // Owner of the chat OR a member of the chat's project can view it.
    let canView = chat.user_id === userId;
    if (!canView && chat.project_id) {
        const access = await checkProjectAccess(
            chat.project_id,
            userId,
            userEmail,
        );
        canView = access.ok;
    }
    if (!canView)
        return void res.status(404).json({ detail: "Chat not found" });

    const messages = await query<Record<string, unknown>>(
        `SELECT * FROM chat_messages WHERE chat_id = :chatId ORDER BY created_at ASC`,
        [{ name: "chatId", value: { stringValue: chatId } }],
    );

    const hydrated = await hydrateEditStatuses(messages);
    res.json({ chat, messages: hydrated });
});

// Stored message annotations/events capture the `status` at the time the
// assistant produced the edit (always "pending"). If the user later accepts
// or rejects, `document_edits.status` is updated but the stored message
// annotation is not. On chat load we merge the current DB status in so
// EditCards render with the real state.
async function hydrateEditStatuses(
    messages: Record<string, unknown>[],
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
        const idArr = Array.from(editIds);
        const placeholders = idArr.map((_, i) => `:eid${i}::uuid`).join(", ");
        const rows = await query<{ id: string; status: string }>(
            `SELECT id, status FROM document_edits WHERE id IN (${placeholders})`,
            idArr.map((id, i) => ({
                name: `eid${i}`,
                value: { stringValue: id },
            })),
        );
        for (const r of rows) {
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
        const idArr = Array.from(versionIds);
        const placeholders = idArr.map((_, i) => `:vid${i}::uuid`).join(", ");
        const vrows = await query<{
            id: string;
            version_number: number | null;
        }>(
            `SELECT id, version_number FROM document_versions WHERE id IN (${placeholders})`,
            idArr.map((id, i) => ({
                name: `vid${i}`,
                value: { stringValue: id },
            })),
        );
        for (const r of vrows) {
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

// GET /chat/:chatId/messages — read conversation history from S3
chatRouter.get("/:chatId/messages", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { chatId } = req.params;

    const chat = await queryOne<{ user_id: string }>(
        `SELECT user_id FROM chats WHERE id = :id`,
        [{ name: "id", value: { stringValue: chatId } }],
    );

    if (!chat)
        return void res.status(404).json({ detail: "Chat not found" });
    if (chat.user_id !== userId)
        return void res.status(404).json({ detail: "Chat not found" });

    const bucket = process.env.SESSIONS_BUCKET_NAME;
    if (!bucket)
        return void res.status(500).json({ detail: "Sessions bucket not configured" });

    try {
        const s3 = getSessionS3();
        const conversationKey = `conversations/${chatId}/messages.json`;

        let rawMessages: SnapshotMessage[] = [];
        try {
            const getResult = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: conversationKey }));
            const chunks: Uint8Array[] = [];
            for await (const chunk of getResult.Body as AsyncIterable<Uint8Array>) {
                chunks.push(chunk);
            }
            rawMessages = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as SnapshotMessage[];
        } catch (err: unknown) {
            const code = (err as { name?: string }).name;
            if (code === "NoSuchKey" || code === "NoSuchBucket") {
                return void res.json({ messages: [] });
            }
            throw err;
        }

        const messages = snapshotMessagesToMikeMessages(rawMessages);
        res.json({ messages });
    } catch (err) {
        console.error("[chat/messages] error:", err);
        res.status(500).json({ detail: "Failed to read session snapshot" });
    }
});

// PUT /chat/:chatId/session-id — persist AgentCore session ID on first turn.
// No-ops if the chat already has a session ID (never overwrites an existing session).
chatRouter.put("/:chatId/session-id", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { chatId } = req.params;
    const sessionId: string = (req.body.agentcore_session_id ?? "").trim();
    if (!sessionId)
        return void res.status(400).json({ detail: "agentcore_session_id is required" });

    const chat = await queryOne<{
        user_id: string;
        agentcore_session_id: string | null;
    }>(
        `SELECT user_id, agentcore_session_id FROM chats WHERE id = :id`,
        [{ name: "id", value: { stringValue: chatId } }],
    );
    if (!chat || chat.user_id !== userId)
        return void res.status(404).json({ detail: "Chat not found" });

    // Never overwrite an existing session — return existing one silently.
    if (chat.agentcore_session_id) {
        return void res.json({ agentcore_session_id: chat.agentcore_session_id });
    }

    await execute(
        `UPDATE chats
         SET agentcore_session_id = :sessionId,
             agentcore_session_created_at = NOW()
         WHERE id = :id`,
        [
            { name: "sessionId", value: { stringValue: sessionId } },
            { name: "id", value: { stringValue: chatId } },
        ],
    );

    res.json({ agentcore_session_id: sessionId });
});

// GET /chat/:chatId/session-id
chatRouter.get("/:chatId/session-id", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { chatId } = req.params;
    const chat = await queryOne<{
        agentcore_session_id: string | null;
        user_id: string;
    }>(
        `SELECT agentcore_session_id, user_id FROM chats WHERE id = :id`,
        [{ name: "id", value: { stringValue: chatId } }],
    );
    if (!chat || chat.user_id !== userId)
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

    const data = await queryOne<{ id: string; title: string }>(
        `UPDATE chats SET title = :title
         WHERE id = :id AND user_id = :userId
         RETURNING id, title`,
        [
            { name: "title", value: { stringValue: title } },
            { name: "id", value: { stringValue: chatId } },
            { name: "userId", value: { stringValue: userId } },
        ],
    );

    if (!data)
        return void res.status(404).json({ detail: "Chat not found" });
    res.json(data);
});

// DELETE /chat/:chatId
chatRouter.delete("/:chatId", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const { chatId } = req.params;

    // Fetch agentcore_session_id before deleting so we can clean up S3.
    const chat = await queryOne<{ agentcore_session_id: string | null; user_id: string }>(
        `SELECT agentcore_session_id, user_id FROM chats WHERE id = :id`,
        [{ name: "id", value: { stringValue: chatId } }],
    );
    if (!chat || chat.user_id !== userId) {
        return void res.status(204).send();
    }

    await execute(
        `DELETE FROM chats WHERE id = :id AND user_id = :userId`,
        [
            { name: "id", value: { stringValue: chatId } },
            { name: "userId", value: { stringValue: userId } },
        ],
    );

    // Best-effort S3 session cleanup — don't fail the delete if S3 errors.
    const sessionId = chat.agentcore_session_id;
    const bucket = process.env.SESSIONS_BUCKET_NAME;
    if (sessionId && bucket) {
        try {
            const s3 = getSessionS3();
            const prefix = `sessions/${sessionId}/`;
            let continuationToken: string | undefined;
            do {
                const list = await s3.send(new ListObjectsV2Command({
                    Bucket: bucket,
                    Prefix: prefix,
                    MaxKeys: 1000,
                    ContinuationToken: continuationToken,
                }));
                const objects = (list.Contents ?? []).map((o) => ({ Key: o.Key! }));
                if (objects.length > 0) {
                    await s3.send(new DeleteObjectsCommand({
                        Bucket: bucket,
                        Delete: { Objects: objects, Quiet: true },
                    }));
                }
                continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
            } while (continuationToken);
        } catch (err) {
            console.error('[chat/delete] S3 session cleanup failed:', err);
        }
    }

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

    const chat = await queryOne<{
        id: string;
        user_id: string;
        project_id: string | null;
    }>(
        `SELECT id, user_id, project_id FROM chats WHERE id = :id`,
        [{ name: "id", value: { stringValue: chatId } }],
    );

    if (!chat)
        return void res.status(404).json({ detail: "Chat not found" });
    let canTitle = chat.user_id === userId;
    if (!canTitle && chat.project_id) {
        const access = await checkProjectAccess(
            chat.project_id,
            userId,
            userEmail,
        );
        canTitle = access.ok;
    }
    if (!canTitle)
        return void res.status(404).json({ detail: "Chat not found" });

    try {
        const { title_model } = await getUserModelSettings();
        const titleText = await completeText({
            model: title_model,
            user: `Generate a concise title (3–6 words) for a chat in an AI Legal Platform that starts with this message. The title should describe the topic or document — do NOT include words like "Legal Assistant", "AI", "Chat", or any similar prefix. If the message is too short or unclear to generate a meaningful title, return exactly: "New Chat". Return only the title, no quotes or punctuation.\n\nMessage: ${message.slice(0, 500)}`,
            maxTokens: 64,
        });
        const raw = titleText.trim();
        const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
        // Reject long responses (LLM ignored constraint) or explicit fallback signal
        const title = raw && raw.length <= 80 && raw !== 'New Chat' ? raw : `Chat — ${today}`;

        await execute(
            `UPDATE chats SET title = :title
             WHERE id = :id AND user_id = :userId`,
            [
                { name: "title", value: { stringValue: title } },
                { name: "id", value: { stringValue: chatId } },
                { name: "userId", value: { stringValue: userId } },
            ],
        );

        res.json({ title });
    } catch (err) {
        console.error("[generate-title]", err);
        res.status(500).json({ detail: "Failed to generate title" });
    }
});

