import { handleCallback } from '@vercel/queue';
import { runDurableQueuedJob } from '../backend/gemini/jobs.ts';

export const config = {
  runtime: 'nodejs',
  api: { bodyParser: false },
};

const queueCallback = handleCallback(async (message: any) => {
  const jobId = String(message?.jobId || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) {
    throw new Error('Invalid AI job identifier in durable queue message.');
  }
  await runDurableQueuedJob(jobId);
});

// This project uses Vercel's Node.js Functions (api/*.ts), not a Web-API
// route handler. Adapt the incoming Node request to the Web Request expected
// by @vercel/queue, preserving the original CloudEvent body and headers.
export default async function handler(req: any, res: any) {
  try {
    const headers = new Headers();
    for (const [name, rawValue] of Object.entries(req.headers || {})) {
      if (rawValue === undefined || rawValue === null) continue;
      headers.set(name, Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue));
    }

    const host = String(req.headers?.host || 'localhost');
    const requestUrl = new URL(String(req.url || '/api/queue-worker'), `https://${host}`);
    const method = String(req.method || 'POST').toUpperCase();
    const chunks: Uint8Array[] = [];
    if (method !== 'GET' && method !== 'HEAD') {
      for await (const chunk of req) {
        chunks.push(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk));
      }
    }
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const webRequest = new Request(requestUrl, {
      method,
      headers,
      ...(body ? { body } : {}),
    });

    const response = await queueCallback(webRequest);
    res.statusCode = response.status;
    response.headers.forEach((value, name) => res.setHeader(name, value));
    res.end(await response.text());
  } catch (error: any) {
    console.error('Durable queue callback failed:', error?.message || error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'تعذر تشغيل عامل المهام الخلفي.' });
    } else {
      res.end();
    }
  }
}
