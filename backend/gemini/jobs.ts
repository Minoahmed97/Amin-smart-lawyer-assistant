import { waitUntil } from '@vercel/functions';
import crypto from 'node:crypto';
import { requireActiveSession, requireSession } from '../auth.ts';
import counterBriefHandler, { assertLawyerVaultContext } from './counter-brief.ts';
import deconstructHandler from './deconstruct.ts';
import qualifyHandler from './qualify.ts';
import refineHandler from './refine.ts';

const TASK_HANDLERS: Record<string, (req: any, res: any) => any> = {
  'counter-brief': counterBriefHandler,
  deconstruct: deconstructHandler,
  qualify: qualifyHandler,
  refine: refineHandler,
};

const JOB_TABLE = 'app_ai_generation_jobs';
const MAX_FACTS = 200_000;
const MAX_CONTEXT = 30_000;

function getSupabaseConfig() {
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
  const key = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim();
  if (!url || !key) throw new Error('إعدادات التخزين المركزي للمهام غير مكتملة على الخادم.');
  return { url, key };
}

async function supabase(path: string, init: RequestInit = {}) {
  const { url, key } = getSupabaseConfig();
  const headers: Record<string, string> = {
    apikey: key,
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> || {}),
  };
  if (!key.startsWith('sb_')) headers.Authorization = `Bearer ${key}`;
  return fetch(`${url}/rest/v1/${path}`, { ...init, headers });
}

function safePayload(input: any, taskType: string) {
  if (!TASK_HANDLERS[taskType]) {
    const error: any = new Error('نوع مهمة الذكاء الاصطناعي غير صالح.');
    error.statusCode = 400;
    throw error;
  }
  const payload: Record<string, string> = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      payload[key] = String(value);
    }
  }
  const combinedLength = Object.values(payload).reduce((sum, value) => sum + value.length, 0);
  if (combinedLength > MAX_FACTS + MAX_CONTEXT) {
    const error: any = new Error('حجم بيانات المهمة أكبر من الحد المسموح.');
    error.statusCode = 413;
    throw error;
  }
  const requiredByType: Record<string, string> = {
    'counter-brief': 'facts',
    deconstruct: 'opponentBriefText',
    qualify: 'disputeDetails',
    refine: 'draftText',
  };
  if (!String(payload[requiredByType[taskType]] || '').trim()) {
    const error: any = new Error('البيانات المطلوبة لبدء المهمة غير مكتملة.');
    error.statusCode = 400;
    throw error;
  }
  if (taskType === 'counter-brief' || taskType === 'deconstruct' || taskType === 'refine') {
    assertLawyerVaultContext(payload.vaultContext);
  }
  return payload;
}

