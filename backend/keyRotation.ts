import { GoogleGenAI } from '@google/genai';
import { sanitizeGeminiKey } from './centralKeys.ts';
import fs from 'fs';
import path from 'path';
import { fetchServerCloudGeminiKeys, fetchServerCloudOCRGeminiKeys } from './supabaseSync.ts';

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

function markRotationFailure(key: string, model: string, error: any, pool: 'general' | 'ocr' = 'general'): 'quota' | 'invalid' | 'temporary' | 'other' {
  const keyCooldowns = pool === 'ocr' ? ocrKeyCooldownUntil : keyCooldownUntil;
  const pairCooldowns = pool === 'ocr' ? ocrKeyModelCooldownUntil : keyModelCooldownUntil;
  const invalidKeys = pool === 'ocr' ? permanentlyInvalidOCRKeys : permanentlyInvalidKeys;
  const kind = getGeminiErrorKind(error);
  const status = Number(error?.status || error?.statusCode || error?.response?.status);
  const pair = rotationPairKey(key, model);
  const message = String(error?.message || '').toLowerCase();
  const now = Date.now();
  if (kind === 'invalid') {
    invalidKeys.add(key);
    keyCooldowns.set(key, Number.MAX_SAFE_INTEGER);
  } else if (kind === 'quota') {
    // A key is skipped globally only after Gemini confirms quota exhaustion.
    keyCooldowns.set(key, now + KEY_QUOTA_COOLDOWN_MS);
    pairCooldowns.set(pair, now + KEY_QUOTA_COOLDOWN_MS);
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

function selectModelsForKey( models: string[], key: string, pool: 'general' | 'ocr' = 'general', now = Date.now(), avoidPairs?: Set<string>, ): string[] {
  const pairCooldowns = pool === 'ocr' ? ocrKeyModelCooldownUntil : keyModelCooldownUntil;
  const modelCooldowns = pool === 'ocr' ? ocrModelCooldownUntil : modelCooldownUntil;
  const available = models.filter((model) =>
    !isCooling(modelCooldowns, model, now) &&
    !isCooling(pairCooldowns, rotationPairKey(key, model), now) &&
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
  const confirmedQuota = /quota[^.]{0,100}(exceed|exhaust|limit)|(?:exceed|exhaust)[^.]{0,100}quota|current quota|daily quota|per day quota|resource_exhausted/.test(msg);
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

async function getAvailableGeminiKeys(timeoutMs?: number): Promise<string[]> {
  const keys = getVercelGeminiKeys();
  try {
    for (const key of await fetchServerCloudGeminiKeys(timeoutMs)) {
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
  /** Mutable per-generation ledger so failed model attempts are not retried on continuation. */
  attemptedPairs?: Set<string>;
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
  const keys = (await getAvailableGeminiKeys()).filter((key) => !permanentlyInvalidKeys.has(key));
  if (keys.length === 0) throw new Error('لم يتم العثور على مفتاح Gemini صالح في إعدادات الخادم.');

  if (activeKeyIndex >= keys.length) activeKeyIndex = 0;
  const avoidedPairs = new Set(executionOptions?.avoidPairs || []);
  const quotaExhaustedKeys = new Set<string>(keys.filter((key) => isCooling(keyCooldownUntil, key)));
  let lastError: any = null;
  let attemptedModelCount = 0;
  const requestedStartIndex = executionOptions?.startKey ? keys.indexOf(executionOptions.startKey) : -1;
  const startIndex = requestedStartIndex >= 0 ? requestedStartIndex : reserveStartIndex(keys.length, 'general');

  for (let offset = 0; offset < keys.length; offset++) {
    const currentKeyIndex = (startIndex + offset) % keys.length;
    const currentKey = keys[currentKeyIndex];
    if (isCooling(keyCooldownUntil, currentKey) || permanentlyInvalidKeys.has(currentKey)) continue;
    const models = selectModelsForKey(preferredModels, currentKey, 'general', Date.now(), avoidedPairs);

    for (const model of models) {
      const pair = rotationPairKey(currentKey, model);
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs < 3000) {
        lastError = timeoutError();
        break;
      }
      attemptedModelCount++;
      executionOptions?.attemptedPairs?.add(pair);

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
          console.info('[Gemini rotation] attempt succeeded', {
            key: maskGeminiKey(currentKey),
            model,
            attempt,
            partialCharacters: Number((result as any)?.partialCharacters || 0),
          });
          return result;
        } catch (error: any) {
          lastError = error;
          const kind = getGeminiErrorKind(error);
          const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
          console.warn('[Gemini rotation] attempt failed', {
            key: maskGeminiKey(currentKey),
            model,
            attempt,
            kind,
            status,
            reason: String(error?.message || error).slice(0, 500),
            partialCharacters: Number(error?.partialCharacters || 0),
          });

          if (kind === 'temporary' && attempt === 1 && deadlineAt - Date.now() > 5000) {
            await new Promise((resolve) => setTimeout(resolve, status === 429 ? 700 : 350));
            continue;
          }

          markRotationFailure(currentKey, model, error, 'general');
          if (kind === 'quota') quotaExhaustedKeys.add(currentKey);
          if (permanentlyInvalidKeys.has(currentKey)) break;
          break;
        }
      }
      if (pairSucceeded) break;
      if (permanentlyInvalidKeys.has(currentKey) || isCooling(keyCooldownUntil, currentKey)) break;
    }
  }

  if (attemptedModelCount === 0 && avoidedPairs.size > 0 && Date.now() < deadlineAt) {
    return executeWithKeyRotation(action, preferredModels, _ignoredClientFallbackKey, false, {
      ...executionOptions,
      avoidPairs: undefined,
    });
  }

  if (quotaExhaustedKeys.size === keys.length && keys.length > 0) {
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
  const keys = (await getAvailableGeminiKeys()).filter((key) => !permanentlyInvalidKeys.has(key));
  if (keys.length === 0) throw new Error('لم يتم العثور على مفتاح Gemini صالح.');

  const avoidedPairs = new Set(executionOptions?.avoidPairs || []);
  let attemptedModelCount = 0;
  let lastError: any = null;
  const quotaExhaustedKeys = new Set<string>(keys.filter((key) => isCooling(keyCooldownUntil, key)));
  const requestedStartIndex = executionOptions?.startKey ? keys.indexOf(executionOptions.startKey) : -1;
  const startIndex = requestedStartIndex >= 0 ? requestedStartIndex : reserveStartIndex(keys.length, 'general');

  for (let offset = 0; offset < keys.length; offset++) {
    const currentKeyIndex = (startIndex + offset) % keys.length;
    const currentKey = keys[currentKeyIndex];
    if (isCooling(keyCooldownUntil, currentKey) || permanentlyInvalidKeys.has(currentKey)) continue;
    const models = selectModelsForKey(preferredModels, currentKey, 'general', Date.now(), avoidedPairs);

    for (const model of models) {
      const pair = rotationPairKey(currentKey, model);
      if (deadlineAt - Date.now() < 3000) {
        lastError = timeoutError();
        break;
      }
      attemptedModelCount++;
      executionOptions?.attemptedPairs?.add(pair);

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
          console.info('[Gemini stream rotation] attempt succeeded', {
            key: maskGeminiKey(currentKey),
            model,
            attempt,
            partialCharacters,
          });
          return;
        } catch (error: any) {
          lastError = error;
          const kind = getGeminiErrorKind(error);
          const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
          console.warn('[Gemini stream rotation] attempt failed', {
            key: maskGeminiKey(currentKey),
            model,
            attempt,
            kind,
            status,
            partialCharacters,
            reason: String(error?.message || error).slice(0, 500),
          });

          markRotationFailure(currentKey, model, error, 'general');
          if (kind === 'quota') quotaExhaustedKeys.add(currentKey);

          // Once a stream has delivered text, preserve it and let the document
          // continuation layer resume from that exact partial output on another pair.
          if (emittedAnyChunk) {
            error.partialCharacters = partialCharacters;
            throw error;
          }
          if (kind === 'temporary' && attempt === 1 && deadlineAt - Date.now() > 5000) {
            await new Promise((resolve) => setTimeout(resolve, status === 429 ? 700 : 350));
            continue;
          }
          if (permanentlyInvalidKeys.has(currentKey) || isCooling(keyCooldownUntil, currentKey)) break;
          break;
        }
      }
      if (permanentlyInvalidKeys.has(currentKey) || isCooling(keyCooldownUntil, currentKey)) break;
    }
  }

  if (attemptedModelCount === 0 && avoidedPairs.size > 0 && Date.now() < deadlineAt) {
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
