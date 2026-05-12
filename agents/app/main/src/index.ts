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
import { execute } from './lib/db';
import { createAgent } from './agent';

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

  const { chatId, prompt, projectId, model } = body;
  // Always have a session ID — frontend sends one on turn 2+; generate a fallback
  // on turn 1 so the SessionManager is always created and the snapshot is always saved.
  const sessionId = body.runtimeSessionId ?? `${userId}-${crypto.randomUUID()}`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const { docIndex, docStore } = projectId
      ? await buildProjectDocContext(projectId)
      : await buildDocContext(userId);

    const agent = createAgent(userId, docStore, docIndex, projectId, model, sessionId);

    let fullText = '';

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
        sse(res, { type: 'content_delta', text });
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
          case 'replicate_document':
            sse(res, { type: 'doc_replicated', filename: result.filename ?? '', count: result.count ?? 0, copies: result.copies });
            break;
        }
        continue;
      }
    }

    // --- End of stream ---
    const parsed = extractAnnotations(fullText);
    const idx = docIndex as DocIndex;
    const annotations = parsed.map((a) => ({
      type: 'citation_data' as const,
      ref: a.ref,
      doc_id: a.doc_id,
      document_id: idx[a.doc_id]?.document_id ?? '',
      version_id: idx[a.doc_id]?.version_id ?? null,
      version_number: idx[a.doc_id]?.version_number ?? null,
      filename: idx[a.doc_id]?.filename ?? a.doc_id,
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
