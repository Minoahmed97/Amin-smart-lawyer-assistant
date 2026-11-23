import { waitUntil } from '@vercel/functions';
import { send } from '@vercel/queue';
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
const OCR_STORAGE_BUCKET = 'amin-ocr-private';
const MAX_OCR_FILE_BYTES = 50 * 1024 * 1024;
const MAX_OCR_BATCH_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_FACTS = 900_000;
const MAX_CONTEXT = 300_000;
const JOB_STALE_TIMEOUT_MS = 5 * 60 * 1000 + 20 * 1000;
const USER_CANCELLED_OCR_MESSAGE = 'ألغى المستخدم معالجة الملف.';

function safeDiagnosticMessage(value: unknown) {
  return String(value || 'unknown')
    .replace(/(?:AIza|AQ\.)[0-9A-Za-z_.-]{20,}/g, '[REDACTED_API_KEY]')
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

function getSupabaseStorageHeaders(contentType = 'application/json') {
  const { key } = getSupabaseConfig();
  const headers: Record<string, string> = { apikey: key, 'Content-Type': contentType };
  if (!key.startsWith('sb_')) headers.Authorization = `Bearer ${key}`;
  return headers;
}

async function ensureOcrStorageBucket() {
  const { url } = getSupabaseConfig();
  const headers = getSupabaseStorageHeaders();
  const existing = await fetch(`${url}/storage/v1/bucket/${OCR_STORAGE_BUCKET}`, {
    method: 'GET', headers, signal: AbortSignal.timeout(10000),
  });
  if (existing.ok) {
    const update = await fetch(`${url}/storage/v1/bucket/${OCR_STORAGE_BUCKET}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ file_size_limit: MAX_OCR_FILE_BYTES }),
      signal: AbortSignal.timeout(10000),
    });
    if (!update.ok) {
      const detail = await update.text().catch(() => '');
      throw new Error(`تعذر زيادة حد تخزين ملفات القضايا (${update.status})${detail ? `: ${detail.slice(0, 160)}` : ''}`);
    }
    return;
  }
  const response = await fetch(`${url}/storage/v1/bucket`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ id: OCR_STORAGE_BUCKET, name: OCR_STORAGE_BUCKET, public: false, file_size_limit: MAX_OCR_FILE_BYTES, allowed_mime_types: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/jpeg', 'image/png', 'image/webp', 'image/bmp'] }),
    signal: AbortSignal.timeout(10000),
  });
  if (response.ok || response.status === 409) return;
  const detail = await response.text().catch(() => '');
  if (/already exists|duplicate|exists/i.test(detail)) return;
  throw new Error(`تعذر تجهيز تخزين ملفات OCR (${response.status})${detail ? `: ${detail.slice(0, 160)}` : ''}`);
}

async function createOcrUploadUrl(userId: string, jobId: string, fileName: string, mimeType: string) {
  const { url } = getSupabaseConfig();
  await ensureOcrStorageBucket();
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120) || 'document.pdf';
  const objectPath = `${userId}/${jobId}/${safeName}`;
  const response = await fetch(`${url}/storage/v1/object/upload/sign/${OCR_STORAGE_BUCKET}/${objectPath.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'POST', headers: getSupabaseStorageHeaders(), body: JSON.stringify({}), signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`تعذر إنشاء رابط رفع ملف OCR (${response.status}).`);
  const data = await response.json();
  const signedUrl = String(data?.url || data?.signedURL || '');
  if (!signedUrl) throw new Error('لم يُرجع التخزين رابط رفع صالحًا.');
  return { objectPath, signedUrl: /^https?:\/\//i.test(signedUrl) ? signedUrl : `${url}/storage/v1${signedUrl.startsWith('/') ? '' : '/'}${signedUrl}` };
}

async function downloadOcrObjectAsBase64(objectPath: string): Promise<string> {
  const { url } = getSupabaseConfig();
  const encodedPath = objectPath.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(`${url}/storage/v1/object/${OCR_STORAGE_BUCKET}/${encodedPath}`, { headers: getSupabaseStorageHeaders('application/octet-stream'), signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`تعذر استرجاع ملف PDF من التخزين (${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_OCR_FILE_BYTES) throw new Error('حجم ملف OCR غير صالح أو يتجاوز 50 ميجابايت.');
  return bytes.toString('base64');
}

async function deleteOcrObject(objectPath: string) {
  if (!objectPath) return;
  const { url } = getSupabaseConfig();
  const response = await fetch(`${url}/storage/v1/object/${OCR_STORAGE_BUCKET}`, {
    method: 'DELETE', headers: getSupabaseStorageHeaders(), body: JSON.stringify({ prefixes: [objectPath] }), signal: AbortSignal.timeout(10000),
  });
  if (!response.ok && response.status !== 404) throw new Error(`تعذر حذف ملف OCR المؤقت (${response.status}).`);
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
    const hasBatchImages = typeof input?.images === 'string' && input.images.length > 0;
    if (hasBatchImages) {
      limitBodyString(input.images, 28 * 1024 * 1024, 'صور صفحات PDF');
      let images: any;
      try { images = JSON.parse(input.images); } catch {
        const error: any = new Error('بيانات صور صفحات PDF غير صالحة.'); error.statusCode = 400; throw error;
      }
      const batchMime = String(input?.mimeType || '').toLowerCase();
      const batchName = String(input?.fileName || '').trim();
      if (!Array.isArray(images) || images.length < 1 || images.length > 100 || batchMime !== 'application/pdf' || !/\.pdf$/i.test(batchName)) {
        const error: any = new Error('مجموعة صور صفحات PDF غير صالحة.'); error.statusCode = 400; throw error;
      }
      let totalBytes = 0;
      const normalizedImages = images.map((image: any) => {
        const pageNumber = Number(image?.pageNumber);
        const imageMime = String(image?.mimeType || '').toLowerCase();
        if (!Number.isInteger(pageNumber) || pageNumber < 1 || !['image/jpeg', 'image/png', 'image/webp', 'image/bmp'].includes(imageMime)) {
          const error: any = new Error('بيانات إحدى صور صفحات PDF غير صالحة.'); error.statusCode = 400; throw error;
        }
        const base64 = validateBase64Payload(image?.base64Data, MAX_OCR_FILE_BYTES);
        const bytes = Math.floor(base64.length * 3 / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
        totalBytes += bytes;
        if (totalBytes > MAX_OCR_BATCH_IMAGE_BYTES) {
          const error: any = new Error('حجم صور صفحات PDF بعد الضغط أكبر من الحد الآمن للإرسال.'); error.statusCode = 413; throw error;
        }
        return { pageNumber, mimeType: imageMime, base64Data: base64 };
      }).sort((a: any, b: any) => a.pageNumber - b.pageNumber);
      payload.images = JSON.stringify(normalizedImages);
      limitBodyString(payload.pageTexts || '[]', 2 * 1024 * 1024, 'النصوص القابلة للتحديد في PDF');
      let pageTexts: any;
      try { pageTexts = JSON.parse(payload.pageTexts || '[]'); } catch {
        const error: any = new Error('النصوص القابلة للتحديد في PDF غير صالحة.'); error.statusCode = 400; throw error;
      }
      if (!Array.isArray(pageTexts)) {
        const error: any = new Error('قائمة صفحات النص في PDF غير صالحة.'); error.statusCode = 400; throw error;
      }
      for (const page of pageTexts) {
        if (!Number.isInteger(Number(page?.pageNumber)) || Number(page.pageNumber) < 1 || typeof page?.text !== 'string') {
          const error: any = new Error('بيانات صفحة نصية داخل PDF غير صالحة.'); error.statusCode = 400; throw error;
        }
        limitBodyString(page.text, 100000, 'نص صفحة PDF');
      }
      payload.pageTexts = JSON.stringify(pageTexts.sort((a: any, b: any) => Number(a.pageNumber) - Number(b.pageNumber)));
      delete payload.base64Data;
      delete payload.storagePath;
    } else {
      const hasStoragePath = typeof input?.storagePath === 'string' && input.storagePath.length > 0;
      if (hasStoragePath) {
        payload.storagePath = String(input.storagePath);
        if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[a-zA-Z0-9._-]{1,120}$/i.test(payload.storagePath)) {
          const error: any = new Error('مسار ملف OCR غير صالح.');
          error.statusCode = 400;
          throw error;
        }
      } else {
        payload.base64Data = validateBase64Payload(payload.base64Data, MAX_OCR_FILE_BYTES);
      }
    }
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
  // This field is injected only from the trusted persisted job record, never from client input.
  delete payload._resumePartialText;
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

function isPdfOcrPayload(taskType: string, payload: Record<string, string>) {
  return taskType === 'ocr' && (
    String(payload.mimeType || '').toLowerCase() === 'application/pdf' ||
    typeof payload.storagePath === 'string' ||
    typeof payload.images === 'string'
  );
}

function scheduleBackground(task: Promise<unknown>) {
  try {
    waitUntil(task);
  } catch {
    void task;
  }
}

async function enqueueDurableAiJob(jobId: string): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await send('amin-ai-jobs', { jobId });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
    }
  }
  const message = safeDiagnosticMessage((lastError as any)?.message || lastError);
  throw new Error(`تعذر إدخال المهمة إلى طابور المعالجة الدائم بعد ثلاث محاولات: ${message}`);
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
  delete payload._resumePartialText;
  if (storedTaskType !== 'ocr' && typeof job?.partial_result === 'string' && job.partial_result.trim()) {
    payload._resumePartialText = job.partial_result;
  }
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

/** Durable Vercel Queue consumer entry: claim and await the existing job pipeline. */
export async function runDurableQueuedJob(jobId: string): Promise<void> {
  let job = await loadQueueJob(jobId);
  if (!job) return;

  // Recover a job whose previous function invocation was terminated by its
  // platform execution limit. A live worker refreshes updated_at every 30s,
  // so only a genuinely stale running record is eligible for reclamation.
  if (job.status === 'running') {
    const updatedAt = Date.parse(String(job.updated_at || ''));
    if (!Number.isFinite(updatedAt) || Date.now() - updatedAt < JOB_STALE_TIMEOUT_MS) return;
    const requeued = await supabase(
      `${JOB_TABLE}?id=eq.${encodeURIComponent(jobId)}&status=eq.running&updated_at=lt.${encodeURIComponent(new Date(Date.now() - JOB_STALE_TIMEOUT_MS).toISOString())}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ status: 'queued', error: null, updated_at: new Date().toISOString() }),
      },
    );
    if (!requeued.ok) throw new Error(`تعذر استعادة المهمة المتوقفة (${requeued.status}).`);
    const rows = await requeued.json();
    if (!Array.isArray(rows) || !rows.length) return;
    job = rows[0];
  }
  if (job.status !== 'queued') return;
  const claimed = await claimQueuedJob(jobId);
  if (!claimed) return;
  const userId = String(claimed.user_id || '');
  const storedTaskType = String(claimed.task_type || '');
  const payload = toPayload(claimed.payload);
  delete payload._resumePartialText;
  if (storedTaskType !== 'ocr' && typeof claimed?.partial_result === 'string' && claimed.partial_result.trim()) {
    payload._resumePartialText = claimed.partial_result;
  }
  const taskType = payload._actualTaskType === 'legal-chat' ? 'legal-chat' : storedTaskType;
  delete payload._actualTaskType;
  if (!userId || !TASK_HANDLERS[taskType]) {
    await patchJob(jobId, userId, { status: 'failed', error: 'بيانات المهمة المحفوظة غير صالحة.', payload: {} });
    return;
  }
  const token = createSession(userId, 'background-worker', 10 * 60 * 1000);
  const workerReq = {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'Amin-AI-Durable-Queue-Worker',
      'x-forwarded-for': `worker-${userId}`,
    },
    body: payload,
    query: {},
  };
  await processJob(jobId, userId, token, taskType, payload, workerReq);
}

