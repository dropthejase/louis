import express from 'express';
import { extractAnnotations } from './lib/citations';
import { buildTabularContext } from './lib/tabular-context';
import { buildTabularSystemPrompt } from './system-prompt';
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
    reviewId: string;
    chatId: string;
    prompt: string;
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

  const { reviewId, prompt, model } = body;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const ctx = await buildTabularContext(reviewId, userId);
    if (!ctx) {
      sse(res, { type: 'error', message: 'Review not found' });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    const systemPrompt = buildTabularSystemPrompt(ctx);
    const agent = createAgent(userId, systemPrompt, model);

    let fullText = '';

    for await (const event of agent.stream(prompt)) {
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

      if (event.type === 'beforeToolCallEvent') {
        sse(res, { type: 'tool_call_start', name: event.toolUse.name });
        continue;
      }
    }

    const annotations = extractAnnotations(fullText);
    sse(res, { type: 'content_done' });
    sse(res, { type: 'citations', citations: annotations });
    res.write('data: [DONE]\n\n');
  } catch (err) {
    console.error('[invocations] error:', err);
    sse(res, { type: 'error', message: 'Internal error' });
  } finally {
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Tabular agent running on port ${PORT}`);
});
