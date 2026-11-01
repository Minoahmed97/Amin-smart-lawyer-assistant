import { waitUntil } from '@vercel/functions';
import crypto from 'node:crypto';
import webpush from 'web-push';
import { createSession, requireActiveSession, requireSession } from '../auth.ts';
import counterBriefHandler from './counter-brief.ts';
import deconstructHandler from './deconstruct.ts';
import qualifyHandler from './qualify.ts';
import refineHandler from './refine.ts';
import chatHandler from './chat.ts';
import ocrHandler from '../ocr.ts';
import { validateBase64Payload, limitBodyString } from '../security.ts';

const TASK_HANDLERS: Record<string, (req: any, res: any) => any> = {
  'counter-brief': counterBriefHandler,
  deconstruct: deconstructHandler,
  qualify: qualifyHandler,
  refine: refineHandler,
  'legal-chat': chatHandler,
  ocr: ocrHandler,
};

const JOB_TABLE = 'app_ai_generation_jobs';
const PUSH_TABLE = 'app_push_subscriptions';
const MAX_FACTS = 200_000;
const MAX_CONTEXT = 30_000;
const JOB_STALE_TIMEOUT_MS = 4 * 60 * 1000 + 10 * 1000;
const USER_CANCELLED_OCR_MESSAGE = 'ألغى المستخدم معالجة الملف.';

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
  const configuredSubject = (process.env.VAPID_SUBJECT || '').trim();
  if (!publicKey || !privateKey || !configuredSubject) return false;
  const subject = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(configuredSubject)
    ? `mailto:${configuredSubject}`
    : configuredSubject;
  if (!/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(subject) && !/^https:\/\//i.test(subject)) return false;
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
  if (!response.ok) throw new Error('تعذر حفظ اشتراك الإشعارات في قاعدة البيانات.');
}