async function loadQueueJob(jobId: string) {
  const response = await supabase(`${JOB_TABLE}?select=id,user_id,task_type,payload,status,updated_at,partial_result&id=eq.${encodeURIComponent(jobId)}&limit=1`);
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

async function retryTransientOcrJob(jobId: string, userId: string, payload: Record<string, string>, error: unknown): Promise<boolean> {
  const message = String((error as any)?.message || error || '');
  const status = Number((error as any)?.statusCode || (error as any)?.status || (message.match(/"code"\s*:\s*(\d{3})/) || [])[1] || 0);
  const retryable = [408, 429, 500, 502, 503, 504].includes(status) ||
    /deadline.?exceeded|deadline expired|timed?\s*out|temporarily unavailable|network|fetch failed|econnreset|socket hang up/i.test(message);
  const attempts = Math.max(0, Number(payload._ocrRetryCount || 0));
  if (!retryable || attempts >= 2) return false;

  const nextPayload = { ...payload, _ocrRetryCount: String(attempts + 1) };
  const response = await supabase(
    `${JOB_TABLE}?id=eq.${encodeURIComponent(jobId)}&user_id=eq.${encodeURIComponent(userId)}&task_type=eq.ocr&status=eq.running`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        status: 'queued',
        error: `تعذرت المحاولة مؤقتاً (HTTP ${status || 'غير محدد'}). ستُعاد معالجة الملف تلقائياً دون حذفه.`,
        payload: nextPayload,
        updated_at: new Date().toISOString(),
      }),
    },
  );
  if (!response.ok) throw new Error(`تعذر إعادة مهمة OCR إلى الطابور (${response.status}).`);
  const rows = await response.json().catch(() => []);
  if (!Array.isArray(rows) || !rows.length) return false;
  try {
    await send('amin-ai-jobs', { jobId });
  } catch (queueError: any) {
    // The job is already safely queued in the database; use the existing
    // dispatcher rather than turning a queue transport hiccup into failure.
    scheduleBackground(dispatchQueuedJob(jobId));
    console.warn('OCR retry queue delivery deferred:', safeDiagnosticMessage(queueError?.message || queueError));
  }
  return true;
}

