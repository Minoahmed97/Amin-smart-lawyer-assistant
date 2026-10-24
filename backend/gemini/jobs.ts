import { waitUntil } from '@vercel/functions';
import crypto from 'node:crypto';
import webpush from 'web-push';
import { requireActiveSession, requireSession } from '../auth.ts';
import counterBriefHandler from './counter-brief.ts';
import deconstructHandler from './deconstruct.ts';
import qualifyHandler from './qualify.ts';
import refineHandler from './refine.ts';
import ocrHandler from '../ocr.ts';
import { validateBase64Payload, limitBodyString } from '../security.ts';

const TASK_HANDLERS: Record<string, (req: any, res: any) => any> = {
  'counter-brief': counterBriefHandler,
  deconstruct: deconstructHandler,
  qualify: qualifyHandler,
  refine: refineHandler,
  ocr: ocrHandler,
};

const JOB_TABLE = 'app_ai_generation_jobs';
const PUSH_TABLE = 'app_push_subscriptions';
const MAX_FACTS = 200_000;
const MAX_CONTEXT = 30_000;
// The provider deadline is 4:30; allow time for the worker to persist its terminal status before stale cleanup.
const JOB_STALE_TIMEOUT_MS = 4 * 60 * 1000 + 55 * 1000;

function safeDiagnosticMessage(value: unknown) {
  return String(value || 'unknown')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_API_KEY]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|secret)\b\s*[:=]\s*["']?[^"'\s,;]+/gi, '$1=[REDACTED]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[REDACTED_URL]')
    .replace(/(["'`])[^\r\n]{80,}?\1/g, '$1[REDACTED_TEXT]$1')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 400);
}

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
  const signal = init.signal || AbortSignal.timeout(10000);
  return fetch(`${url}/rest/v1/${path}`, { ...init, headers, signal });
}


function configureWebPush() {
  const publicKey = (process.env.VAPID_PUBLIC_KEY || '').trim();
  const privateKey = (process.env.VAPID_PRIVATE_KEY || '').trim();
  const subject = (process.env.VAPID_SUBJECT || '').trim();
  if (!publicKey || !privateKey || !subject) return false;
  webpush.setVapidDetails(subject, publicKey, privateKey);
  return true;
}

async function savePushSubscription(userId: string, subscription: any) {
  const endpoint = String(subscription?.endpoint || '').trim();
  const p256dh = String(subscription?.keys?.p256dh || '').trim();
  const auth = String(subscription?.keys?.auth || '').trim();
  if (!/^https:\/\//i.test(endpoint) || !p256dh || !auth || endpoint.length > 3000) {
    const error: any = new Error('بيانات الاشتراك في الإشعارات غير صالحة.');
    error.statusCode = 400;
    throw error;
  }
  const response = await supabase(`${PUSH_TABLE}?on_conflict=endpoint`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ user_id: userId, endpoint, subscription: { endpoint, keys: { p256dh, auth } }, updated_at: new Date().toISOString() }),
  });
  if (!response.ok) throw new Error('تعذر حفظ اشتراك الإشعارات في قاعدة البيانات. نفّذ ترحيل الإشعارات أولاً.');
}

