import { getLawyerStyleContext } from '../utils/legalVaultService.ts';
import { getSessionToken } from './authService.ts';

// Throttling control to prevent burst requests
let lastRequestTimestamp = 0;
const MIN_REQUEST_INTERVAL_MS = 150;

async function throttleRequests(): Promise<void> {
  const now = Date.now();
  const timeSinceLast = now - lastRequestTimestamp;
  if (timeSinceLast < MIN_REQUEST_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MIN_REQUEST_INTERVAL_MS - timeSinceLast));
  }
  lastRequestTimestamp = Date.now();
}

function getRequestHeaders(): Record<string, string> {
  // Gemini credentials stay exclusively on the central server.
  // The AI endpoints require the user's existing central session token.
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const sessionToken = getSessionToken();
  if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
  return headers;
}

export function cleanDirectResponse(rawText: string): string {
  if (!rawText) return '';
  let text = rawText.trim();
  const introPatterns = [
    /^(?:[\s\*\#\-\>]*)(?:أهلاً|مرحباً|عزيزي|المحامي|إليك)[^\n]*\n+/i,
    /^(?:[\s\*\#\-\>]*)(?:بالطبع|بالتأكيد|حاضر|تمام|أكيد|يسعدني|بكل سرور)[،,:!؛\s]+(?:إليك|هذه|هذا|سأقوم|سأبدأ|سأكتب|سأعد|سأراجع|سأعمل|يمكنني|تفضل|تفضّل)?[^\n]*\n+/i,
    /^(?:[\s\*\#\-\>]*)(?:سأقوم لك|سأعمل لك|سأبدأ بـ|دعني أ|خليني أ|هنا صياغة|فيما يلي)[^\n]*\n+/i,
  ];
  for (const pattern of introPatterns) {
    text = text.replace(pattern, '').trim();
  }
  return text;
}

export function formatFriendlyLegalAiError(rawMsg: string): string {
  if (!rawMsg) return 'حدث خطأ غير متوقع...';
  if (rawMsg.includes('413') || rawMsg.includes('Payload Too Large')) {
    return 'حجم الملف كبير جداً، يرجى تقسيمه أو تقليله.';
  }
  return 'تعذر إتمام العملية حالياً، يرجى المحاولة لاحقاً...';
}


type SavedJobType = 'counter-brief' | 'deconstruct' | 'qualify' | 'refine' | 'ocr';

export interface SavedOcrJob {
  jobId: string;
  fileName: string;
  mimeType: string;
  status: 'pending' | 'completed' | 'failed';
  createdAt: string;
  error?: string;
}

function sanitizeStoragePart(value: string): string {
  return String(value || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function ocrJobsStorageKey(scope: string, userId?: string): string {
  return `amin_ai_ocr_jobs_${sanitizeStoragePart(scope)}_${sanitizeStoragePart(userId || 'default')}`;
}

function readSavedOcrJobs(scope: string, userId?: string): SavedOcrJob[] {
  try {
    const raw = localStorage.getItem(ocrJobsStorageKey(scope, userId));
    const rows = raw ? JSON.parse(raw) : [];
    return Array.isArray(rows) ? rows.filter((row) =>
      row && typeof row.jobId === 'string' && typeof row.fileName === 'string'
    ) as SavedOcrJob[] : [];
  } catch {
    return [];
  }
}

function writeSavedOcrJobs(scope: string, userId: string | undefined, rows: SavedOcrJob[]): void {
  try {
    if (rows.length) localStorage.setItem(ocrJobsStorageKey(scope, userId), JSON.stringify(rows));
    else localStorage.removeItem(ocrJobsStorageKey(scope, userId));
  } catch (error) {
    console.warn('OCR job recovery metadata could not be saved:', error);
  }
}

function upsertSavedOcrJob(scope: string, userId: string | undefined, job: SavedOcrJob): void {
  const rows = readSavedOcrJobs(scope, userId).filter((row) => row.jobId !== job.jobId);
  rows.push(job);
  writeSavedOcrJobs(scope, userId, rows);
}

function updateSavedOcrJob(scope: string, userId: string | undefined, jobId: string, status: SavedOcrJob['status'], error?: string): void {
  const rows = readSavedOcrJobs(scope, userId).map((row) => row.jobId === jobId ? { ...row, status, ...(error ? { error } : {}) } : row);
  writeSavedOcrJobs(scope, userId, rows);
}

export function getSavedOcrJobs(scope: string, userId?: string): SavedOcrJob[] {
  return readSavedOcrJobs(scope, userId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function acknowledgeSavedOcrJob(scope: string, userId: string | undefined, jobId: string): void {
  const rows = readSavedOcrJobs(scope, userId).filter((row) => row.jobId !== jobId);
  writeSavedOcrJobs(scope, userId, rows);
  const key = jobStorageKey('ocr', userId, scope);
  try {
    if (localStorage.getItem(key) === jobId) localStorage.removeItem(key);
  } catch {}
}


function makeJobId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {}
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function jobStorageKey(type: SavedJobType, userId?: string, storageScope?: string): string {
  const user = sanitizeStoragePart(userId || 'default');
  if (type === 'counter-brief') return `amin_judicial_draft_job_id_${user}`;
  if (type === 'ocr' && storageScope) return `amin_ai_job_ocr_${sanitizeStoragePart(storageScope)}_${user}`;
  return `amin_ai_job_${type}_${user}`;
}

interface PendingJobPayloadRecord {
  jobId: string;
  type: SavedJobType;
  payload: Record<string, any>;
  savedAt: string;
}

const PENDING_JOB_DB = 'amin-ai-pending-jobs';
const PENDING_JOB_STORE = 'payloads';
const pendingJobLocalKey = (jobId: string) => `amin_ai_pending_payload_${jobId}`;

function openPendingJobDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const request = indexedDB.open(PENDING_JOB_DB, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(PENDING_JOB_STORE)) db.createObjectStore(PENDING_JOB_STORE, { keyPath: 'jobId' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function savePendingJobPayload(record: PendingJobPayloadRecord): Promise<void> {
  // OCR payloads can contain large base64 files, so keep those in IndexedDB.
  // Smaller legal-task payloads are synchronously stored in localStorage so a
  // refresh cannot race ahead of saving the recovery data.
  if (record.type !== 'ocr') {
    try { localStorage.setItem(pendingJobLocalKey(record.jobId), JSON.stringify(record)); return; } catch {}
  }
  const db = await openPendingJobDb();
  if (!db) {
    // Small scans may fit localStorage on browsers where IndexedDB is blocked;
    // never try to put a large base64 image/PDF into localStorage.
    try {
      const serialized = JSON.stringify(record);
      if (serialized.length < 3_000_000) localStorage.setItem(pendingJobLocalKey(record.jobId), serialized);
    } catch {}
    return;
  }
  const saved = await new Promise<boolean>((resolve) => {
    try {
      const transaction = db.transaction(PENDING_JOB_STORE, 'readwrite');
      transaction.objectStore(PENDING_JOB_STORE).put(record);
      transaction.oncomplete = () => { db.close(); resolve(true); };
      transaction.onerror = () => { db.close(); resolve(false); };
      transaction.onabort = () => { db.close(); resolve(false); };
    } catch { try { db.close(); } catch {} resolve(false); }
  });
  if (!saved) {
    try {
      const serialized = JSON.stringify(record);
      if (serialized.length < 3_000_000) localStorage.setItem(pendingJobLocalKey(record.jobId), serialized);
    } catch {}
  }
}

async function readPendingJobPayload(jobId: string): Promise<PendingJobPayloadRecord | null> {
  try {
    const raw = localStorage.getItem(pendingJobLocalKey(jobId));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.jobId === jobId && parsed?.payload && typeof parsed.payload === 'object') return parsed as PendingJobPayloadRecord;
    }
  } catch {}
  const db = await openPendingJobDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const request = db.transaction(PENDING_JOB_STORE, 'readonly').objectStore(PENDING_JOB_STORE).get(jobId);
      request.onsuccess = () => {
        const value = request.result;
        db.close();
        resolve(value?.jobId === jobId && value?.payload && typeof value.payload === 'object' ? value as PendingJobPayloadRecord : null);
      };
      request.onerror = () => { db.close(); resolve(null); };
    } catch { try { db.close(); } catch {} resolve(null); }
  });
}

async function deletePendingJobPayload(jobId: string): Promise<void> {
  try { localStorage.removeItem(pendingJobLocalKey(jobId)); } catch {}
  const db = await openPendingJobDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const transaction = db.transaction(PENDING_JOB_STORE, 'readwrite');
      transaction.objectStore(PENDING_JOB_STORE).delete(jobId);
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onerror = () => { db.close(); resolve(); };
      transaction.onabort = () => { db.close(); resolve(); };
    } catch { try { db.close(); } catch {} resolve(); }
  });
}

async function enableCompletionPushNotifications(): Promise<void> {
  try {
    if (typeof window === 'undefined' || !('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
    // Fetch the public key from the backend so the browser and server always
    // use the same VAPID configuration; the private key never leaves the server.
    const keyResponse = await fetch('/api/gemini/jobs?action=push-public-key', {
      method: 'GET',
      headers: getRequestHeaders(),
      cache: 'no-store',
    });
    if (!keyResponse.ok) return;
    const keyData = await keyResponse.json().catch(() => ({}));
    const publicKey = String(keyData?.publicKey || '').trim();
    if (!publicKey) return;
    let permission = Notification.permission;
    if (permission === 'default') permission = await Notification.requestPermission();
    if (permission !== 'granted') return;
    const registration = await navigator.serviceWorker.register('/sw.js');
    const readyRegistration = await navigator.serviceWorker.ready;
    let subscription = await readyRegistration.pushManager.getSubscription();
    if (!subscription) {
      const padding = '='.repeat((4 - publicKey.length % 4) % 4);
      const base64 = (publicKey + padding).replace(/-/g, '+').replace(/_/g, '/');
      const raw = atob(base64);
      const applicationServerKey = Uint8Array.from(raw, (character) => character.charCodeAt(0));
      subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
    }
    const response = await fetch('/api/gemini/jobs', {
      method: 'POST',
      headers: getRequestHeaders(),
      body: JSON.stringify({ action: 'subscribe-push', subscription: subscription.toJSON() }),
    });
    if (!response.ok) console.warn('Could not save completion notification subscription.');
  } catch (error) {
    // Notification permission or push setup must never block the requested legal task.
    console.warn('Completion notifications are unavailable on this device/browser:', error);
  }
}

async function requestSavedJob<T extends Record<string, any>>(
  type: SavedJobType,
  payload: T,
  onChunk?: (text: string) => void,
  userId?: string,
  resumeId?: string,
  storageScope?: string,
  ocrMetadata?: { fileName: string; mimeType: string },
  forcedJobId?: string,
): Promise<string> {
  const key = jobStorageKey(type, userId, storageScope);
  const storage = typeof localStorage !== 'undefined' ? localStorage : null;
  // Each manual task gets a fresh ID. Save its payload before exposing the ID so
  // refresh recovery can safely re-submit the exact same idempotent job if the
  // browser closes before the first POST reaches the server.
  const jobId = resumeId || forcedJobId || makeJobId();
  let effectivePayload: T = payload;
  let savedPayloadRecord: PendingJobPayloadRecord | null = null;
  if (resumeId) {
    savedPayloadRecord = await readPendingJobPayload(jobId);
    if (savedPayloadRecord?.type === type) effectivePayload = savedPayloadRecord.payload as T;
  } else {
    await savePendingJobPayload({ jobId, type, payload, savedAt: new Date().toISOString() });
  }
  if (storage) storage.setItem(key, jobId);
  if (type === 'ocr' && storageScope && ocrMetadata && !resumeId) {
    upsertSavedOcrJob(storageScope, userId, {
      jobId,
      fileName: ocrMetadata.fileName,
      mimeType: ocrMetadata.mimeType,
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
  }
  const clearJobReference = () => {
    if (storage?.getItem(key) === jobId) storage.removeItem(key);
    void deletePendingJobPayload(jobId);
    if (type === 'ocr' && storageScope) {
      writeSavedOcrJobs(storageScope, userId, readSavedOcrJobs(storageScope, userId).filter((row) => row.jobId !== jobId));
    }
  };

  const headers = getRequestHeaders();
  let created = false;
  // Resume paths re-submit the same job ID when the exact payload is available.
  // The server's unique job ID makes this idempotent: an existing job is reused.
  const shouldSubmit = !resumeId || Boolean(savedPayloadRecord && savedPayloadRecord.type === type);
  if (shouldSubmit) {
    if (!resumeId) void enableCompletionPushNotifications();
    let receivedHttpResponse = false;
    try {
      const createResponse = await fetch('/api/gemini/jobs', {
        method: 'POST',
        headers,
        body: JSON.stringify({ taskType: type, payload: effectivePayload, jobId }),
      });
      receivedHttpResponse = true;
      if (!createResponse.ok) {
        const error = await createResponse.json().catch(() => ({}));
        // A 5xx can mean the server accepted the request but lost the response;
        // continue polling the same ID before declaring the task unavailable.
        if (createResponse.status < 500 && createResponse.status !== 408) {
          if (!resumeId) clearJobReference();
          throw new Error(error?.error || `تعذر حفظ المهمة (${createResponse.status}).`);
        }
        if (!storage?.getItem(key)) throw new Error(error?.error || `تعذر حفظ المهمة (${createResponse.status}).`);
      } else {
        created = true;
      }
    } catch (err: any) {
      // An HTTP/application error is authoritative; only a transport failure can
      // mean the server accepted the idempotent POST but its response was lost.
      if (receivedHttpResponse) throw err;
      if (!storage?.getItem(key)) throw err;
      // Keep the saved payload and continue polling the same durable job.
    }
  }

  let lastText = '';
  let transientFailures = 0;
  const startedAt = Date.now();
  const NO_PROGRESS_TIMEOUT_MS = 4 * 60 * 1000 + 30 * 1000;
  let lastProgressAt = Date.now();
  let lastUpdatedAt = '';
  while (Date.now() - startedAt < 1000 * 60 * 20) {
    try {
      const response = await fetch(`/api/gemini/jobs?id=${encodeURIComponent(jobId)}`, {
        method: 'GET',
        headers,
        cache: 'no-store',
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        const failure: any = new Error(
          error?.error || (response.status === 404
            ? 'لم يتم العثور على المهمة المحفوظة لهذا الحساب.'
            : `تعذر استرجاع حالة المهمة (${response.status}).`),
        );
        failure.statusCode = response.status;
        throw failure;
      }
      const data = await response.json();
      transientFailures = 0;
      const currentText = String(data?.partialResult || data?.result || '');
      const updatedAt = String(data?.updatedAt || '');
      if ((currentText.length > lastText.length) || (updatedAt && updatedAt !== lastUpdatedAt)) {
        lastProgressAt = Date.now();
      }
      if (updatedAt) lastUpdatedAt = updatedAt;
      if (currentText.length > lastText.length && currentText.startsWith(lastText)) {
        const delta = currentText.slice(lastText.length);
        if (delta && onChunk) onChunk(delta);
        lastText = currentText;
      } else if (currentText && !lastText) {
        if (onChunk) onChunk(currentText);
        lastText = currentText;
      }

      if (data.status === 'completed') {
        const result = String(data.result || lastText);
        // Refinement keeps its job ID until DraftingView persists the returned
        // document, closing the small refresh window between server completion
        // and the component's result-save callback.
        if (type !== 'refine') void deletePendingJobPayload(jobId);
        if (type === 'ocr' && storageScope) updateSavedOcrJob(storageScope, userId, jobId, 'completed');
        else if (storage && type !== 'refine') storage.removeItem(key);
        return result;
      }
      if (data.status === 'failed') {
        const failure: any = new Error(data.error || 'فشلت المهمة المحفوظة.');
        failure.terminalJobError = true;
        failure.jobId = jobId;
        if (type === 'ocr' && storageScope) updateSavedOcrJob(storageScope, userId, jobId, 'failed', failure.message);
        else clearJobReference();
        throw failure;
      }
      if (Date.now() - lastProgressAt >= NO_PROGRESS_TIMEOUT_MS) {
        const failure: any = new Error('لم يصل أي تحديث للمهمة خلال 4 دقائق ونصف. توقفت متابعة الانتظار، واحتُفظ بمعرّفها لمحاولة استعادة حالتها دون بدء توليد جديد.');
        failure.noProgressTimeout = true;
        failure.savedJobPending = type === 'ocr';
        throw failure;
      }
    } catch (err: any) {
      const statusCode = Number(err?.statusCode);
      const permanentClientError = statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429;
      if (err?.noProgressTimeout || err?.terminalJobError || permanentClientError || (err?.message && /فشلت المهمة المحفوظة|لم يتم العثور على المهمة/.test(err.message))) {
        if (statusCode === 404) clearJobReference();
        throw err;
      }
      transientFailures++;
      if (transientFailures >= 8) {
        if (type === 'ocr') {
          // Keep attempting lightweight status checks while the page is open;
          // a temporary client/network outage must not discard the OCR watcher.
          transientFailures = 0;
          await new Promise((resolve) => setTimeout(resolve, 5000));
          continue;
        }
        const failure: any = new Error('انقطع الاتصال مؤقتًا. تم الاحتفاظ بمعرّف المهمة؛ ارجع للتطبيق وحاول استعادة نفس المهمة دون بدء توليد جديد.');
        failure.savedJobPending = false;
        throw failure;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  const failure: any = new Error('المهمة ما زالت قيد المعالجة. ارجع لاحقًا لاستعادة النتيجة المحفوظة دون بدء توليد جديد.');
  failure.savedJobPending = type === 'ocr';
  throw failure;
}

export async function resumeDraftCounterBrief(jobId: string, onChunk?: (text: string) => void, userId?: string): Promise<string> {
  return requestSavedJob('counter-brief', {}, onChunk, userId, jobId);
}


export async function resumeSavedAiTask(type: 'deconstruct' | 'qualify' | 'refine', jobId: string, onChunk?: (text: string) => void, userId?: string): Promise<string> {
  return requestSavedJob(type, {}, onChunk, userId, jobId);
}

export async function runSavedOcrTask( base64Data: string, mimeType: string, fileName: string, storageScope: string, userId?: string, ): Promise<{ text: string; jobId: string }> {
  const jobId = makeJobId();
  const text = await requestSavedJob(
    'ocr',
    { base64Data, mimeType, fileName, recoveryScope: sanitizeStoragePart(storageScope) },
    undefined,
    userId,
    undefined,
    storageScope,
    { fileName, mimeType },
    jobId,
  );
  return { text, jobId };
}

export async function resumeSavedOcrTask(jobId: string, storageScope: string, userId?: string): Promise<string> {
  return requestSavedJob('ocr', {}, undefined, userId, jobId, storageScope);
}

async function postWithSilentRetry( url: string, payload: any, maxRetries = 5, onChunk?: (text: string) => void ): Promise<any> {
  let lastError: any = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let streamStarted = false;
    try {
      // Use the stable JSON response path for legal generation. The current mobile
      // WebView intermittently drops long-lived SSE/NDJSON streams and reports
      // a generic network error even when the server-side handler is healthy.
      // Existing handlers support ordinary JSON requests as well.
      const requestPayload = payload;
      const response = await fetch(url, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(requestPayload),
      });

      if (response.ok && onChunk && response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const isSse = (response.headers.get('content-type') || '').toLowerCase().includes('text/event-stream');
        let buffer = '';
        let fullText = '';

        const processEvent = (raw: string) => {
          const lines = raw.split(/\r?\n/);
          const payload = isSse
            ? lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n').trim()
            : raw.trim();
          if (!payload) return;

          let event: any;
          try {
            event = JSON.parse(payload);
          } catch {
            return;
          }

          if (event.type === 'chunk' && typeof event.text === 'string') {
            streamStarted = true;
            fullText += event.text;
            onChunk(event.text);
          } else if (event.type === 'error') {
            throw new Error(event.error || 'فشلت الاستجابة المتدفقة.');
          }
        };

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const separator = isSse ? /\r?\n\r?\n/ : /\r?\n/;
          const parts = buffer.split(separator);
          buffer = parts.pop() || '';
          for (const part of parts) processEvent(part);
        }

        buffer += decoder.decode();
        if (buffer.trim()) processEvent(buffer);

        return { result: fullText };
      }

      if (response.ok) {
        const data = await response.json();
        if (onChunk && typeof data?.result === 'string' && data.result) {
          // Preserve the existing UI callback contract; deliver the completed
          // result once instead of progressive chunks.
          onChunk(data.result);
        }
        return data;
      }

      if (response.status === 429 || response.status >= 500) {
        if (attempt < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
          continue;
        }
      }

      const errorData = await response.json().catch(() => ({}));
      const responseError: any = new Error(errorData.error || `خطأ استجابة (${response.status})`);
      responseError.status = response.status;
      responseError.statusCode = response.status;
      throw responseError;
    } catch (err: any) {
      lastError = err;

      // Never restart an already visible stream, otherwise the user could see
      // duplicated legal text. Do not retry permanent HTTP/client errors such
      // as invalid input, missing session, or access denial.
      if (streamStarted) throw err;
      const status = Number(err?.status || err?.statusCode);
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        throw err;
      }

      // Retry transport failures and transient server/rate-limit responses only.
      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        continue;
      }
      if (!status && (err instanceof TypeError || /network|fetch|timeout|timed out|abort/i.test(String(err?.message || '')))) {
        throw new Error('تعذر الاتصال بالخادم المركزي للذكاء الاصطناعي. تحقق من اتصال الإنترنت ثم حاول مرة أخرى.');
      }
      throw err;
    }
  }

  throw lastError || new Error('فشلت محاولة الاتصال.');
}

const EGYPTIAN_LEGAL_SYSTEM_PROMPT = `أنت «أمين»؛ مساعد قانوني مصري شديد الدقة. اقرأ كامل المعلومات المقدمة قبل الإجابة، وحلل الوقائع والمستندات والتواريخ والطلبات والدفوع والتناقضات ونقاط القوة والضعف والثغرات الظاهرة والخفية. لا تخترع واقعة أو مستنداً أو مادة أو حكماً أو رقم طعن. ميّز بين الثابت والاستنتاج والرأي وما يحتاج تحققاً، واعرض البدائل القانونية عند وجودها. نفّذ مراجعة داخلية نهائية قبل الإخراج، وابدأ مباشرة دون تحية أو مقدمة عامة.`;

async function callDirectGeminiApi(_prompt: string, _systemInstruction = EGYPTIAN_LEGAL_SYSTEM_PROMPT): Promise<string> {
  throw new Error('تعذر الاتصال بالخادم المركزي للذكاء الاصطناعي.');
}

export async function deconstructBrief( params: { opponentBriefText: string; courtType?: string; caseNature?: string; judicialWorkType?: string; ourPosition?: string; additionalFacts?: string; userId?: string; }, onChunk?: (text: string) => void ): Promise<string> {
  await throttleRequests();
  const lawyerVaultContext = getLawyerStyleContext({
    courtType: params.courtType,
    judicialWorkType: params.judicialWorkType,
    factsOrSubject: params.opponentBriefText,
  }, params.userId);

  const payload = {
    opponentBriefText: params.opponentBriefText,
    courtType: params.courtType || '',
    caseNature: params.caseNature || '',
    judicialWorkType: params.judicialWorkType || '',
    ourPosition: params.ourPosition || '',
    additionalFacts: params.additionalFacts || '',
    vaultContext: lawyerVaultContext,
  };

  try {
    const result = await requestSavedJob('deconstruct', payload, onChunk, params.userId);
    return cleanDirectResponse(result);
  } catch (err: any) {
    throw new Error(err?.message || 'تعذر إتمام العملية عبر الخادم المركزي.');
  }
}

export async function draftCounterBrief(params: { courtType?: string; circuit?: string; briefType?: string; judicialWorkType?: string; customJudicialWorkType?: string; clientRole?: string; clientName?: string; opponentName?: string; caseNumber?: string; sessionDate?: string; facts: string; defenses?: string; requests?: string; customInstructions?: string; userId?: string; }, onChunk?: (text: string) => void ): Promise<string> {
  await throttleRequests();
  const effectiveWorkType =
    params.customJudicialWorkType?.trim()
      ? params.customJudicialWorkType.trim()
      : params.judicialWorkType || params.briefType || '';

  const lawyerVaultContext = getLawyerStyleContext({
    courtType: params.courtType,
    briefType: params.briefType,
    judicialWorkType: effectiveWorkType,
    factsOrSubject: params.facts,
  }, params.userId);

  try {
    const { userId: _userId, ...requestParams } = params;
    const result = await requestSavedJob('counter-brief', {
      ...requestParams,
      effectiveWorkType,
      vaultContext: lawyerVaultContext,
    }, onChunk, params.userId);
    return cleanDirectResponse(result);
  } catch (err: any) {
    throw new Error(err?.message || 'تعذر إتمام العملية عبر الخادم المركزي.');
  }
}

export async function qualifyLegalCase( disputeDetails: string, clientGoals?: string, onChunk?: (text: string) => void, userId?: string ): Promise<string> {
  await throttleRequests();

  try {
    // Legal qualification is an independent legal analysis; do not load or send
    // the lawyer's vault context for this task. Other drafting tasks still use it.
    const result = await requestSavedJob('qualify', {
      disputeDetails,
      clientGoals: clientGoals || '',
    }, onChunk, userId);
    return cleanDirectResponse(result);
  } catch (err: any) {
    throw new Error(err?.message || 'تعذر إتمام العملية عبر الخادم المركزي.');
  }
}

export async function refineDraftText( draftText: string, enhancementType: 'moreDecisive' | 'addPrecedents' | 'addProceduralDefenses' | 'auditCheck', onChunk?: (text: string) => void, userId?: string, forcedJobId?: string ): Promise<string> {
  await throttleRequests();
  const lawyerVaultContext = getLawyerStyleContext({
    factsOrSubject: draftText,
  }, userId);

  try {
    const result = await requestSavedJob('refine', {
      draftText,
      enhancementType,
      vaultContext: lawyerVaultContext,
    }, onChunk, userId, undefined, undefined, undefined, forcedJobId);
    return cleanDirectResponse(result);
  } catch (err: any) {
    throw new Error(err?.message || 'تعذر إتمام العملية عبر الخادم المركزي.');
  }
}
