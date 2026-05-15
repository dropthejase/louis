/**
 * AgentCore Runtime HTTP server — entry point for the agent container.
 *
 * Exposes two endpoints: GET /ping (health check for AgentCore) and
 * POST /invocations (streaming agent turns over SSE). The /invocations handler
 * extracts userId from the JWT `sub` claim in the Authorization header — it
 * never trusts userId from the request body. Session continuity is maintained
 * by storing the AgentCore session ID in the chats table after the first turn.
 *
 * JWT auth is enforced by the AgentCore inbound authorizer (requestHeaderAllowlist)
 * before the request reaches this container.
 */
import express from 'express';
import { buildDocContext, buildProjectDocContext, DocIndex } from './lib/doc-context';
import { extractAnnotations } from './lib/citations';
import { execute, queryOne } from './lib/db';
import { createAgent, loadMessages } from './agent';
import { ensureSkillsDownloaded, skillsLocalBase } from './lib/skills';
import { buildMcpClients } from './lib/mcp-config';

const PORT = process.env.PORT ?? 8080;
const app = express();

function sse(res: express.Response, data: object): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function extractUserIdFromBearer(authHeader: string | undefined): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    const token = authHeader.slice(7);
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return (payload.sub as string) ?? null;
  } catch { return null; }
}

app.get('/ping', (_req, res) => {
  res.json({ status: 'Healthy', time_of_last_update: Math.floor(Date.now() / 1000) });
});

