import { GoogleGenAI } from '@google/genai';
import { sanitizeGeminiKey } from './centralKeys.ts';
import fs from 'fs';
import path from 'path';
import { fetchServerCloudGeminiKeys, fetchServerCloudOCRGeminiKeys, recordServerCloudGeminiKeyAttempt } from './supabaseSync.ts';

export function isValidGeminiApiKey(key: any): boolean {
  if (!key || typeof key !== 'string') return false;
  const clean = sanitizeGeminiKey(key);
  if (
    !clean ||
    clean === 'MY_GEMINI_API_KEY' ||
    clean.includes('MY_GEMINI') ||
    clean.includes('...') ||
    clean === 'undefined' ||
    clean === 'null' ||
    clean.length < 10
  ) {
    return false;
  }
  return true;
}

export const GEMINI_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
];

let activeKeyIndex = 0;
const permanentlyInvalidKeys = new Set<string>();
const permanentlyInvalidOCRKeys = new Set<string>();
const keyCooldownUntil = new Map<string, number>();
// Drafting skips the entire key only after Google explicitly confirms quota exhaustion.
const draftingQuotaKeyCooldownUntil = new Map<string, number>();
const keyModelCooldownUntil = new Map<string, number>();
const modelCooldownUntil = new Map<string, number>();
const ocrKeyCooldownUntil = new Map<string, number>();
const ocrKeyModelCooldownUntil = new Map<string, number>();
const ocrModelCooldownUntil = new Map<string, number>();
let nextGeneralKeyStart = 0;
let nextOCRKeyStart = 0;
const KEY_QUOTA_COOLDOWN_MS = 60_000;
const MODEL_BUSY_COOLDOWN_MS = 30_000;
const CONNECTION_COOLDOWN_MS = 12_000;
const MODEL_PAIR_COOLDOWN_MS = 15_000;

function rotationPairKey(key: string, model: string): string {
  return `${key}:${model}`;
}

function isCooling(map: Map<string, number>, id: string, now = Date.now()): boolean {
  const until = map.get(id) || 0;
  if (until <= now) {
    if (until) map.delete(id);
    return false;
  }
  return true;
}

function markRotationFailure(
  key: string,
  model: string,
  error: any,
  pool: 'general' | 'ocr' = 'general',
  kindOverride?: 'quota' | 'invalid' | 'temporary' | 'other',
  quotaOnlyKeyExclusion = false,
): 'quota' | 'invalid' | 'temporary' | 'other' {
  const keyCooldowns = pool === 'ocr' ? ocrKeyCooldownUntil : keyCooldownUntil;
  const pairCooldowns = pool === 'ocr' ? ocrKeyModelCooldownUntil : keyModelCooldownUntil;
  const invalidKeys = pool === 'ocr' ? permanentlyInvalidOCRKeys : permanentlyInvalidKeys;
  const status = Number(error?.status || error?.statusCode || error?.response?.status);
  // Keep the pre-existing OCR quota classification unchanged; the stricter
  // confirmed-quota rule applies to the general legal-drafting key pool.
  const kind = pool === 'ocr' && status === 429 ? 'quota' : (kindOverride || getGeminiErrorKind(error));
  const pair = rotationPairKey(key, model);
  const message = String(error?.message || '').toLowerCase();
  const now = Date.now();
  if (kind === 'invalid') {
    // Drafting must not blacklist a key because one model/request rejected it;
    // keep rotating through its other models and the remaining configured keys.
    if (!quotaOnlyKeyExclusion) {
      invalidKeys.add(key);
      keyCooldowns.set(key, Number.MAX_SAFE_INTEGER);
    }
  } else if (kind === 'quota') {
    // In legal drafting, confirmed quota exhaustion excludes this key from all model attempts.
    if (quotaOnlyKeyExclusion && pool === 'general') {
      draftingQuotaKeyCooldownUntil.set(key, now + KEY_QUOTA_COOLDOWN_MS);
    } else {
      keyCooldowns.set(key, now + KEY_QUOTA_COOLDOWN_MS);
      pairCooldowns.set(pair, now + KEY_QUOTA_COOLDOWN_MS);
    }
  } else if (status === 503 || /high demand|service unavailable|temporarily unavailable/.test(message)) {
    pairCooldowns.set(pair, now + MODEL_BUSY_COOLDOWN_MS);
  } else if (kind === 'temporary' || status === 408 || status === 504 || /network|fetch failed|connection|socket|econn|timed out|timeout|aborted/.test(message)) {
    pairCooldowns.set(pair, now + (status === 504 || /timeout|timed out|network|connection|socket|econn|fetch failed/.test(message) ? CONNECTION_COOLDOWN_MS : MODEL_PAIR_COOLDOWN_MS));
  }
  return kind;
}

function reserveStartIndex(count: number, pool: 'general' | 'ocr'): number {
  if (count <= 0) return 0;
  if (pool === 'ocr') {
    const start = nextOCRKeyStart % count;
    nextOCRKeyStart = (start + 1) % count;
    return start;
  }
  const start = nextGeneralKeyStart % count;
  nextGeneralKeyStart = (start + 1) % count;
  return start;
}