async function processJob(jobId: string, userId: string, token: string, taskType: string, payload: Record<string, string>, originalReq: any) {
  let fullText = typeof payload._resumePartialText === 'string' ? payload._resumePartialText : '';
  let persistedLength = fullText.length;
  let pendingWrite = Promise.resolve();
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
            // Persist every legal-drafting chunk immediately. Preserve the existing
            // OCR/other-task batching behavior to keep this change scoped to drafting.
            if (taskType !== 'ocr' || fullText.length - persistedLength >= 800) {
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
    if (taskType === 'ocr' && payload.storagePath) {
      payload.base64Data = await downloadOcrObjectAsBase64(payload.storagePath);
    }
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
        if (await retryTransientOcrJob(jobId, userId, payload, error)) return;
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
        if (await retryTransientOcrJob(jobId, userId, payload, message)) return;
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
    // Advance image OCR batches on the server; this continues even after the browser closes.
    if (taskType === 'ocr' && /^[0-9a-f-]{36}$/i.test(String(payload.nextJobId || ''))) {
      try {
        const finished = await loadQueueJob(jobId);
        if (finished && ['completed', 'failed'].includes(String(finished.status))) {
          let queued = false;
          for (let attempt = 0; attempt < 4 && !queued; attempt += 1) {
            try {
              await send('amin-ai-jobs', { jobId: String(payload.nextJobId) });
              queued = true;
            } catch (queueError: any) {
              if (attempt === 3) throw queueError;
              await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
            }
          }
        }
      } catch (advanceError: any) {
        // The current OCR result is already safely stored; leave diagnostics for
        // the next status check rather than converting a completed OCR into failure.
        console.error('Could not advance the sequential OCR image queue:', safeDiagnosticMessage(advanceError?.message || advanceError));
      }
    }
    if (taskType === 'ocr' && payload.storagePath) {
      // Keep the original upload while a transient failure has re-queued this job.
      const latest = await loadQueueJob(jobId).catch(() => null);
      if (latest && ['completed', 'failed'].includes(String(latest.status))) {
        await deleteOcrObject(payload.storagePath).catch((error: any) => {
          console.warn('Temporary OCR file cleanup skipped:', safeDiagnosticMessage(error?.message || error));
        });
      }
    }
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
        const session = requireSession(req);
        await savePushSubscription(session.userId, requestBody.subscription);
        return res.status(200).json({ subscribed: true });
      }
      const { session } = await requireActiveSession(req);
      if (requestBody?.action === 'prepare-ocr-upload') {
        const jobId = String(requestBody?.jobId || '').trim();
        const fileName = String(requestBody?.fileName || '').trim();
        const mimeType = String(requestBody?.mimeType || '').toLowerCase();
        const fileSize = Number(requestBody?.fileSize || 0);
        if (!/^[0-9a-f-]{36}$/i.test(jobId)) return res.status(400).json({ error: 'معرّف المهمة غير صالح.' });
        if (!fileName || !/\.(pdf|doc|docx|jpe?g|png|webp|bmp)$/i.test(fileName) || !Number.isFinite(fileSize) || fileSize < 1 || fileSize > MAX_OCR_FILE_BYTES) {
          return res.status(413).json({ error: 'حجم الملف أو صيغته غير مدعومين. الحد الأقصى 50 ميجابايت.' });
        }
        const allowedMimeTypes = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'application/octet-stream'];
        if (mimeType && !allowedMimeTypes.includes(mimeType)) return res.status(400).json({ error: 'نوع الملف غير مدعوم.' });
        const upload = await createOcrUploadUrl(session.userId, jobId, fileName, mimeType || 'application/octet-stream');
        return res.status(200).json(upload);
      }
      if (requestBody?.action === 'enqueue-ocr-batch') {
        const rawIds = Array.isArray(requestBody?.jobIds) ? requestBody.jobIds : [];
        const jobIds = rawIds.map((value: unknown) => String(value || '').trim());
        if (!jobIds.length || jobIds.length > 100 || jobIds.some((id: string) => !/^[0-9a-f-]{36}$/i.test(id)) || new Set(jobIds).size !== jobIds.length) {
          return res.status(400).json({ error: 'قائمة مهام الصور غير صالحة.' });
        }

        const jobs: any[] = [];
        const missingJobIds: string[] = [];
        for (const id of jobIds) {
          const job = await loadQueueJob(id);
          // A local IndexedDB record can outlive a server insert that never
          // committed. Let the client restore the original blob and recreate
          // this same idempotent job instead of aborting the entire image batch.
          if (!job) {
            missingJobIds.push(id);
            continue;
          }
          if (job.user_id !== session.userId || job.task_type !== 'ocr') {
            return res.status(404).json({ error: 'إحدى مهام الصور لا تخص هذا الحساب أو ليست مهمة OCR.' });
          }
          if (job.status === 'failed' || job.status === 'completed') continue;
          if (!['queued', 'running'].includes(String(job.status))) {
            return res.status(409).json({ error: 'إحدى مهام الصور ليست جاهزة للتشغيل.' });
          }
          jobs.push(job);
        }

        // A running first job already owns the batch chain written before its
        // first delivery. Do not dispatch later images concurrently on refresh.
        if (jobs.some((job) => job.status === 'running')) {
          return res.status(202).json({ queued: true, alreadyRunning: true, count: jobIds.length });
        }

        const queuedJobs = jobs.filter((job) => job.status === 'queued');
        for (let index = 0; index < queuedJobs.length; index += 1) {
          const payload = toPayload(queuedJobs[index].payload);
          const nextJobId = queuedJobs[index + 1]?.id;
          if (nextJobId) payload.nextJobId = nextJobId;
          else delete payload.nextJobId;
          const updated = await supabase(
            `${JOB_TABLE}?id=eq.${encodeURIComponent(queuedJobs[index].id)}&user_id=eq.${encodeURIComponent(session.userId)}&task_type=eq.ocr&status=eq.queued`,
            {
              method: 'PATCH',
              headers: { Prefer: 'return=minimal' },
              body: JSON.stringify({ payload, updated_at: new Date().toISOString() }),
            },
          );
          if (!updated.ok) throw new Error('تعذر ربط مهام الصور بالتتابع على الخادم.');
        }

        if (queuedJobs.length) {
          await send('amin-ai-jobs', { jobId: queuedJobs[0].id });
        }
        return res.status(202).json({
          queued: true,
          count: jobIds.length,
          started: queuedJobs.length > 0,
          missingJobIds,
        });
      }
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
      const incomingPayload = requestBody?.payload || requestBody;
      // A missing draft row can be recreated after a browser/network interruption.
      // Seed the new durable row with the already-generated text so resuming the
      // same job never discards the partial Gemini output.
      const initialPartialResult = taskType !== 'ocr' && typeof incomingPayload?._resumePartialText === 'string'
        ? incomingPayload._resumePartialText
        : '';
      if (initialPartialResult) limitBodyString(initialPartialResult, MAX_FACTS, 'النص الجزئي المحفوظ');
      const safeInput = incomingPayload && typeof incomingPayload === 'object' ? { ...incomingPayload } : incomingPayload;
      if (safeInput && typeof safeInput === 'object') delete safeInput._resumePartialText;
      const payload = safePayload(safeInput, taskType);
      
      scheduleBackground((async () => {
        try {
          await supabase(`${JOB_TABLE}?task_type=neq.ocr&status=in.(completed,failed)&created_at=lt.${encodeURIComponent(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())}`, { method: 'DELETE' });
        } catch {}
      })());

      const requestedId = String(requestBody?.jobId || '').trim();
      const id = /^[0-9a-f-]{36}$/i.test(requestedId) ? requestedId : crypto.randomUUID();
      if (taskType === 'ocr' && payload.storagePath && !payload.storagePath.startsWith(`${session.userId}/${id}/`)) {
        return res.status(403).json({ error: 'ملف OCR لا يخص جلسة الحساب الحالية.' });
      }
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
          partial_result: initialPartialResult,
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
            if (existing.status === 'queued') {
              if (isPdfOcrPayload(taskType, payload)) {
                scheduleBackground(dispatchQueuedJob(existing.id));
              } else if (taskType !== 'ocr') {
                if (requestBody?.deferQueue !== true) await enqueueDurableAiJob(existing.id);
              } else if (requestBody?.deferQueue !== true) {
                await send('amin-ai-jobs', { jobId: existing.id });
              }
            }
            return res.status(202).json({ jobId: existing.id, status: existing.status || 'queued' });
          }
        }
        return res.status(503).json({ error: 'تعذر حفظ مهمة الصياغة على الخادم.' });
      }

      try {
        if (taskType === 'ocr') {
          // Keep the existing OCR dispatchers unchanged.
          if (isPdfOcrPayload(taskType, payload)) {
            scheduleBackground(dispatchQueuedJob(id));
          } else if (requestBody?.deferQueue !== true) {
            await send('amin-ai-jobs', { jobId: id });
          }
        } else if (requestBody?.deferQueue !== true) {
          // Legal analysis and drafting use the durable queue consumer.
          await enqueueDurableAiJob(id);
        }
      } catch (queueError: any) {
        const queueMessage = String((queueError as any)?.message || 'تعذر إدخال المهمة إلى الطابور الدائم.').slice(0, 500);
        await patchJob(id, session.userId, {
          status: 'failed',
          error: queueMessage,
          payload: {},
          completed_at: new Date().toISOString(),
        });
        throw new Error(queueMessage);
      }
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
      const jobPath = `${JOB_TABLE}?select=id,status,payload,partial_result,result,error,created_at,updated_at,completed_at&id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(session.userId)}&limit=1`;
      const result = await supabase(jobPath);
      if (!result.ok) return res.status(503).json({ error: 'تعذر استرجاع حالة المهمة.' });
      const rows = await result.json();
      let job = Array.isArray(rows) ? rows[0] : null;
      if (!job) return res.status(404).json({ error: 'لم يتم العثور على المهمة.' });

      // PDF OCR keeps the original Mino-ocr dispatcher; image OCR uses Vercel Queues.
      const isPdfJob = isPdfOcrPayload('ocr', toPayload(job.payload));

      const lastActivityAt = Date.parse(String(job.updated_at || job.created_at || ''));

      // A queued row can outlive a lost/undelivered queue message. Re-publish it
      // after 60 seconds using a conditional timestamp claim, so polling can
      // repair a stalled queue without creating a second generation job.
      if (job.status === 'queued' && Number.isFinite(lastActivityAt) && Date.now() - lastActivityAt >= 60_000) {
        const queuedAgain = await supabase(
          `${JOB_TABLE}?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(session.userId)}&status=eq.queued&updated_at=lt.${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}`,
          {
            method: 'PATCH',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify({ updated_at: new Date().toISOString() }),
          },
        );
        if (queuedAgain.ok) {
          const changedRows = await queuedAgain.json().catch(() => []);
          if (Array.isArray(changedRows) && changedRows.length) {
            if (job.task_type === 'ocr') {
              if (isPdfJob) scheduleBackground(dispatchQueuedJob(id));
              else await send('amin-ai-jobs', { jobId: id });
            } else {
              await enqueueDurableAiJob(id).catch((error) => {
                console.warn('Queued AI job redelivery deferred:', safeDiagnosticMessage((error as any)?.message || error));
              });
            }
          }
        }
      }

      if (job.status === 'running' && Number.isFinite(lastActivityAt) && Date.now() - lastActivityAt >= JOB_STALE_TIMEOUT_MS) {
        // Do not convert an interrupted background task into a terminal failure.
        // Return it to the durable queue so the same stored payload can resume.
        try {
          const requeued = await supabase(
            `${JOB_TABLE}?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(session.userId)}&status=eq.running&updated_at=lt.${encodeURIComponent(new Date(Date.now() - JOB_STALE_TIMEOUT_MS).toISOString())}`,
            {
              method: 'PATCH',
              headers: { Prefer: 'return=representation' },
              body: JSON.stringify({ status: 'queued', error: null, updated_at: new Date().toISOString() }),
            },
          );
          const changedRows = requeued.ok ? await requeued.json() : [];
          if (Array.isArray(changedRows) && changedRows.length) {
            if (job.task_type === 'ocr') {
              if (isPdfJob) scheduleBackground(dispatchQueuedJob(id));
              else await send('amin-ai-jobs', { jobId: id });
            } else {
              await enqueueDurableAiJob(id);
            }
          }
          const refreshed = await supabase(jobPath);
          const refreshedRows = await refreshed.json();
          job = Array.isArray(refreshedRows) ? refreshedRows[0] : job;
        } catch (recoveryError: any) {
          console.warn('Stale AI job recovery deferred:', safeDiagnosticMessage(recoveryError?.message || recoveryError));
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
    return res.status(status).json({ error: err?.message || 'تعذر معالجة الطلب.' });
  }
}