async function sendCompletionPush(userId: string, jobId: string, taskType: string, status: 'completed' | 'failed', fileName = '') {
  try {
    if (!configureWebPush()) return;
    const response = await supabase(`${PUSH_TABLE}?select=id,endpoint,subscription&user_id=eq.${encodeURIComponent(userId)}`);
    if (!response.ok) return;
    const subscriptions = await response.json();
    const taskNames: Record<string, string> = {
      'counter-brief': 'توليد المذكرة', deconstruct: 'تحليل المستند', qualify: 'التكييف القانوني', refine: 'مراجعة الصياغة', 'legal-chat': 'الدردشة القانونية', ocr: 'استخراج النص من الملف',
    };
    const title = status === 'completed' ? 'اكتملت المهمة القانونية' : 'تعذّر إكمال المهمة القانونية';
    const fileLabel = taskType === 'ocr' && fileName ? ` (${String(fileName).slice(0, 120)})` : '';
    const body = `${taskNames[taskType] || 'المهمة'}${fileLabel} ${status === 'completed' ? 'اكتملت؛ افتح التطبيق لعرض النتيجة.' : 'لم تكتمل؛ افتح التطبيق لمعرفة التفاصيل.'}`;
    await Promise.all((Array.isArray(subscriptions) ? subscriptions : []).map(async (row: any) => {
      try {
        await webpush.sendNotification(row.subscription, JSON.stringify({ title, body, tag: `amin-ai-${jobId}`, url: `/?jobId=${encodeURIComponent(jobId)}` }), { TTL: 60 * 60 * 24 });
      } catch (error: any) {
        if (error?.statusCode === 404 || error?.statusCode === 410) {
          await supabase(`${PUSH_TABLE}?id=eq.${encodeURIComponent(row.id)}`, { method: 'DELETE' }).catch(() => undefined);
        }
      }
    }));
  } catch (error: any) {
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

  if (taskType === 'legal-chat') {
    const chatType = String(input?.taskType || '');
    if (!['deconstruct', 'qualify', 'draft'].includes(chatType)) {
      const error: any = new Error('نوع المهمة غير صالح للدردشة القانونية.');
      error.statusCode = 400;
      throw error;
    }
    if (typeof input?.originalContext !== 'string' || typeof input?.result !== 'string' || !input.result.trim()) {
      const error: any = new Error('سياق القضية أو النتيجة الأصلية غير صالحين للدردشة القانونية.');
      error.statusCode = 400;
      throw error;
    }
    limitBodyString(input.originalContext, 100000, 'سياق القضية');
    limitBodyString(input.result, 120000, 'النتيجة الأصلية');
    if (!Array.isArray(input?.messages) || input.messages.length < 1 || input.messages.length > 40) {
      const error: any = new Error('سجل المحادثة غير صالح.');
      error.statusCode = 400;
      throw error;
    }
    for (const message of input.messages) {
      if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') {
        const error: any = new Error('رسالة محادثة غير صالحة.');
        error.statusCode = 400;
        throw error;
      }
      limitBodyString(message.content, 10000, 'رسالة المحادثة');
    }
    if (input.messages[input.messages.length - 1]?.role !== 'user') {
      const error: any = new Error('يجب أن تنتهي المحادثة بسؤال من المستخدم.');
      error.statusCode = 400;
      throw error;
    }
    payload.taskType = chatType;
    payload.originalContext = input.originalContext;
    payload.result = input.result;
    payload.messages = JSON.stringify(input.messages);
    // Some deployed database schemas constrain task_type to the original job types.
    // Persist legal-chat under the existing 'refine' type and route it explicitly in the worker.
    payload._actualTaskType = 'legal-chat';
    const chatPayloadLength = Object.values(payload).reduce((sum, value) => sum + value.length, 0);
    if (chatPayloadLength > 650000) {
      const error: any = new Error('حجم سياق الدردشة القانونية أكبر من الحد المسموح.');
      error.statusCode = 413;
      throw error;
    }
    return payload;
  }

  if (taskType === 'ocr') {
    payload.base64Data = validateBase64Payload(payload.base64Data, 20 * 1024 * 1024);
    limitBodyString(payload.fileName, 255, 'اسم الملف');
    const fileName = String(payload.fileName || '').trim();
    const mimeType = String(payload.mimeType || '').toLowerCase();
    const allowedMimeTypes = [
      'application/pdf', 'application/msword',
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
  return payload;
}

async function patchJob(id: string, userId: string, values: Record<string, unknown>) {
  const res = await supabase(`${JOB_TABLE}?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}&status=not.in.(completed,failed)`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ ...values, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`تعذر تحديث حالة المهمة (${res.status}).`);
}

// OCR only: atomically claim the terminal transition. The database condition
// makes cancellation and completion mutually exclusive, even when they race.
async function finalizeOcrJob(
  id: string,
  userId: string,
  values: Record<string, unknown>,
): Promise<boolean> {
  const res = await supabase(
    `${JOB_TABLE}?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}&task_type=eq.ocr&status=not.in.(completed,failed)`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ ...values, updated_at: new Date().toISOString() }),
    },
  );
  if (!res.ok) throw new Error(`تعذر إنهاء مهمة OCR (${res.status}).`);
  const changedRows = await res.json().catch(() => []);
  return Array.isArray(changedRows) && changedRows.length > 0;
}

async function isUserCancelledOcrJob(jobId: string, userId: string): Promise<boolean> {
  try {
    const response = await supabase(
      `${JOB_TABLE}?select=status,error&id=eq.${encodeURIComponent(jobId)}&user_id=eq.${encodeURIComponent(userId)}&task_type=eq.ocr&limit=1`,
    );
    if (!response.ok) return false;
    const rows = await response.json();
    const job = Array.isArray(rows) ? rows[0] : null;
    return job?.status === 'failed' && job?.error === USER_CANCELLED_OCR_MESSAGE;
  } catch {
    return false;
  }
}

async function claimQueuedJob(jobId: string) {
  const response = await supabase(
    `${JOB_TABLE}?id=eq.${encodeURIComponent(jobId)}&status=eq.queued`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ status: 'running', updated_at: new Date().toISOString() }),
    },
  );
  if (!response.ok) throw new Error(`تعذر حجز المهمة من الطابور (${response.status}).`);
  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] || null : null;
}

