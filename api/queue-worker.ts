import { handleCallback } from '@vercel/queue';
import { runDurableQueuedJob } from '../backend/gemini/jobs.ts';

export const config = { runtime: 'nodejs' };

export default handleCallback(async (message: any) => {
  const jobId = String(message?.jobId || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) {
    throw new Error('Invalid AI job identifier in durable queue message.');
  }
  await runDurableQueuedJob(jobId);
});