async function sendCompletionPush(userId: string, jobId: string, taskType: string, status: 'completed' | 'failed') {
  try {
    if (!configureWebPush()) return;
    const response = await supabase(`${PUSH_TABLE}?select=id,endpoint,subscription&user_id=eq.${encodeURIComponent(userId)}`);
    if (!response.ok) throw new Error(`Push subscription lookup failed (${response.status})`);
    const subscriptions = await response.json();
    const taskNames: Record<string, string> = {
      'counter-brief': 'توليد المذكرة', deconstruct: 'تحليل المستند', qualify: 'التكييف القانوني', refine: 'مراجعة الصياغة', ocr: 'استخراج النص من الملف',
    };
    const title = status === 'completed' ? 'اكتملت المهمة القانونية' : 'تعذّر إكمال المهمة القانونية';
    const body = `${taskNames[taskType] || 'المهمة'} ${status === 'completed' ? 'جاهزة؛ افتح التطبيق لعرض النتيجة.' : 'لم تكتمل؛ افتح التطبيق لمعرفة التفاصيل.'}`;
    await Promise.all((Array.isArray(subscriptions) ? subscriptions : []).map(async (row: any) => {
      try {
        await webpush.sendNotification(row.subscription, JSON.stringify({ title, body, url: `/?jobId=${encodeURIComponent(jobId)}` }), { TTL: 60 * 60 * 24 });
      } catch (error: any) {
        if (error?.statusCode === 404 || error?.statusCode === 410) {
          await supabase(`${PUSH_TABLE}?id=eq.${encodeURIComponent(row.id)}`, { method: 'DELETE' }).catch(() => undefined);
        } else {
          console.warn('Completion push delivery failed:', error?.statusCode || 'unknown');
        }
      }
    }));
  } catch (error: any) {
    // Push is best-effort and must never turn a completed job into a failed job.
    console.warn('Completion push notification skipped:', safeDiagnosticMessage(error?.message || error));
  }
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

  if (taskType === 'ocr') {
    payload.base64Data = validateBase64Payload(payload.base64Data, 20 * 1024 * 1024);
    limitBodyString(payload.fileName, 255, 'اسم الملف');
    const fileName = String(payload.fileName || '').trim();
    const mimeType = String(payload.mimeType || '').toLowerCase();
    const allowedMimeTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/jpeg', 'image/png', 'image/webp', 'image/bmp',
    ];
    if (!fileName || !/\.(pdf|doc|docx|jpe?g|png|webp|bmp)$/i.test(fileName)) {
      const error: any = new Error('اسم الملف أو صيغته غير مدعومين.');
      error.statusCode = 400;
      throw error;
    }
    if (mimeType && !allowedMimeTypes.includes(mimeType)) {
      const error: any = new Error('نوع الملف غير مدعوم.');
      error.statusCode = 400;
      throw error;
    }
    const recoveryScope = String(payload.recoveryScope || 'general');
    if (!['general', 'drafting', 'deconstruct', 'qualify', 'vault'].includes(recoveryScope)) {
      const error: any = new Error('مسار استعادة مهمة OCR غير صالح.');
      error.statusCode = 400;
      throw error;
    }
    payload.fileName = fileName;
    payload.recoveryScope = recoveryScope;
    return payload;
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
  if (taskType === 'counter-brief' && !String(payload.vaultContext || '').includes('[بصمة أسلوب المحامي')) {
    const error: any = new Error('لم يتم العثور على نموذج شخصي من خزانة هذا الحساب. لم يبدأ التوليد ولم يُخصم رصيد؛ أضف أو استعد نماذجك الشخصية أولاً.');
    error.statusCode = 400;
    throw error;
  }
  return payload;
}

async function patchJob(id: string, userId: string, values: Record<string, unknown>) {
  // Never let a late partial write or a caught exception overwrite a terminal
  // result. PostgREST may return 204 even when this condition matches no row.
  const res = await supabase(`${JOB_TABLE}?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}&status=not.in.(completed,failed)`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ ...values, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`تعذر تحديث حالة المهمة (${res.status}).`);
}

async function processJob(jobId: string, userId: string, token: string, taskType: string, payload: Record<string, string>, originalReq: any) {
  let fullText = '';
  let pendingWrite = Promise.resolve();
  let persistedLength = 0;
  let streamError = '';
  let handlerJson: any = null;

  const fakeRes: any = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    setHeader() { return this; },
    flushHeaders() { this.headersSent = true; },
    status(code: number) { this.statusCode = code; return this; },
    json(body: any) {
      this.headersSent = true;
      handlerJson = body;
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
    if (!fullText.trim() && taskType === 'ocr' && typeof handlerJson?.text === 'string') {
      fullText = handlerJson.text.trim();
    }

    if (fakeRes.statusCode >= 400 || streamError || !fullText.trim()) {
      const taskLabel = taskType === 'ocr' ? 'استخراج النص' : 'الصياغة';
      const error = streamError || `تعذر إكمال ${taskLabel} (HTTP ${fakeRes.statusCode}).`;
      const failureKind = fakeRes.statusCode >= 400
        ? 'http_status'
        : /لم تُنتج خدمة الذكاء الاصطناعي نتيجة صالحة|لم تنتج خدمة الذكاء الاصطناعي نتيجة صالحة/i.test(error)
          ? 'empty_output'
          : streamError
            ? 'stream_error'
            : 'empty_output';
      console.error('AI job generation failed:', {
        jobId,
        taskType,
        failureKind,
        httpStatus: fakeRes.statusCode,
        outputChars: fullText.length,
        error: safeDiagnosticMessage(error),
      });
      await patchJob(jobId, userId, { status: 'failed', error, partial_result: fullText, payload: taskType === 'ocr' ? { recoveryScope: payload.recoveryScope || 'general' } : {} });
      await sendCompletionPush(userId, jobId, taskType, 'failed');
      return;
    }
    await patchJob(jobId, userId, {
      status: 'completed',
      result: fullText,
      partial_result: fullText,
      payload: taskType === 'ocr' ? { recoveryScope: payload.recoveryScope || 'general' } : {},
      error: null,
      completed_at: new Date().toISOString(),
    });
    await sendCompletionPush(userId, jobId, taskType, 'completed');
  } catch (err: any) {
    await pendingWrite.catch(() => undefined);
    const message = String(err?.message || 'تعذر إكمال الصياغة.').slice(0, 1000);
    console.error('AI job processor threw an exception:', {
      jobId,
      taskType,
      errorName: safeDiagnosticMessage(err?.name || 'Error'),
      error: safeDiagnosticMessage(message),
      outputChars: fullText.length,
    });
    try {
      await patchJob(jobId, userId, { status: 'failed', error: message, partial_result: fullText, payload: taskType === 'ocr' ? { recoveryScope: payload.recoveryScope || 'general' } : {} });
      await sendCompletionPush(userId, jobId, taskType, 'failed');
    } catch (persistError: any) {
      console.error('AI job failure status could not be persisted:', persistError?.message || 'unknown');
    }
  }
}