function internalWorkerToken() {
  const secret = String(process.env.APP_ENCRYPTION_KEY || '').trim();
  if (secret.length < 32) throw new Error('APP_ENCRYPTION_KEY غير مضبوط أو قصير على الخادم.');
  return crypto.createHmac('sha256', secret).update('amin-ai-generation-worker-v1').digest('hex');
}

function isInternalWorkerRequest(req: any) {
  try {
    const expected = internalWorkerToken();
    const received = String(req?.headers?.['x-amin-job-worker'] || '');
    return received.length === expected.length && crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
  } catch {
    return false;
  }
}

function scheduleBackground(task: Promise<unknown>) {
  try {
    waitUntil(task);
  } catch {
    void task;
  }
}

function toPayload(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => ['string', 'number', 'boolean'].includes(typeof item))
      .map(([key, item]) => [key, String(item)]),
  );
}

function startClaimedJob(job: any) {
  const userId = String(job?.user_id || '');
  const jobId = String(job?.id || '');
  const storedTaskType = String(job?.task_type || '');
  const payload = toPayload(job?.payload);
  // Keep the database task_type within the existing supported values while
  // routing legal-chat jobs to the dedicated chat handler in the worker.
  const taskType = payload._actualTaskType === 'legal-chat' ? 'legal-chat' : storedTaskType;
  delete payload._actualTaskType;
  if (!userId || !jobId || !TASK_HANDLERS[taskType]) {
    void patchJob(jobId, userId, { status: 'failed', error: 'بيانات المهمة المحفوظة غير صالحة.', payload: {} }).catch(() => undefined);
    return;
  }
  const token = createSession(userId, 'background-worker', 10 * 60 * 1000);
  const workerReq = {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'Amin-AI-Background-Worker',
      'x-forwarded-for': `worker-${userId}`,
    },
    body: payload,
    query: {},
  };
  scheduleBackground(processJob(jobId, userId, token, taskType, payload, workerReq));
}

async function loadQueueJob(jobId: string) {
  const response = await supabase(`${JOB_TABLE}?select=id,user_id,task_type,payload,status&id=eq.${encodeURIComponent(jobId)}&limit=1`);
  if (!response.ok) throw new Error(`تعذر قراءة المهمة من الطابور (${response.status}).`);
  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] || null : null;
}

function getWorkerBaseUrl() {
  const host = String(process.env.VERCEL_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || '').trim();
  if (!host) return '';
  return `https://${host.replace(/^https?:\/\//i, '').replace(/\/$/, '')}`;
}

async function dispatchQueuedJob(jobId: string) {
  try {
    const baseUrl = getWorkerBaseUrl();
    if (baseUrl) {
      // إرسال الطلب بشكل صريح لمسار الـ API المخصص للـ worker لتفادي العودة بصفحة HTML (non-json)
      const workerUrl = `${baseUrl}/api/gemini/jobs?action=worker&id=${encodeURIComponent(jobId)}`;
      const workerToken = internalWorkerToken();
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetch(workerUrl, {
            method: 'GET',
            headers: { 'x-amin-job-worker': workerToken, 'cache-control': 'no-store' },
            signal: AbortSignal.timeout(8000),
          });
          const body = await response.json().catch(() => null);
          const acknowledged = response.ok && body?.jobId === jobId;
          if (acknowledged) return;
        } catch {
          // محاولة أخرى
        }
      }
    }
  } catch (error: any) {
    console.warn('Dispatch fallback triggered:', safeDiagnosticMessage(error?.message));
  }

  try {
    const claimed = await claimQueuedJob(jobId);
    if (claimed) startClaimedJob(claimed);
  } catch (error: any) {
    console.error('Queue dispatch failed:', safeDiagnosticMessage(error?.message));
  }
}

