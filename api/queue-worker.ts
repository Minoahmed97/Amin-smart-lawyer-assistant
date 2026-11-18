import { QueueClient } from '@vercel/queue';
import { runDurableQueuedJob } from '../backend/gemini/jobs.ts';

export const config = { api: { bodyParser: false } };

const queue = new QueueClient();
const queueCallback = queue.handleNodeCallback(async (message: any) => {
  const jobId = String(message?.jobId || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) {
    throw new Error('Invalid AI job identifier in durable queue message.');
  }
  await runDurableQueuedJob(jobId);
});

// Use the SDK's native Node.js callback for Vercel's api/*.ts runtime.
// The raw CloudEvent body is buffered because bodyParser is intentionally disabled.
export default async function handler(req: any, res: any) {
  try {
    if (req.body === undefined) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      req.body = Buffer.concat(chunks);
    }
    await queueCallback(req, res);
  } catch (error: any) {
    console.error('Durable queue callback failed:', error?.message || error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'تعذر تشغيل عامل المهام الخلفي.' });
    } else {
      res.end();
    }
  }
}
