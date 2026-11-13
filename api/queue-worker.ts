import { QueueClient } from '@vercel/queue';
import { runDurableQueuedJob } from '../backend/gemini/jobs.ts';

const queue = new QueueClient();

export default queue.handleNodeCallback(async (message: any) => {
  const jobId = String(message?.jobId || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) {
    throw new Error('Invalid AI job identifier in durable queue message.');
  }

  // Await the entire persisted-job pipeline. A normal return acknowledges the
  // queue message; a thrown error lets Vercel retry the delivery.
  await runDurableQueuedJob(jobId);
});
