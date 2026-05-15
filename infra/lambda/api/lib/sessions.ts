/**
 * Shared S3 session utilities for agent conversation history.
 *
 * Both louisMain (chat.ts) and louisTabular (tabular.ts) store conversation
 * snapshots at conversations/{chatId}/messages.json in the sessions bucket.
 * This module provides the S3 client, key helper, snapshot types, and the
 * snapshot-to-display-message converter used by both routes.
 */
import {
    S3Client,
    GetObjectCommand,
    PutObjectCommand,
} from "@aws-sdk/client-s3";

let _s3: S3Client | undefined;
export function getSessionS3(): S3Client {
    if (!_s3) _s3 = new S3Client({ region: process.env.AWS_REGION ?? "eu-west-1" });
    return _s3;
}

export function conversationKey(chatId: string): string {
    return `conversations/${chatId}/messages.json`;
}

export async function readSessionMessages(chatId: string): Promise<SnapshotMessage[]> {
    const bucket = process.env.SESSIONS_BUCKET_NAME;
    if (!bucket) return [];
    try {
        const result = await getSessionS3().send(new GetObjectCommand({
            Bucket: bucket,
            Key: conversationKey(chatId),
        }));
        const body = await result.Body?.transformToString();
        if (!body) return [];
        return JSON.parse(body) as SnapshotMessage[];
    } catch {
        return [];
    }
}

export async function writeSessionMessages(chatId: string, messages: SnapshotMessage[]): Promise<void> {
    const bucket = process.env.SESSIONS_BUCKET_NAME;
    if (!bucket) return;
    await getSessionS3().send(new PutObjectCommand({
        Bucket: bucket,
        Key: conversationKey(chatId),
        Body: JSON.stringify(messages),
        ContentType: "application/json",
    }));
}

// ---------------------------------------------------------------------------
// Strands snapshot types
// ---------------------------------------------------------------------------