async function handleWorkerRequest(req: any, res: any) {
  // ضبط الـ Header لضمان إرجاع JSON دائماً ومنع خطأ non-json
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  
  if (!isInternalWorkerRequest(req)) {
    return res.status(401).json({ error: 'غير مصرح بتشغيل عامل المهام.' });
  }
  const jobId = String(req?.query?.id || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) {
    return res.status(400).json({ error: 'معرّف المهمة غير صالح.' });
  }

  try {
    const job = await loadQueueJob(jobId);
    if (!job) return res.status(404).json({ error: 'لم يتم العثور على المهمة في الطابور.' });
    if (job.status !== 'queued') {
      return res.status(200).json({ jobId, status: job.status, alreadyClaimed: true });
    }

    const claimed = await claimQueuedJob(jobId);
    if (!claimed) {
      const latest = await loadQueueJob(jobId);
      return res.status(200).json({ jobId, status: latest?.status || 'queued', alreadyClaimed: true });
    }
    startClaimedJob(claimed);
    return res.status(200).json({ jobId, status: 'running' });
  } catch (error: any) {
    return res.status(503).json({ error: 'تعذر بدء عامل معالجة المهمة.' });
  }
}

async function processJob(jobId: string, userId: string, token: string, taskType: string, payload: Record<string, string>, originalReq: any) {
  let fullText = '';
  let pendingWrite = Promise.resolve();
  let persistedLength = 0;
  let streamError = '';
  let handlerJson: any = null;
  let phase = 'start';
  
  const heartbeat = setInterval(() => {
    void patchJob(jobId, userId, {}).catch(() => {});
  }, 30_000);

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
              pendingWrite = pendingWrite.then(() => patchJob(jobId, userId, { partial_result: snapshot })).catch(() => {});
            }
          } else if (event.type === 'error') {
            streamError = String(event.error || 'فشلت المهمة.');
          }
        } catch {}
      }
      return true;
    },
    end() { this.writableEnded = true; return this; },
  };

  try {
    phase = 'mark-running';
    await patchJob(jobId, userId, { status: 'running', error: null });
    if (taskType === 'ocr' && await isUserCancelledOcrJob(jobId, userId)) return;
    const fakeReq = {
      ...originalReq,
      method: 'POST',
      headers: { ...(originalReq?.headers || {}), authorization: `Bearer ${token}` },
      body: { ...payload, stream: true },
    };
    phase = 'run-handler';
    await TASK_HANDLERS[taskType](fakeReq, fakeRes);
    if (taskType === 'ocr' && await isUserCancelledOcrJob(jobId, userId)) return;
    phase = 'flush-partial-result';
    await pendingWrite;
    if (!fullText.trim() && taskType === 'ocr' && typeof handlerJson?.text === 'string') {
      fullText = handlerJson.text.trim();
    }
    // Legal chat returns a structured JSON response rather than streamed text.
    // Persist the complete response in the same durable job record for polling clients.
    if (!fullText.trim() && taskType === 'legal-chat' && fakeRes.statusCode < 400 && typeof handlerJson?.result === 'string' && handlerJson.result.trim()) {
      fullText = JSON.stringify(handlerJson);
    }

    if (fakeRes.statusCode >= 400 || streamError || !fullText.trim()) {
      const error = streamError || `تعذر إكمال المهمة (HTTP ${fakeRes.statusCode}).`;
      phase = 'persist-handler-failure';
      console.error('AI job handler returned failure:', JSON.stringify({ jobId, taskType, phase, statusCode: fakeRes.statusCode, error: safeDiagnosticMessage(error), hasPartialResult: Boolean(fullText.trim()) }));
      if (taskType === 'ocr') {
        const finalized = await finalizeOcrJob(jobId, userId, {
          status: 'failed', error, partial_result: fullText, payload: {}, completed_at: new Date().toISOString(),
        });
        if (!finalized) return;
      } else {
        await patchJob(jobId, userId, { status: 'failed', error, partial_result: fullText, payload: {} });
      }
      await sendCompletionPush(userId, jobId, taskType, 'failed', payload.fileName || '');
      return;
    }
    phase = 'persist-success';
    const completedAt = new Date().toISOString();
    const completionValues = {
      status: 'completed',
      result: fullText,
      partial_result: fullText,
      payload: {},
      error: null,
      completed_at: completedAt,
    };
    if (taskType === 'ocr') {
      const finalized = await finalizeOcrJob(jobId, userId, completionValues);
      if (!finalized) return;
    } else {
      await patchJob(jobId, userId, completionValues);
    }
    await sendCompletionPush(userId, jobId, taskType, 'completed', payload.fileName || '');
  } catch (err: any) {
    if (taskType === 'ocr' && await isUserCancelledOcrJob(jobId, userId)) return;
    await pendingWrite.catch(() => {});
    const message = String(err?.message || 'تعذر إكمال العملية.').slice(0, 1000);
    console.error('AI job processing failed:', JSON.stringify({ jobId, taskType, phase, error: safeDiagnosticMessage(message), hasPartialResult: Boolean(fullText.trim()) }));
    try {
      phase = 'persist-caught-failure';
      if (taskType === 'ocr') {
        const finalized = await finalizeOcrJob(jobId, userId, {
          status: 'failed', error: message, partial_result: fullText, payload: {}, completed_at: new Date().toISOString(),
        });
        if (!finalized) return;
      } else {
        await patchJob(jobId, userId, { status: 'failed', error: message, partial_result: fullText, payload: {} });
      }
      await sendCompletionPush(userId, jobId, taskType, 'failed', payload.fileName || '');
    } catch (persistError: any) {
      console.error('AI job failure could not be persisted:', JSON.stringify({ jobId, taskType, phase, error: safeDiagnosticMessage(persistError?.message || persistError) }));
    }
  } finally {
    clearInterval(heartbeat);
  }
}

