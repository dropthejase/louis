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
    DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import type { SqlParameter } from "@aws-sdk/client-rds-data";
import {
    getSessionS3,
    conversationKey,
    readSessionMessages,
    snapshotMessagesToSessionMessages,
} from "../lib/sessions";

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
    try {
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
    } catch (err) {
        console.error("[chat] GET / error:", err);
        res.status(500).json({ detail: "Failed to fetch chats" });
    }
});

// POST /chat/create
chatRouter.post("/create", requireAuth, async (req, res) => {
    try {
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
    } catch (err) {
        console.error("[chat] POST /create error:", err);
        res.status(500).json({ detail: "Internal server error" });
    }
});

// GET /chat/:chatId
chatRouter.get("/:chatId", requireAuth, async (req, res) => {
    try {
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

        res.json({ chat });
    } catch (err) {
        console.error("[chat] GET /:chatId error:", err);
        res.status(500).json({ detail: "Internal server error" });
    }
});

// Stored message annotations/events capture the `status` at the time the
// assistant produced the edit (always "pending"). If the user later accepts

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

    try {
        const rawMessages = await readSessionMessages(chatId);
        const messages = snapshotMessagesToSessionMessages(rawMessages) as MikeMessage[];
        res.json({ messages });
    } catch (err) {
        console.error("[chat/messages] error:", err);
        res.status(500).json({ detail: "Failed to read session snapshot" });
    }
});

// PUT /chat/:chatId/session-id — persist AgentCore session ID on first turn.
// No-ops if the chat already has a session ID (never overwrites an existing session).
chatRouter.put("/:chatId/session-id", requireAuth, async (req, res) => {
  try {
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
  } catch (err) {
    console.error("[chat] PUT /:chatId/session-id error:", err);
    res.status(500).json({ detail: "Internal server error" });
  }
});

// GET /chat/:chatId/session-id
chatRouter.get("/:chatId/session-id", requireAuth, async (req, res) => {
  try {
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
  } catch (err) {
    console.error("[chat] GET /:chatId/session-id error:", err);
    res.status(500).json({ detail: "Internal server error" });
  }
});

// PATCH /chat/:chatId
chatRouter.patch("/:chatId", requireAuth, async (req, res) => {
  try {
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
  } catch (err) {
    console.error("[chat] PATCH /:chatId error:", err);
    res.status(500).json({ detail: "Internal server error" });
  }
});

// DELETE /chat/:chatId
chatRouter.delete("/:chatId", requireAuth, async (req, res) => {
  try {
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
  } catch (err) {
    console.error("[chat] DELETE /:chatId error:", err);
    res.status(500).json({ detail: "Internal server error" });
  }
});

// POST /chat/:chatId/generate-title
chatRouter.post("/:chatId/generate-title", requireAuth, async (req, res) => {
  try {
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
  } catch (err) {
    console.error("[chat] POST /:chatId/generate-title error:", err);
    if (!res.headersSent) res.status(500).json({ detail: "Internal server error" });
  }
});