export interface SnapshotContentBlock {
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

export interface SnapshotMessage {
    role: "user" | "assistant";
    content: SnapshotContentBlock[];
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type AssistantEventType =
    | { type: "content"; text: string }
    | { type: "reasoning"; text: string }
    | { type: "doc_read"; filename: string; document_id?: string }
    | { type: "doc_find"; filename: string; query: string; total_matches: number }
    | { type: "doc_created"; filename: string; download_url: string; document_id?: string; version_id?: string }
    | { type: "doc_edited"; filename: string; document_id: string; version_id: string; download_url: string; annotations: unknown[] }
    | { type: "doc_replicated"; filename: string; count: number; copies?: unknown[] };

export interface SessionCitationAnnotation {
    type: "citation_data";
    ref: number;
    doc_id: string;
    document_id: string;
    filename: string;
    page: number | string;
    quote: string;
}

export interface SessionMessage {
    role: "user" | "assistant";
    content: string;
    annotations?: SessionCitationAnnotation[];
    events?: AssistantEventType[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function stripCitationsTag(text: string): string {
    return text.replace(/<CITATIONS>[\s\S]*?<\/CITATIONS>/g, "").trim();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractCitationsFromText(text: string): SessionCitationAnnotation[] {
    const match = text.match(/<CITATIONS>([\s\S]*?)<\/CITATIONS>/);
    if (!match) return [];
    try {
        const parsed = JSON.parse(match[1]) as unknown;
        if (!Array.isArray(parsed)) return [];
        return (parsed as Record<string, unknown>[]).filter((c) => {
            const valid =
                typeof c.ref === "number" &&
                typeof c.document_id === "string" &&
                UUID_RE.test(c.document_id) &&
                (typeof c.page === "number" || typeof c.page === "string") &&
                typeof c.quote === "string" &&
                c.quote.length > 0;
            if (!valid) console.warn("[sessions] dropping malformed citation on history load", c);
            return valid;
        }) as unknown as SessionCitationAnnotation[];
    } catch {
        return [];
    }
}

/**
 * Convert raw Strands snapshot messages into the display-ready SessionMessage shape.
 * Tool names in the switch are louisMain-specific; unknown tools are silently skipped.
 */
export function snapshotMessagesToSessionMessages(
    messages: SnapshotMessage[],
): SessionMessage[] {
    const result: SessionMessage[] = [];

    // Build map of tool_use_id -> tool result content.
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
            const textBlocks = msg.content.filter(
                (b) => !b.toolResult && !b.toolUse &&
                    (!b.type || b.type === "text" || b.type === "textBlock") && typeof b.text === "string",
            );
            if (textBlocks.length === 0) continue;
            const content = textBlocks.map((b) => b.text ?? "").join("\n").trim();
            if (!content) continue;
            result.push({ role: "user", content });
        } else {
            const textBlocks = msg.content.filter(
                (b) => !b.toolUse && !b.toolResult && !b.reasoning &&
                    (!b.type || b.type === "text" || b.type === "textBlock") && typeof b.text === "string",
            );
            const toolUseBlocks = msg.content.filter(
                (b) => !!b.toolUse || b.type === "tool_use" || b.type === "toolUse",
            );
            const reasoningBlocks = msg.content.filter((b) => !!b.reasoning);

            const fullText = textBlocks.map((b) => b.text ?? "").join("\n");
            const content = stripCitationsTag(fullText);
            const annotations = extractCitationsFromText(fullText);
            const events: AssistantEventType[] = [];

            for (const rb of reasoningBlocks) {
                if (rb.reasoning?.text) {
                    events.push({ type: "reasoning", text: rb.reasoning.text });
                }
            }
            if (content) {
                events.push({ type: "content", text: content });
            }

            for (const toolUse of toolUseBlocks) {
                const toolName = (toolUse.toolUse?.name ?? toolUse.name) ?? "";
                const toolId = (toolUse.toolUse?.toolUseId ?? toolUse.id) ?? "";
                const resultRaw = toolResults.get(toolId);
                let resultObj: Record<string, unknown> = {};
                try {
                    if (typeof resultRaw === "string") {
                        resultObj = JSON.parse(resultRaw) as Record<string, unknown>;
                    } else if (Array.isArray(resultRaw)) {
                        const textEntry = (resultRaw as { type: string; text?: string }[])
                            .find((e) => (e.type === "text" || e.type === "textBlock") && e.text);
                        if (textEntry?.text) {
                            resultObj = JSON.parse(textEntry.text) as Record<string, unknown>;
                        }
                    }
                } catch { /* ignore */ }

                let rawResultText = "";
                if (Array.isArray(resultRaw)) {
                    const textEntry = (resultRaw as { type?: string; text?: string }[]).find((e) => e.text);
                    rawResultText = textEntry?.text ?? "";
                }
                const metaFilename = rawResultText.match(/^filename:\s*(.+)$/m)?.[1]?.trim() ?? "";

                switch (toolName) {
                    case "read_document":
                        events.push({ type: "doc_read", filename: (resultObj.filename as string) || metaFilename });
                        break;
                    case "find_in_document":
                        events.push({
                            type: "doc_find",
                            filename: (resultObj.filename as string) ?? "",
                            query: (resultObj.query as string) ?? "",
                            total_matches: (resultObj.total_matches as number) ?? 0,
                        });
                        break;
                    case "generate_docx":
                        events.push({
                            type: "doc_created",
                            filename: (resultObj.filename as string) ?? "",
                            download_url: (resultObj.download_url as string) ?? "",
                            document_id: (resultObj.document_id as string) ?? undefined,
                            version_id: (resultObj.version_id as string) ?? undefined,
                        });
                        break;
                    case "edit_document":
                        events.push({
                            type: "doc_edited",
                            filename: (resultObj.filename as string) ?? "",
                            document_id: (resultObj.document_id as string) ?? "",
                            version_id: (resultObj.version_id as string) ?? "",
                            download_url: (resultObj.download_url as string) ?? "",
                            annotations: Array.isArray(resultObj.annotations) ? resultObj.annotations : [],
                        });
                        break;
                    case "replicate_document":
                        events.push({
                            type: "doc_replicated",
                            filename: (resultObj.filename as string) ?? "",
                            count: (resultObj.count as number) ?? 0,
                            copies: Array.isArray(resultObj.copies) ? resultObj.copies : undefined,
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
