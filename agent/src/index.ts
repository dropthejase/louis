import express from 'express';
import { getSupabaseClient } from './lib/supabase';
import { buildDocContext, buildProjectDocContext, DocIndex } from './lib/doc-context';
import { extractAnnotations } from './lib/citations';
import { createAgent } from './agent';

const PORT = process.env.PORT ?? 8080;
const app = express();

function sse(res: express.Response, data: object): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

app.get('/ping', (_req, res) => {
  res.json({ status: 'Healthy', time_of_last_update: Math.floor(Date.now() / 1000) });
});

app.post('/invocations', express.raw({ type: '*/*' }), async (req, res) => {
  let body: {
    userId: string;
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

  const { userId, chatId, prompt, projectId, model } = body;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const db = await getSupabaseClient();

    const { docIndex, docStore } = projectId
      ? await buildProjectDocContext(projectId, db)
      : await buildDocContext(userId, db);

    const agent = createAgent(userId, docStore, docIndex, db, projectId, model);

    let fullText = '';

    for await (const event of agent.stream(prompt)) {
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
            sse(res, { type: 'doc_created_start', filename: title });
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
          case 'read_document':
            sse(res, { type: 'doc_read', filename: result.filename ?? '' });
            break;
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
    const annotations = extractAnnotations(fullText);
    sse(res, { type: 'content_done' });
    sse(res, { type: 'citations', citations: annotations });

    // Persist assistant message
    await db.from('chat_messages').insert({
      chat_id: chatId,
      role: 'assistant',
      content: [{ type: 'text', text: fullText }],
      annotations: annotations.length > 0 ? annotations : null,
    });

    // Store AgentCore session ID for multi-turn continuity
    if (body.runtimeSessionId) {
      await db.from('chats').update({ agentcore_session_id: body.runtimeSessionId }).eq('id', chatId);
    }

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