export default async function handler(req: any, res: any) {
  try {
    if (req.method === 'GET' && String(req?.query?.action || '') === 'worker') {
      return await handleWorkerRequest(req, res);
    }

    if (req.method === 'POST') {
      const requestBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
      if (requestBody?.action === 'subscribe-push') {
        const { session } = requireSession(req);
        await savePushSubscription(session.userId, requestBody.subscription);
        return res.status(200).json({ subscribed: true });
      }
      const { session } = await requireActiveSession(req);
      if (requestBody?.action === 'cancel-ocr') {
        const jobId = String(requestBody?.jobId || '').trim();
        if (!/^[0-9a-f-]{36}$/i.test(jobId)) return res.status(400).json({ error: 'معرّف المهمة غير صالح.' });
        const cancelled = await supabase(
          `${JOB_TABLE}?id=eq.${encodeURIComponent(jobId)}&user_id=eq.${encodeURIComponent(session.userId)}&task_type=eq.ocr&status=not.in.(completed,failed)`,
          {
            method: 'PATCH',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify({
              status: 'failed',
              error: USER_CANCELLED_OCR_MESSAGE,
              payload: {},
              updated_at: new Date().toISOString(),
              completed_at: new Date().toISOString(),
            }),
          },
        );
        if (!cancelled.ok) return res.status(503).json({ error: 'تعذر إلغاء مهمة OCR على الخادم.' });
        const changedRows = await cancelled.json().catch(() => []);
        if (Array.isArray(changedRows) && changedRows.length) return res.status(200).json({ cancelled: true });
        const existingResponse = await supabase(
          `${JOB_TABLE}?select=status,error&id=eq.${encodeURIComponent(jobId)}&user_id=eq.${encodeURIComponent(session.userId)}&task_type=eq.ocr&limit=1`,
        );
        if (!existingResponse.ok) return res.status(503).json({ error: 'تعذر التحقق من حالة مهمة OCR.' });
        const existingRows = await existingResponse.json();
        const existing = Array.isArray(existingRows) ? existingRows[0] : null;
        if (!existing) return res.status(404).json({ error: 'لم يتم العثور على مهمة OCR لهذا الحساب.' });
        return res.status(200).json({
          cancelled: existing.status === 'failed' && existing.error === USER_CANCELLED_OCR_MESSAGE,
          status: existing.status,
        });
      }
      const taskType = String(requestBody?.taskType || 'counter-brief');
      const payload = safePayload(requestBody?.payload || requestBody, taskType);
      
      scheduleBackground((async () => {
        try {
          await supabase(`${JOB_TABLE}?task_type=neq.ocr&status=in.(completed,failed)&created_at=lt.${encodeURIComponent(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())}`, { method: 'DELETE' });
        } catch {}
      })());

      const requestedId = String(requestBody?.jobId || '').trim();
      const id = /^[0-9a-f-]{36}$/i.test(requestedId) ? requestedId : crypto.randomUUID();
      // Keep the stored task_type compatible with existing production DB constraints.
      // The actual handler for legal chat is recorded in payload._actualTaskType.
      const storedTaskType = taskType === 'legal-chat' ? 'refine' : taskType;
      const insert = await supabase(JOB_TABLE, {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        signal: AbortSignal.timeout(taskType === 'ocr' ? 60_000 : 10_000),
        body: JSON.stringify({
          id,
          user_id: session.userId,
          task_type: storedTaskType,
          status: 'queued',
          payload,
          partial_result: '',
          result: '',
          error: null,
        }),
      });
      if (!insert.ok) {
        const existingRes = await supabase(`${JOB_TABLE}?select=id,status&id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(session.userId)}&limit=1`);
        if (existingRes.ok) {
          const existingRows = await existingRes.json();
          const existing = Array.isArray(existingRows) ? existingRows[0] : null;
          if (existing?.id) {
            if (existing.status === 'queued') scheduleBackground(dispatchQueuedJob(existing.id));
            return res.status(202).json({ jobId: existing.id, status: existing.status || 'queued' });
          }
        }
        return res.status(503).json({ error: 'تعذر حفظ مهمة الصياغة على الخادم.' });
      }

      scheduleBackground(dispatchQueuedJob(id));
      return res.status(202).json({ jobId: id, status: 'queued' });
    }

    if (req.method === 'GET') {
      const session = requireSession(req);
      if (String(req?.query?.action || '') === 'push-public-key') {
        const publicKey = (process.env.VAPID_PUBLIC_KEY || '').trim();
        if (!publicKey) return res.status(503).json({ error: 'إعدادات إشعارات الإنجاز غير مكتملة.' });
        return res.status(200).json({ publicKey });
      }
      const id = String(req?.query?.id || '').trim();
      if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'معرّف المهمة غير صالح.' });
      const jobPath = `${JOB_TABLE}?select=id,status,partial_result,result,error,created_at,updated_at,completed_at&id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(session.userId)}&limit=1`;
      const result = await supabase(jobPath);
      if (!result.ok) return res.status(503).json({ error: 'تعذر استرجاع حالة المهمة.' });
      const rows = await result.json();
      let job = Array.isArray(rows) ? rows[0] : null;
      if (!job) return res.status(404).json({ error: 'لم يتم العثور على المهمة.' });

      if (job.status === 'queued') scheduleBackground(dispatchQueuedJob(id));

      const lastActivityAt = Date.parse(String(job.updated_at || job.created_at || ''));
      if (job.status === 'running' && Number.isFinite(lastActivityAt) && Date.now() - lastActivityAt >= JOB_STALE_TIMEOUT_MS) {
        const staleError = 'توقفت المعالجة بعد عدم وصول أي تحديث.';
        try {
          await patchJob(id, session.userId, { status: 'failed', error: staleError, partial_result: job.partial_result || '', payload: {} });
          const refreshed = await supabase(jobPath);
          const refreshedRows = await refreshed.json();
          job = Array.isArray(refreshedRows) ? refreshedRows[0] : job;
        } catch {}
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
    return res.status(status).json({ error: err?.message || 'تعذر معالجة الطلب.' });
  }
}