function selectModelsForKey( models: string[], key: string, pool: 'general' | 'ocr' = 'general', now = Date.now(), avoidPairs?: Set<string>, quotaOnlyMode = false, ): string[] {
  const pairCooldowns = pool === 'ocr' ? ocrKeyModelCooldownUntil : keyModelCooldownUntil;
  const modelCooldowns = pool === 'ocr' ? ocrModelCooldownUntil : modelCooldownUntil;
  const available = models.filter((model) =>
    (quotaOnlyMode || !isCooling(modelCooldowns, model, now)) &&
    (quotaOnlyMode
      ? !isCooling(draftingQuotaKeyCooldownUntil, key, now) &&
        !isCooling(pairCooldowns, rotationPairKey(key, model), now)
      : !isCooling(pairCooldowns, rotationPairKey(key, model), now)) &&
    !avoidPairs?.has(`${key}::${model}`)
  );
  return available;
}

function createGeminiClient(apiKey: string, timeoutMs?: number): GoogleGenAI {
  const httpOptions: any = { headers: { 'User-Agent': 'aistudio-build' } };
  if (Number.isFinite(timeoutMs) && Number(timeoutMs) >= 1000) {
    httpOptions.timeout = Number(timeoutMs);
    httpOptions.retryOptions = { attempts: 1 };
  }
  return new GoogleGenAI({ apiKey, httpOptions });
}

function getGeminiErrorKind(err: any): 'quota' | 'invalid' | 'temporary' | 'other' {
  const msg = String(err?.message || err?.error?.message || err?.response?.data?.error?.message || '').toLowerCase();
  const status = Number(err?.status || err?.statusCode || err?.response?.status || err?.response?.statusCode);
  const confirmedQuota = /quota[^.]{0,100}(exceed|exhaust|limit)|(?:exceed|exhaust)[^.]{0,100}quota|current quota|daily quota|per day quota|limit:\s*0/.test(msg);
  const rateLimit = /rate.?limit|too many requests|requests per minute|requests per second/.test(msg);
  if (status === 401 || /api key not valid|invalid api key|api_key_invalid|key.*(invalid|revoked|deleted)|credential.*invalid/.test(msg)) return 'invalid';
  if (confirmedQuota && !rateLimit) return 'quota';
  if (status === 429 || status === 408 || status === 503 || status === 504 ||
      /timeout|timed out|aborted|high demand|service unavailable|temporarily unavailable|network|fetch failed|connection|socket|econn/.test(msg)) return 'temporary';
  return 'other';
}

function maskGeminiKey(key: string): string {
  return key.length > 8 ? key.slice(0, 4) + '...' + key.slice(-4) : '****';
}

async function persistGeminiAttemptStatus(
  key: string,
  model: string,
  kind: 'success' | 'quota' | 'invalid' | 'temporary' | 'other',
  error?: any,
): Promise<void> {
  const runtimeStatus = kind === 'success' ? 'working'
    : kind === 'invalid' ? 'invalid'
    : kind === 'quota' ? 'quota'
    : kind === 'temporary' ? 'temporary'
    : 'error';
  try {
    await recordServerCloudGeminiKeyAttempt(
      key,
      model,
      runtimeStatus,
      kind === 'success' ? undefined : safeGeminiDiagnostic(error),
    );
  } catch (statusError: any) {
    // Status reporting must never interrupt an AI request or its key rotation.
    console.warn('[Gemini key status] could not persist attempt result:', statusError?.message || statusError);
  }
}

function safeGeminiDiagnostic(error: any): string {
  return String(error?.message || error || 'unknown')
    .replace(/(?:AIza|AQ\.)[A-Za-z0-9._-]{20,}/g, '[REDACTED_GEMINI_KEY]')
    .replace(/\\bBearer\\s+[^\\s,;]+/gi, 'Bearer [REDACTED]')
    .slice(0, 500);
}