async function patchJob(id: string, userId: string, values: Record<string, unknown>) {
  const res = await supabase(`${JOB_TABLE}?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ ...values, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`تعذر تحديث مهمة الصياغة (${res.status}).`);
}

async function processJob(jobId: string, userId: string, token: string, taskType: string, payload: Record<string, string>, originalReq: any) {
  let fullText = '';
  let pendingWrite = Promise.resolve();
  let persistedLength = 0;
  let streamError = '';

  const fakeRes: any = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    setHeader() { return this; },
    flushHeaders() { this.headersSent = true; },
    status(code: number) { this.statusCode = code; return this; },
    json(body: any) {
      this.headersSent = true;
      if (body?.error) streamError = String(body.error);
      this.end();
      return this;
    },
    write(raw: string) {
      this.headersSent = true;
      const lines = String(raw).split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        const candidate = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
        try {
          const event = JSON.parse(candidate);
          if (event.type === 'chunk' && typeof event.text === 'string') {
            fullText += event.text;
            if (fullText.length - persistedLength >= 800) {
              persistedLength = fullText.length;
              const snapshot = fullText;
              pendingWrite = pendingWrite.then(() => patchJob(jobId, userId, { partial_result: snapshot })).catch((err) => {
                console.error('AI job partial persistence failed:', err instanceof Error ? err.message : 'unknown');
              });
            }
          } else if (event.type === 'error') {
            streamError = String(event.error || 'فشلت المهمة.');
          }
        } catch {
          // Ignore start/keepalive lines and non-JSON frames.
        }
      }
      return true;
    },
    end() { this.writableEnded = true; return this; },
  };

  try {
    await patchJob(jobId, userId, { status: 'running', error: null });
    const fakeReq = {
      ...originalReq,
      method: 'POST',
      headers: { ...(originalReq?.headers || {}), authorization: `Bearer ${token}` },
      body: { ...payload, stream: true },
    };
    await TASK_HANDLERS[taskType](fakeReq, fakeRes);
    await pendingWrite;

    if (fakeRes.statusCode >= 400 || streamError || !fullText.trim()) {
      const error = streamError || `تعذر إكمال الصياغة (HTTP ${fakeRes.statusCode}).`;
      await patchJob(jobId, userId, { status: 'failed', error, partial_result: fullText, payload: {} });
      return;
    }
    await patchJob(jobId, userId, {
      status: 'completed',
      result: fullText,
      partial_result: fullText,
      payload: {},
      error: null,
      completed_at: new Date().toISOString(),
    });
  } catch (err: any) {
    await pendingWrite.catch(() => undefined);
    const message = String(err?.message || 'تعذر إكمال الصياغة.').slice(0, 1000);
    try {
      await patchJob(jobId, userId, { status: 'failed', error: message, partial_result: fullText, payload: {} });
    } catch (persistError: any) {
      console.error('AI job failure status could not be persisted:', persistError?.message || 'unknown');
    }
  }
}

export default async function handler(req: any, res: any) {
  try {
    if (req.method === 'POST') {
      const { session } = await requireActiveSession(req);
      const requestBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
      const taskType = String(requestBody?.taskType || 'counter-brief');
      const payload = safePayload(requestBody?.payload || requestBody, taskType);
      const cleanup = await supabase(`${JOB_TABLE}?created_at=lt.${encodeURIComponent(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())}`, { method: 'DELETE' });
      if (!cleanup.ok) console.warn('Old AI job cleanup failed:', cleanup.status);

      const requestedId = String(requestBody?.jobId || '').trim();
      const id = /^[0-9a-f-]{36}$/i.test(requestedId) ? requestedId : crypto.randomUUID();
      const insert = await supabase(JOB_TABLE, {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          id,
          user_id: session.userId,
          task_type: taskType,
          status: 'queued',
          payload,
          partial_result: '',
          result: '',
          error: null,
        }),
      });
      if (!insert.ok) {
        // Idempotency: a retry with the same client-generated job id must never
        // launch a second paid generation if the original create response was lost.
        const existingRes = await supabase(`${JOB_TABLE}?select=id,status&id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(session.userId)}&limit=1`);
        if (existingRes.ok) {
          const existingRows = await existingRes.json();
          const existing = Array.isArray(existingRows) ? existingRows[0] : null;
          if (existing?.id) return res.status(202).json({ jobId: existing.id, status: existing.status || 'queued' });
        }
        const detail = await insert.text().catch(() => '');
        console.error('AI job insert failed:', insert.status, detail.slice(0, 300));
        return res.status(503).json({ error: 'تعذر حفظ مهمة الصياغة على الخادم. نفّذ ترحيل جدول المهام ثم أعد المحاولة.' });
      }

      const token = String(req?.headers?.authorization || '').replace(/^Bearer\s+/i, '').trim();
      const task = processJob(id, session.userId, token, taskType, payload, req);
      try {
        waitUntil(task);
      } catch {
        // Local development fallback. On Vercel, waitUntil keeps the task alive after the response.
        void task;
      }
      return res.status(202).json({ jobId: id, status: 'queued' });
    }

    if (req.method === 'GET') {
      const session = requireSession(req);
      const id = String(req?.query?.id || '').trim();
      if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'معرّف المهمة غير صالح.' });
      const result = await supabase(`${JOB_TABLE}?select=id,status,partial_result,result,error,created_at,updated_at,completed_at&id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(session.userId)}&limit=1`);
      if (!result.ok) return res.status(503).json({ error: 'تعذر استرجاع حالة مهمة الصياغة.' });
      const rows = await result.json();
      const job = Array.isArray(rows) ? rows[0] : null;
      if (!job) return res.status(404).json({ error: 'لم يتم العثور على المهمة لهذا الحساب.' });
      return res.status(200).json({
        jobId: job.id,
        status: job.status,
        partialResult: job.partial_result || '',
        result: job.result || '',
        error: job.error || null,
        updatedAt: job.updated_at || null,
        completedAt: job.completed_at || null,
      });
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (err: any) {
    const statusCode = Number(err?.statusCode);
    const status = Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600 ? statusCode : 500;
    return res.status(status).json({ error: err?.message || 'تعذر معالجة مهمة الصياغة.' });
  }
}