app.post('/invocations', express.raw({ type: '*/*' }), async (req, res) => {
  let body: {
    chatId: string;
    prompt: string;
    projectId?: string;
    runtimeSessionId?: string;
    model?: string;
  };

  try {
    body = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString() : new TextDecoder().decode(req.body as ArrayBuffer));
  } catch {
    res.status(400).json({ error: 'Invalid JSON payload' });
    return;
  }

  const userId = extractUserIdFromBearer(req.headers.authorization);
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { chatId, projectId, model } = body;
  const attachedDocuments: { filename: string; document_id: string }[] =
    Array.isArray((body as any).attached_documents) ? (body as any).attached_documents : [];
  const sessionId = body.runtimeSessionId ?? `${userId}-${crypto.randomUUID()}`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const [{ docIndex, docStore }, previousMessages, , mcpClients] = await Promise.all([
      projectId ? buildProjectDocContext(projectId) : buildDocContext(userId),
      loadMessages(chatId),
      ensureSkillsDownloaded(userId).catch(err => console.error('[skills] download failed:', err)),
      queryOne<{ disabled_mcp_servers: string | string[] }>(
        'SELECT disabled_mcp_servers FROM user_profiles WHERE user_id = :userId',
        [{ name: 'userId', value: { stringValue: userId } }],
      ).then(row => {
        const raw = row?.disabled_mcp_servers ?? [];
        const ids: string[] = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return buildMcpClients(ids);
      }).catch(err => { console.error('[mcp] failed to build clients:', err); return []; }),
    ]);

    let prompt: string = body.prompt;
    if (attachedDocuments.length > 0) {
      const byDocumentId = new Map(Object.entries(docIndex).map(([slug, d]) => [d.document_id, slug]));
      const lines = attachedDocuments.map(d => {
        const slug = byDocumentId.get(d.document_id);
        return slug ? `- ${slug}: ${d.filename}` : `- ${d.filename}`;
      });
      prompt = `USER-ATTACHED DOCUMENTS FOR THIS TURN:\nThe user has attached the following document(s) directly to their message. Treat these as the primary focus of the request unless their message clearly says otherwise.\n${lines.join('\n')}\n\n${prompt}`;
    }

    const agent = createAgent(userId, docStore, docIndex, chatId, previousMessages, skillsLocalBase(userId), mcpClients ?? [], projectId, model);

    let fullText = '';
    // Buffer tail to suppress <CITATIONS> block from streaming to frontend
    const CITATIONS_TAG = '<CITATIONS>';
    let tailBuffer = '';
    let citationsSeen = false;

    const streamVisible = (delta: string) => {
      if (!delta || citationsSeen) return;
      const combined = tailBuffer + delta;
      const idx = combined.indexOf(CITATIONS_TAG);
      if (idx >= 0) {
        const visible = combined.slice(0, idx);
        if (visible) sse(res, { type: 'content_delta', text: visible });
        tailBuffer = '';
        citationsSeen = true;
        return;
      }
      const keep = Math.min(CITATIONS_TAG.length - 1, combined.length);
      const visible = combined.slice(0, combined.length - keep);
      tailBuffer = combined.slice(combined.length - keep);
      if (visible) sse(res, { type: 'content_delta', text: visible });
    };

    const flushTail = () => {
      if (citationsSeen || !tailBuffer) { tailBuffer = ''; return; }
      sse(res, { type: 'content_delta', text: tailBuffer });
      tailBuffer = '';
    };

    for await (const event of agent.stream(prompt)) {
      console.log('streamingEvent', JSON.stringify(event));
      // --- Reasoning deltas (extended thinking) ---
      if (
        event.type === 'modelStreamUpdateEvent' &&
        event.event.type === 'modelContentBlockDeltaEvent' &&
        event.event.delta.type === 'reasoningContentDelta'
      ) {
        const delta = event.event.delta as { type: string; text?: string; signature?: string };
        if (delta.text) sse(res, { type: 'reasoning_delta', text: delta.text });
        if (delta.signature) sse(res, { type: 'reasoning_block_end' });
        continue;
      }

      // --- Text deltas ---
      if (
        event.type === 'modelStreamUpdateEvent' &&
        event.event.type === 'modelContentBlockDeltaEvent' &&
        event.event.delta.type === 'textDelta'
      ) {
        const text = event.event.delta.text;
        fullText += text;
        streamVisible(text);
        continue;
      }

      // --- Before tool call: emit _start event + generic tool_call_start ---
      if (event.type === 'beforeToolCallEvent') {
        const { name, input } = event.toolUse;
        sse(res, { type: 'tool_call_start', name });

        switch (name) {
          case 'read_document': {
            const docId = (input as { doc_id?: string }).doc_id ?? '';
            const filename = (docIndex as DocIndex)[docId]?.filename ?? docId;
            sse(res, { type: 'doc_read_start', filename });
            break;
          }
          case 'find_in_document': {
            const docId = (input as { doc_id?: string }).doc_id ?? '';
            const filename = (docIndex as DocIndex)[docId]?.filename ?? docId;
            sse(res, { type: 'doc_find_start', filename, query: (input as { query?: string }).query ?? '' });
            break;
          }
          case 'generate_docx': {
            const title = (input as { title?: string }).title ?? '';
            const previewFilename = `${title.replace(/[^a-z0-9]/gi, '_')}.docx`;
            sse(res, { type: 'doc_created_start', filename: previewFilename });
            break;
          }
          case 'edit_document': {
            const docId = (input as { doc_id?: string }).doc_id ?? '';
            const filename = (docIndex as DocIndex)[docId]?.filename ?? docId;
            sse(res, { type: 'doc_edited_start', filename });
            break;
          }
          case 'replicate_document': {
            const docId = (input as { doc_id?: string }).doc_id ?? '';
            const filename = (docIndex as DocIndex)[docId]?.filename ?? docId;
            sse(res, { type: 'doc_replicate_start', filename, count: 1 });
            break;
          }
          case 'browse_web':
            sse(res, { type: 'browser_navigate_start', url: (input as { url?: string }).url ?? '' });
            break;
        }
        continue;
      }

      // --- After tool call: emit result event ---
      if (event.type === 'afterToolCallEvent') {
        const { name } = event.toolUse;
        // Parse the tool result text as JSON to get structured fields
        const result = (() => {
          try {
            const textBlock = event.result.content.find(
              c => (c as { type: string }).type === 'textBlock'
            );
            if (textBlock && 'text' in textBlock) {
              return JSON.parse(textBlock.text as string) as Record<string, unknown>;
            }
          } catch { /* ignore parse errors */ }
          return {} as Record<string, unknown>;
        })();

        switch (name) {
          case 'read_document': {
            const docId = (event.toolUse.input as { doc_id?: string }).doc_id ?? '';
            const filename = (docIndex as DocIndex)[docId]?.filename ?? docId;
            sse(res, { type: 'doc_read', filename });
            break;
          }
          case 'find_in_document':
            sse(res, { type: 'doc_find', filename: result.filename ?? '', query: result.query ?? '', total_matches: result.total_matches ?? 0 });
            break;
          case 'generate_docx':
            sse(res, { type: 'doc_created', filename: result.filename ?? '', download_url: result.download_url ?? '', document_id: result.document_id, version_id: result.version_id });
            break;
          case 'edit_document':
            sse(res, { type: 'doc_edited', filename: result.filename ?? '', document_id: result.document_id ?? '', version_id: result.version_id ?? '', download_url: result.download_url ?? '', annotations: result.annotations ?? [] });
            break;
          case 'replicate_document': {
            const docId = (event.toolUse.input as { doc_id?: string }).doc_id ?? '';
            const sourceFilename = (docIndex as DocIndex)[docId]?.filename ?? docId;
            sse(res, { type: 'doc_replicated', filename: sourceFilename, count: result.count ?? 0, copies: result.copies });
            break;
          }
          case 'browse_web':
            sse(res, { type: 'browser_navigate', url: (event.toolUse.input as { url?: string }).url ?? '', error: result.error as string | undefined });
            break;
        }
        continue;
      }
    }

    // --- End of stream ---
    flushTail();
    citationsSeen = false; // reset for next turn
    const idx = docIndex as DocIndex;
    const byDocumentId = new Map(Object.values(idx).map(d => [d.document_id, d]));
    const validDocumentIds = new Set(byDocumentId.keys());
    const parsed = extractAnnotations(fullText, validDocumentIds);
    const annotations = parsed.map((a) => ({
      type: 'citation_data' as const,
      ref: a.ref,
      document_id: a.document_id,
      version_id: a.version_id,
      version_number: byDocumentId.get(a.document_id)?.version_number ?? null,
      filename: a.filename,
      page: a.page,
      quote: a.quote,
    }));
    sse(res, { type: 'content_done' });
    sse(res, { type: 'citations', citations: annotations });

    // Store session ID so subsequent turns and page-reload can resume the session.
    await execute(
      'UPDATE chats SET agentcore_session_id = :sessionId WHERE id = :chatId',
      [
        { name: 'sessionId', value: { stringValue: sessionId } },
        { name: 'chatId', value: { stringValue: chatId } },
      ],
    );

    res.write('data: [DONE]\n\n');
  } catch (err) {
    console.error('[invocations] error:', err);
    sse(res, { type: 'error', message: 'Internal error' });
  } finally {
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Agent running on port ${PORT}`);
});