export default async function handler(req: any, res: any) {
  try {
    if (req.method === 'POST') {
      const requestBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
      if (requestBody?.action === 'subscribe-push') {
        const { session } = requireSession(req);
        await savePushSubscription(session.userId, requestBody.subscription);
        return res.status(200).json({ subscribed: true });
      }
      const { session } = await requireActiveSession(req);
      const taskType = String(requestBody?.taskType || 'counter-brief');
      const payload = safePayload(requestBody?.payload || requestBody, taskType);
      // Cleanup is best-effort and must not prevent a new task from being inserted.
      try {
        const cleanup = await supabase(`${JOB_TABLE}?task_type=neq.ocr&status=in.(completed,failed)&created_at=lt.${encodeURIComponent(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())}`, { method: 'DELETE' });
        if (!cleanup.ok) console.warn('Old AI job cleanup failed:', cleanup.status);
      } catch (cleanupError: any) {
        console.warn('Old AI job cleanup failed; continuing task creation:', safeDiagnosticMessage(cleanupError?.message || cleanupError));
      }

      const requestedId = String(requestBody?.jobId || '').trim();
      const id = /^[0-9a-f-]{36}$/i.test(requestedId) ? requestedId : crypto.randomUUID();
      const insert = await supabase(JOB_TABLE, {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        signal: AbortSignal.timeout(taskType === 'ocr' ? 60_000 : 10_000),
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
      // The VAPID public key is safe to expose to the authenticated client.
      // Read it from the same server environment used to send push notifications,
      // so a missing/mismatched VITE build variable cannot silently disable push.
      if (String(req?.query?.action || '') === 'push-public-key') {
        const publicKey = (process.env.VAPID_PUBLIC_KEY || '').trim();
        if (!publicKey) return res.status(503).json({ error: 'إعدادات إشعارات الإنجاز غير مكتملة على الخادم.' });
        return res.status(200).json({ publicKey });
      }
      const id = String(req?.query?.id || '').trim();
      if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'معرّف المهمة غير صالح.' });
      const jobPath = `${JOB_TABLE}?select=id,status,partial_result,result,error,created_at,updated_at,completed_at&id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(session.userId)}&limit=1`;
      const result = await supabase(jobPath);
      if (!result.ok) return res.status(503).json({ error: 'تعذر استرجاع حالة مهمة الصياغة.' });
      const rows = await result.json();
      let job = Array.isArray(rows) ? rows[0] : null;
      if (!job) return res.status(404).json({ error: 'لم يتم العثور على المهمة لهذا الحساب.' });

      const lastActivityAt = Date.parse(String(job.updated_at || job.created_at || ''));
      if ((job.status === 'queued' || job.status === 'running') && Number.isFinite(lastActivityAt) && Date.now() - lastActivityAt >= JOB_STALE_TIMEOUT_MS) {
        const staleError = 'توقفت المعالجة بعد عدم وصول أي تحديث لمدة 4 دقائق ونصف. لم تُستكمل النتيجة؛ راجع اتصال الخدمة ثم استعد المهمة أو ابدأ طلبًا جديدًا.';
        try {
          await patchJob(id, session.userId, {
            status: 'failed',
            error: staleError,
            partial_result: job.partial_result || '',
            payload: {},
          });
          // Re-read to respect a completion that raced with this stale check.
          const refreshed = await supabase(jobPath);
          if (!refreshed.ok) return res.status(503).json({ error: 'تعذر التحقق من الحالة النهائية للمهمة.' });
          const refreshedRows = await refreshed.json();
          job = Array.isArray(refreshedRows) ? refreshedRows[0] : job;
        } catch (staleError: any) {
          console.error('AI job stale-state update failed:', safeDiagnosticMessage(staleError?.message || staleError));
          return res.status(503).json({ error: 'انتهت مهلة المهمة، لكن تعذر حفظ حالتها النهائية في قاعدة البيانات.' });
        }
      }
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