function getDraftingGeminiErrorKind(error: any): 'quota' | 'invalid' | 'temporary' | 'other' {
  const messages: string[] = [];
  const seen = new Set<any>();

  const visit = (value: any, depth = 0): void => {
    if (value == null || depth > 7) return;
    if (typeof value === 'string') {
      const normalized = value
        .replace(/\\_/g, '_')
        .replace(/&#91;|&#x5b;/gi, '[')
        .replace(/&#93;|&#x5d;/gi, ']')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'");
      messages.push(normalized);
      const firstBrace = normalized.indexOf('{');
      const lastBrace = normalized.lastIndexOf('}');
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        try { visit(JSON.parse(normalized.slice(firstBrace, lastBrace + 1)), depth + 1); } catch {}
      }
      return;
    }
    if (typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    // QuotaFailure details are retained for diagnostics, but do not by
    // themselves prove that every model using this key has exhausted quota.
    for (const candidate of [value.message, value.status, value.code, value.error, value.details, value.data]) {
      if (candidate !== undefined) visit(candidate, depth + 1);
    }
  };

  visit(error);
  const normalizedMessage = messages.join(' ')
    .replace(/https?:\/\/[^\s"'<>]+/gi, ' ')
    .toLowerCase()
    .replace(/\\_/g, '_');
  const status = Number(error?.status || error?.statusCode || error?.code ||
    error?.response?.status || error?.response?.statusCode || error?.error?.code || 0);

  const explicitSpendCap = /spend[- ]based.{0,80}(limit|cap)|billing.{0,80}(limit|cap|exhaust)|prepaid.{0,80}(balance|credit).{0,80}(exhaust|deplet)|account.{0,80}spend.{0,40}(limit|cap)/.test(normalizedMessage);
  const explicitProjectQuota = /\b(?:project[- ]wide|whole project|entire project)\b.{0,100}\b(?:quota|limit)\b.{0,100}\b(?:exceed|exhaust|reach|cap)\b|\b(?:quota|limit)\b.{0,100}\b(?:for|of)\s+(?:the\s+)?(?:whole|entire)\s+project\b.{0,100}\b(?:exceed|exhaust|reach)\b/.test(normalizedMessage);

  // Google may return 429 / RESOURCE_EXHAUSTED / QuotaFailure for a
  // model-specific or rate-specific limit. Try the other models and keys.
  // Exclude a whole key only when the response explicitly says project-wide
  // quota or billing/spend cap.
  if (explicitSpendCap || explicitProjectQuota) return 'quota';

  if (status === 401 || /api key not valid|invalid api key|api_key_invalid|key.{0,20}(invalid|revoked|deleted)|credential.{0,20}invalid/.test(normalizedMessage)) {
    return 'invalid';
  }
  if (status === 429 || status === 408 || status === 403 || status === 503 || status === 504 ||
      /resource[_\s-]*exhausted|quota.{0,100}(exceed|exhaust)|exceeded.{0,100}current quota|timeout|timed out|aborted|high demand|service unavailable|temporarily unavailable|network|fetch failed|connection|socket|econn/.test(normalizedMessage)) {
    return 'temporary';
  }
  return getGeminiErrorKind({
    ...(error && typeof error === 'object' ? error : {}),
    message: normalizedMessage,
    status,
  });
}

function isGeminiModelUnavailable(error: any, knownStatus = 0): boolean {
  const status = Number(knownStatus || error?.status || error?.statusCode ||
    error?.response?.status || error?.response?.statusCode || error?.code || error?.error?.code || 0);
  const message = String(error?.message || error?.error?.message || '').toLowerCase();
  return status === 503 || /high demand|model is currently experiencing|service unavailable|temporarily unavailable/.test(message);
}

function shouldRetryGeminiError(error: any): boolean {
  return getGeminiErrorKind(error) === 'temporary';
}



const KEYS_FILE = path.join(process.cwd(), '.keys_config.json');
let inMemoryDynamicKeys: string[] = [];

export function getFileStoredKeys(): string[] {
  if (process.env.NODE_ENV === 'production') return [];
  try {
    if (fs.existsSync(KEYS_FILE)) {
      const data = fs.readFileSync(KEYS_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        return parsed.filter((k) => isValidGeminiApiKey(k));
      }
    }
  } catch (e) {}
  return inMemoryDynamicKeys;
}

export function saveFileStoredKeys(keys: string[]): void {
  inMemoryDynamicKeys = keys.filter((k) => isValidGeminiApiKey(k));
  try {
    fs.writeFileSync(KEYS_FILE, JSON.stringify(inMemoryDynamicKeys, null, 2), 'utf-8');
  } catch (e) {
    console.warn('تحذير أثناء حفظ تكوين المفاتيح على القرص:', e);
  }
}

export function addStoredKey(key: string): boolean {
  if (!isValidGeminiApiKey(key)) return false;
  const current = getFileStoredKeys();
  const clean = key.trim();
  if (!current.includes(clean)) {
    current.push(clean);
    saveFileStoredKeys(current);
  }
  return true;
}

export function removeStoredKey(indexOrKey: number | string): boolean {
  const current = getFileStoredKeys();
  if (typeof indexOrKey === 'number') {
    if (indexOrKey >= 0 && indexOrKey < current.length) {
      current.splice(indexOrKey, 1);
      saveFileStoredKeys(current);
      return true;
    }
  } else {
    const updated = current.filter((k) => k !== indexOrKey);
    saveFileStoredKeys(updated);
    return true;
  }
  return false;
}

export async function testGeminiKey(apiKey: string, timeoutMs = 15000): Promise<{ success: boolean; message: string }> {
  const cleanKey = sanitizeGeminiKey(apiKey);
  if (!isValidGeminiApiKey(cleanKey)) {
    return {
      success: false,
      message: 'مفتاح Gemini غير صالح. انسخ المفتاح كاملاً من منصة Google AI Studio وأدخله كما هو.',
    };
  }

  const deadline = Date.now() + Math.max(1000, timeoutMs);
  let lastFailure = '';

  for (const model of GEMINI_MODELS) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      lastFailure = 'انتهت المهلة المحددة لفحص مفتاح Gemini.';
      break;
    }

    const controller = new AbortController();
    const attemptTimeoutMs = Math.min(5000, remainingMs);
    const timeout = setTimeout(() => controller.abort(), attemptTimeoutMs);
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`,
        {
          method: 'GET',
          headers: { 'x-goog-api-key': cleanKey },
          signal: controller.signal,
        },
      );
      const raw = await response.text();
      let data: any = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch {}

      if (response.ok && data?.name) {
        return {
          success: true,
          message: `المفتاح صالح ويمكنه الوصول إلى النموذج ${model}.`,
        };
      }

      const status = Number(data?.error?.code || response.status);
      const apiMessage = String(data?.error?.message || '').trim();
      lastFailure = `فشل فحص ${model} (${status})${apiMessage ? `: ${apiMessage.slice(0, 240)}` : '.'}`;

      const errorText = `${data?.error?.status || ''} ${apiMessage}`;
      if (status === 401 || /api key not valid|invalid api key|api_key_invalid|key.*(invalid|revoked|deleted)|credential.*invalid/i.test(errorText)) {
        return { success: false, message: `أكدت Google أن مفتاح Gemini غير صالح أو ملغى (${status}).` };
      }

      if (status === 403 || status === 404 || status === 400) continue;
      if (status === 429) {
        return { success: false, message: `رفض طلب فحص بيانات النموذج بسبب حد طلبات واجهة البرمجة (${status}).` };
      }
    } catch (err: any) {
      lastFailure = controller.signal.aborted ? `انتهت مهلة فحص ${model}.` : `تعذر الاتصال بـ Gemini عبر ${model}.`;
      if (controller.signal.aborted) break;
    } finally {
      clearTimeout(timeout);
    }
  }

  return { success: false, message: lastFailure || 'تعذر التحقق من مفتاح Gemini أو الوصول إلى أي نموذج متاح.' };
}

let dedicatedOCRActiveKey = '';
let dedicatedOCRActiveModel = '';
const dedicatedOCRInFlightPairs = new Set<string>();

export async function checkDedicatedOCRGeminiReadiness(totalTimeoutMs = 9000): Promise<{ ready: boolean; keyCount: number; checkedKeys: number; message: string }> {
  let keys: string[];
  try {
    keys = await fetchServerCloudOCRGeminiKeys(Math.min(5000, totalTimeoutMs));
  } catch (error: any) {
    return { ready: false, keyCount: 0, checkedKeys: 0, message: error?.message || 'تعذر قراءة مجموعة مفاتيح الصور والمستندات.' };
  }
  if (!keys.length) {
    return { ready: false, keyCount: 0, checkedKeys: 0, message: 'لا توجد مفاتيح مخصصة للصور والمستندات والخاصة (OCR).' };
  }

  const deadlineAt = Date.now() + Math.max(1000, totalTimeoutMs);
  let checkedKeys = 0;
  let lastFailure = '';
  for (const key of keys) {
    const remaining = deadlineAt - Date.now();
    if (remaining < 700) break;
    checkedKeys++;
    const result = await testGeminiKey(key, Math.min(2200, remaining));
    if (result.success) {
      return { ready: true, keyCount: keys.length, checkedKeys, message: `مجموعة OCR جاهزة (${keys.length} مفتاح مسجل).` };
    }
    lastFailure = result.message || '';
    if (Date.now() >= deadlineAt) break;
  }
  return { ready: false, keyCount: keys.length, checkedKeys, message: `توجد ${keys.length} مفاتيح في مجموعة OCR، لكن تعذر التحقق من وصول أي نموذج. آخر نتيجة: ${lastFailure}` };
}

/** تدوير OCR حصرياً عبر مفاتيح ونماذج Gemini المخصصة للصور والمستندات. */

export async function executeWithDedicatedOCRKeyRotation<T>(
  action: (ai: GoogleGenAI, key: string, model: string) => Promise<T>,
  preferredModels: string[] = GEMINI_MODELS,
  timeoutMs = 240000,
): Promise<T> {
  const deadlineAt = Date.now() + Math.max(15000, timeoutMs);
  let keys: string[] = [];
  try {
    keys = await fetchServerCloudOCRGeminiKeys(Math.min(8000, Math.max(1000, deadlineAt - Date.now() - 2000)));
  } catch (error: any) {
    console.warn('تعذر جلب مفاتيح OCR من Supabase:', error?.message);
  }

  let lastError: any = null;
  const overallStart = Date.now();
  const totalBudget = Math.max(0, deadlineAt - overallStart);

  for (let round = 0; round < 2; round++) {
    const roundStart = overallStart + Math.floor(totalBudget * round / 2);
    const roundEnd = overallStart + Math.floor(totalBudget * (round + 1) / 2);
    // Use the complete round budget for Gemini key/model rotation only.
    const geminiDeadlineAt = roundEnd;
    if (round > 0) await new Promise((r) => setTimeout(r, 1000));

    if (keys.length > 0) {
      const usableOCRKeys = keys.filter((candidate) => !permanentlyInvalidOCRKeys.has(candidate));
      const rememberedKeyIndex = dedicatedOCRActiveKey ? usableOCRKeys.indexOf(dedicatedOCRActiveKey) : -1;
      const startIndex = rememberedKeyIndex >= 0 &&
        !isCooling(ocrKeyCooldownUntil, dedicatedOCRActiveKey) &&
        !permanentlyInvalidOCRKeys.has(dedicatedOCRActiveKey)
          ? rememberedKeyIndex
          : (usableOCRKeys.length ? reserveStartIndex(usableOCRKeys.length, 'ocr') : 0);

      ocrKeyLoop: for (let offset = 0; offset < usableOCRKeys.length; offset++) {
        const keyIndex = (startIndex + offset) % usableOCRKeys.length;
        const key = usableOCRKeys[keyIndex];
        if (isCooling(ocrKeyCooldownUntil, key) || permanentlyInvalidOCRKeys.has(key)) continue;
        const selectedModels = selectModelsForKey(preferredModels, key, 'ocr');
        if (key === dedicatedOCRActiveKey && dedicatedOCRActiveModel) {
          const rememberedModelIndex = selectedModels.indexOf(dedicatedOCRActiveModel);
          if (rememberedModelIndex > 0) {
            selectedModels.splice(rememberedModelIndex, 1);
            selectedModels.unshift(dedicatedOCRActiveModel);
          }
        }
        const keyModels = selectedModels.filter((model) => !dedicatedOCRInFlightPairs.has(rotationPairKey(key, model)));

        for (let modelIndex = 0; modelIndex < keyModels.length; modelIndex++) {
          const remainingMs = geminiDeadlineAt - Date.now();
          if (remainingMs < 10000) break ocrKeyLoop;
          const model = keyModels[modelIndex];
          const pair = rotationPairKey(key, model);
          if (dedicatedOCRInFlightPairs.has(pair)) continue;
          dedicatedOCRInFlightPairs.add(pair);
          try {
            const ai = withAdaptiveAnswerLength(createGeminiClient(key, Math.min(25000, remainingMs)));
            const result = await action(ai, key, model);
            if (Date.now() >= geminiDeadlineAt) throw Object.assign(new Error('انتهت مهلة محاولة OCR عبر Gemini.'), { status: 504, statusCode: 504 });
            dedicatedOCRActiveKey = key;
            dedicatedOCRActiveModel = model;
            return result;
          } catch (error: any) {
            lastError = error;
            markRotationFailure(key, model, error, 'ocr');
          } finally {
            dedicatedOCRInFlightPairs.delete(pair);
          }
        }
      }
    }

    if (Date.now() >= deadlineAt || deadlineAt - Date.now() < 10000) break;
  }

  const finalError: any = new Error(`فشلت محاولات Gemini بمفاتيحها ونماذجها المخصصة لاستخراج النص. ${String(lastError?.message || '')}`);
  finalError.status = lastError?.status || lastError?.statusCode || 503;
  finalError.statusCode = finalError.status;
  finalError.cause = lastError;
  throw finalError;
}

export function getVercelGeminiKeys(): string[] {
  const keys: string[] = [];
  const addKey = (k: any) => {
    if (!k || typeof k !== 'string') return;
    for (const part of k.split(/[\n,;]+/)) {
      const clean = sanitizeGeminiKey(part.trim());
      if (isValidGeminiApiKey(clean) && !keys.includes(clean)) keys.push(clean);
    }
  };

  for (let i = 1; i <= 50; i++) {
    addKey(process.env[`GEMINI_API_KEY_${i}`]);
    addKey(process.env[`GEMINI_KEY_${i}`]);
  }
  addKey(process.env.GEMINI_API_KEYS);
  addKey(process.env.GEMINI_API_KEY);
  addKey(process.env.GOOGLE_GENAI_API_KEY);
  addKey(process.env.GOOGLE_API_KEY);

  for (const storedKey of getFileStoredKeys()) addKey(storedKey);

  return keys;
}

async function getAvailableGeminiKeys(
  timeoutMs?: number,
  managedOnly = false,
  forceRefresh = false,
): Promise<string[]> {
  // Legal drafting uses the platform-managed key vault in Supabase as its
  // single source of truth. Do not silently fall back to Vercel env vars or
  // local files if the managed-key read fails.
  if (managedOnly) {
    const managedKeys = await fetchServerCloudGeminiKeys(timeoutMs, forceRefresh);
    const validManagedKeys = managedKeys.filter(isValidGeminiApiKey);
    if (validManagedKeys.length === 0) {
      throw new Error('لم يتم العثور على مفاتيح Gemini نشطة في إدارة المنصة على Supabase. تعذر بدء الصياغة دون مفاتيح الإدارة المحفوظة.');
    }
    return [...new Set(validManagedKeys)];
  }

  const keys = getVercelGeminiKeys();
  try {
    for (const key of await fetchServerCloudGeminiKeys(timeoutMs, forceRefresh)) {
      if (isValidGeminiApiKey(key) && !keys.includes(key)) keys.push(key);
    }
  } catch (error) {
    if (keys.length === 0) throw error;
  }
  return keys;
}

export async function getManagedGeminiKeyByIndex(index: number): Promise<string> {
  if (!Number.isInteger(index) || index < 0) throw new Error('رقم المفتاح غير صحيح.');
  const keys = await getAvailableGeminiKeys();
  const key = keys[index];
  if (!key) throw new Error('المفتاح غير موجود في إعدادات Gemini الحالية.');
  return key;
}

export function getKeysStatus() {
  const keys = getVercelGeminiKeys();
  const maskedList = keys.map((k, idx) => ({
    index: idx,
    id: `key_${idx + 1}`,
    name: idx === 0 ? 'المفتاح الرئيسي' : `مفتاح التدوير (${idx + 1})`,
    masked: k.length > 8 ? `${k.slice(0, 4)}...${k.slice(-4)}` : '****',
    prefix: k.slice(0, 2),
    isActive: idx === activeKeyIndex,
  }));
  return {
    isConfigured: keys.length > 0,
    totalCount: keys.length,
    activeIndex: activeKeyIndex,
    keys: maskedList,
    rotationEnabled: keys.length > 1,
  };
}

function withAdaptiveAnswerLength(ai: any): any {
  const instruction = 'اختر طول الإجابة وفقاً لطبيعة الطلب وتعقيده؛ لا تلتزم بعدد كلمات ثابت ولا تختصر لمجرد الاختصار.';
  const adaptOptions = (options: any) => {
    const { skipAdaptiveAnswerLength, ...apiOptions } = options || {};
    if (skipAdaptiveAnswerLength === true) return apiOptions;
    const config = { ...(apiOptions?.config || {}) };
    const current = config.systemInstruction;
    if (typeof current === 'string' && current.trim()) {
      config.systemInstruction = `${current}\n\n${instruction}`;
    } else {
      config.systemInstruction = instruction;
    }
    return { ...apiOptions, config };
  };
  return {
    models: {
      generateContent: (options: any) => ai.models.generateContent(adaptOptions(options)),
      generateContentStream: (options: any) => ai.models.generateContentStream(adaptOptions(options)),
    },
  };
}

type KeyRotationExecutionOptions = {
  ocrMode?: boolean;
  deadlineAt?: number;
  previousProviderError?: string;
  /** Previously used key/model pairs are avoided first during continuation. */
  avoidPairs?: string[];
  /** Resume Gemini rotation from the key used by the previous continuation segment. */
  startKey?: string;
  /** Resume from the last model that successfully generated part of the document. */
  startModel?: string;
  /** Mutable per-generation ledger so failed model attempts are not retried on continuation. */
  attemptedPairs?: Set<string>;
  /** Drafting excludes a key only for confirmed quota exhaustion. */
  draftingMode?: boolean;
};

export async function executeWithKeyRotation<T>(
  action: (ai: GoogleGenAI, key: string, model: string) => Promise<T>,
  preferredModels: string[] = GEMINI_MODELS,
  _ignoredClientFallbackKey?: string,
  _legacyForceGeminiFallback = false,
  executionOptions?: KeyRotationExecutionOptions
): Promise<T> {
  const deadlineAt = Number(executionOptions?.deadlineAt || (Date.now() + (executionOptions?.ocrMode ? 240000 : 270000)));
  const timeoutError = () => Object.assign(
    new Error('انتهت المهلة المتاحة لتوليد النتيجة قبل اكتمالها.'),
    { status: 504, statusCode: 504 },
  );
  const draftingMode = executionOptions?.draftingMode === true;
  const keys = (await getAvailableGeminiKeys(undefined, draftingMode, draftingMode)).filter((key) => draftingMode || !permanentlyInvalidKeys.has(key));
  if (keys.length === 0) throw new Error('لم يتم العثور على مفتاح Gemini صالح في إعدادات الخادم.');
  if (draftingMode) console.info('[Gemini drafting rotation] managed key pool loaded', {
    totalKeys: keys.length,
    configuredModels: preferredModels.length,
    keyFingerprints: keys.map(maskGeminiKey),
  });

  if (activeKeyIndex >= keys.length) activeKeyIndex = 0;
  const explicitlyAvoidedPairs = new Set(executionOptions?.avoidPairs || []);
  const avoidedPairs = new Set([...explicitlyAvoidedPairs, ...(executionOptions?.attemptedPairs || [])]);
  const quotaExhaustedKeys = new Set<string>(keys.filter((key) => draftingMode
    ? isCooling(draftingQuotaKeyCooldownUntil, key)
    : isCooling(keyCooldownUntil, key)));
  let lastError: any = null;
  // Keep transient provider failures distinct from quota responses. A mixed
  // set of 503/504 and model-scoped 429 responses is retryable work, not proof
  // that every managed key has exhausted its quota.
  let lastTemporaryError: any = null;
  let attemptedModelCount = 0;
  const requestedStartIndex = executionOptions?.startKey ? keys.indexOf(executionOptions.startKey) : -1;
  const startIndex = requestedStartIndex >= 0 ? requestedStartIndex : reserveStartIndex(keys.length, 'general');

  for (let offset = 0; offset < keys.length; offset++) {
    const currentKeyIndex = (startIndex + offset) % keys.length;
    const currentKey = keys[currentKeyIndex];
    if ((draftingMode
      ? isCooling(draftingQuotaKeyCooldownUntil, currentKey)
      : isCooling(keyCooldownUntil, currentKey)) || (!draftingMode && permanentlyInvalidKeys.has(currentKey))) continue;
    const models = selectModelsForKey(preferredModels, currentKey, 'general', Date.now(), avoidedPairs, draftingMode);
    if (draftingMode && currentKey === executionOptions?.startKey && executionOptions?.startModel) {
      const preferredModelIndex = models.indexOf(executionOptions.startModel);
      if (preferredModelIndex > 0) models.unshift(...models.splice(preferredModelIndex, 1));
    }

    for (const model of models) {
      const pair = rotationPairKey(currentKey, model);
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs < 3000) {
        lastError = timeoutError();
        break;
      }
      attemptedModelCount++;
      if (draftingMode) console.info('[Gemini drafting rotation] trying key/model', {
        keyPosition: currentKeyIndex + 1,
        totalKeys: keys.length,
        key: maskGeminiKey(currentKey),
        modelPosition: models.indexOf(model) + 1,
        modelsForKey: models.length,
        model,
        attemptedModelCount,
      });

      let pairSucceeded = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const attemptRemainingMs = deadlineAt - Date.now();
        if (attemptRemainingMs < 3000) {
          lastError = timeoutError();
          break;
        }
        try {
          const ai = withAdaptiveAnswerLength(createGeminiClient(currentKey, Math.min(30000, attemptRemainingMs)));
          const result = await action(ai, currentKey, model);
          if (Date.now() >= deadlineAt) throw timeoutError();
          activeKeyIndex = currentKeyIndex;
          pairSucceeded = true;
          if (draftingMode) await persistGeminiAttemptStatus(currentKey, model, 'success');
          console.info('[Gemini rotation] attempt succeeded', {
            key: maskGeminiKey(currentKey),
            model,
            attempt,
            partialCharacters: Number((result as any)?.partialCharacters || 0),
          });
          return result;
        } catch (error: any) {
          lastError = error;
          const kind = draftingMode ? getDraftingGeminiErrorKind(error) : getGeminiErrorKind(error);
          const status = Number(error?.status || error?.statusCode || error?.response?.status || error?.response?.statusCode || error?.code || error?.error?.code || 0);
          if (draftingMode && kind === 'temporary') lastTemporaryError = error;
          console.warn('[Gemini rotation] attempt failed', {
            key: maskGeminiKey(currentKey),
            model,
            attempt,
            kind,
            status,
            reason: safeGeminiDiagnostic(error),
            partialCharacters: Number(error?.partialCharacters || 0),
          });

          if (kind === 'temporary' && !isGeminiModelUnavailable(error, status) && attempt === 1 && deadlineAt - Date.now() > 5000) {
            await new Promise((resolve) => setTimeout(resolve, status === 429 ? 700 : 350));
            continue;
          }
          executionOptions?.attemptedPairs?.add(pair);

          markRotationFailure(currentKey, model, error, 'general', kind, draftingMode);
          if (draftingMode) await persistGeminiAttemptStatus(currentKey, model, kind, error);
          if (kind === 'quota' && isCooling(draftingQuotaKeyCooldownUntil, currentKey)) quotaExhaustedKeys.add(currentKey);
          if (!draftingMode && permanentlyInvalidKeys.has(currentKey)) break;
          break;
        }
      }
      if (pairSucceeded) break;
      if ((!draftingMode && permanentlyInvalidKeys.has(currentKey)) || (draftingMode
        ? isCooling(draftingQuotaKeyCooldownUntil, currentKey)
        : isCooling(keyCooldownUntil, currentKey))) break;
    }
  }

  if (attemptedModelCount === 0 && explicitlyAvoidedPairs.size > 0 && Date.now() < deadlineAt) {
    return executeWithKeyRotation(action, preferredModels, _ignoredClientFallbackKey, false, {
      ...executionOptions,
      avoidPairs: undefined,
    });
  }

  if (quotaExhaustedKeys.size === keys.length && keys.length > 0) {
    if (draftingMode && lastTemporaryError) throw lastTemporaryError;
    const quotaError: any = new Error('تأكد نفاد حصة جميع مفاتيح Gemini المتاحة؛ لم يُستخدم أي مزود احتياطي.');
    quotaError.allGeminiQuotasExhausted = true;
    quotaError.status = 429;
    quotaError.statusCode = 429;
    throw quotaError;
  }
  throw lastError || timeoutError();
}

export async function executeWithKeyRotationStream(
  action: (ai: GoogleGenAI, key: string, model: string) => Promise<AsyncIterable<any>>,
  onChunk: (text: string) => void,
  preferredModels: string[] = GEMINI_MODELS,
  _ignoredClientFallbackKey?: string,
  _legacyForceGeminiFallback = false,
  executionOptions?: KeyRotationExecutionOptions
): Promise<void> {
  const deadlineAt = Number(executionOptions?.deadlineAt || (Date.now() + 270000));
  const timeoutError = () => Object.assign(new Error('انتهت المهلة المتاحة للتوليد.'), { status: 504, statusCode: 504 });
  const draftingMode = executionOptions?.draftingMode === true;
  const keys = (await getAvailableGeminiKeys(undefined, draftingMode, draftingMode)).filter((key) => draftingMode || !permanentlyInvalidKeys.has(key));
  if (keys.length === 0) throw new Error('لم يتم العثور على مفتاح Gemini صالح.');
  if (draftingMode) console.info('[Gemini drafting rotation] managed key pool loaded', {
    totalKeys: keys.length,
    configuredModels: preferredModels.length,
    keyFingerprints: keys.map(maskGeminiKey),
  });

  const explicitlyAvoidedPairs = new Set(executionOptions?.avoidPairs || []);
  const avoidedPairs = new Set([...explicitlyAvoidedPairs, ...(executionOptions?.attemptedPairs || [])]);
  let attemptedModelCount = 0;
  let lastError: any = null;
  const quotaExhaustedKeys = new Set<string>(keys.filter((key) => draftingMode
    ? isCooling(draftingQuotaKeyCooldownUntil, key)
    : isCooling(keyCooldownUntil, key)));
  const requestedStartIndex = executionOptions?.startKey ? keys.indexOf(executionOptions.startKey) : -1;
  const startIndex = requestedStartIndex >= 0 ? requestedStartIndex : reserveStartIndex(keys.length, 'general');

  for (let offset = 0; offset < keys.length; offset++) {
    const currentKeyIndex = (startIndex + offset) % keys.length;
    const currentKey = keys[currentKeyIndex];
    if ((draftingMode
      ? isCooling(draftingQuotaKeyCooldownUntil, currentKey)
      : isCooling(keyCooldownUntil, currentKey)) || (!draftingMode && permanentlyInvalidKeys.has(currentKey))) continue;
    const models = selectModelsForKey(preferredModels, currentKey, 'general', Date.now(), avoidedPairs, draftingMode);
    if (draftingMode && currentKey === executionOptions?.startKey && executionOptions?.startModel) {
      const preferredModelIndex = models.indexOf(executionOptions.startModel);
      if (preferredModelIndex > 0) models.unshift(...models.splice(preferredModelIndex, 1));
    }

    for (const model of models) {
      const pair = rotationPairKey(currentKey, model);
      if (deadlineAt - Date.now() < 3000) {
        lastError = timeoutError();
        break;
      }
      attemptedModelCount++;
      console.info('[Gemini drafting rotation] trying key/model', {
        keyPosition: currentKeyIndex + 1,
        totalKeys: keys.length,
        modelPosition: models.indexOf(model) + 1,
        modelsForKey: models.length,
        model,
      });

      for (let attempt = 1; attempt <= 2; attempt++) {
        if (deadlineAt - Date.now() < 3000) {
          lastError = timeoutError();
          break;
        }
        let partialCharacters = 0;
        let emittedAnyChunk = false;
        try {
          const ai = withAdaptiveAnswerLength(createGeminiClient(currentKey, Math.min(30000, deadlineAt - Date.now())));
          const stream = await action(ai, currentKey, model);
          for await (const chunk of stream) {
            const text = typeof chunk?.text === 'string' ? chunk.text : '';
            if (!text) continue;
            emittedAnyChunk = true;
            partialCharacters += text.length;
            onChunk(text);
          }
          activeKeyIndex = currentKeyIndex;
          if (draftingMode) await persistGeminiAttemptStatus(currentKey, model, 'success');
          console.info('[Gemini stream rotation] attempt succeeded', {
            key: maskGeminiKey(currentKey),
            keyPosition: currentKeyIndex + 1,
            totalKeys: keys.length,
            model,
            modelPosition: models.indexOf(model) + 1,
            modelsForKey: models.length,
            attempt,
            partialCharacters,
          });
          return;
        } catch (error: any) {
          lastError = error;
          const kind = draftingMode ? getDraftingGeminiErrorKind(error) : getGeminiErrorKind(error);
          const status = Number(error?.status || error?.statusCode || error?.response?.status || error?.response?.statusCode || error?.code || error?.error?.code || 0);
          console.warn('[Gemini stream rotation] attempt failed', {
            key: maskGeminiKey(currentKey),
            keyPosition: currentKeyIndex + 1,
            totalKeys: keys.length,
            model,
            modelPosition: models.indexOf(model) + 1,
            modelsForKey: models.length,
            attempt,
            kind,
            status,
            partialCharacters,
            reason: safeGeminiDiagnostic(error),
          });

          // A transient interruption after text was emitted does not invalidate
          // the provider pair. Preserve the partial output and let drafting resume
          // with this same key/model before considering another pair.
          if (emittedAnyChunk) {
            if (kind !== 'temporary') {
              executionOptions?.attemptedPairs?.add(pair);
              markRotationFailure(currentKey, model, error, 'general', kind, draftingMode);
              if (kind === 'quota' && isCooling(draftingQuotaKeyCooldownUntil, currentKey)) quotaExhaustedKeys.add(currentKey);
              if (draftingMode) await persistGeminiAttemptStatus(currentKey, model, kind, error);
            }
            error.partialCharacters = partialCharacters;
            throw error;
          }
          if (kind === 'temporary' && !isGeminiModelUnavailable(error, status) && attempt === 1 && deadlineAt - Date.now() > 5000) {
            await new Promise((resolve) => setTimeout(resolve, status === 429 ? 700 : 350));
            continue;
          }
          executionOptions?.attemptedPairs?.add(pair);
          markRotationFailure(currentKey, model, error, 'general', kind, draftingMode);
          if (kind === 'quota' && isCooling(draftingQuotaKeyCooldownUntil, currentKey)) quotaExhaustedKeys.add(currentKey);
          if (draftingMode) await persistGeminiAttemptStatus(currentKey, model, kind, error);
          if ((!draftingMode && permanentlyInvalidKeys.has(currentKey)) || (draftingMode
            ? isCooling(draftingQuotaKeyCooldownUntil, currentKey)
            : isCooling(keyCooldownUntil, currentKey))) break;
          break;
        }
      }
      if ((!draftingMode && permanentlyInvalidKeys.has(currentKey)) || (draftingMode
        ? isCooling(draftingQuotaKeyCooldownUntil, currentKey)
        : isCooling(keyCooldownUntil, currentKey))) break;
    }
  }

  if (attemptedModelCount === 0 && explicitlyAvoidedPairs.size > 0 && Date.now() < deadlineAt) {
    return executeWithKeyRotationStream(action, onChunk, preferredModels, _ignoredClientFallbackKey, false, {
      ...executionOptions,
      avoidPairs: undefined,
    });
  }
  if (quotaExhaustedKeys.size === keys.length && keys.length > 0) {
    const quotaError: any = new Error('تأكد نفاد حصة جميع مفاتيح Gemini المتاحة أثناء البث.');
    quotaError.allGeminiQuotasExhausted = true;
    quotaError.status = 429;
    quotaError.statusCode = 429;
    throw quotaError;
  }
  throw lastError || timeoutError();
}

export default function handler(req: any, res: any) {
  return res.status(200).json({ ok: true, activeKeys: getKeysStatus().totalCount });
}
