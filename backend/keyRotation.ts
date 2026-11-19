import { GoogleGenAI } from '@google/genai';
import { createHash } from 'node:crypto';
import { sanitizeGeminiKey } from './centralKeys.ts';
import fs from 'fs';
import path from 'path';
import { createOpenAICompatibleClient } from './openaiCompatibleAdapter.ts';
import { fetchServerCloudGeminiKeys, fetchServerCloudOCRGeminiKeys, fetchServerCloudOCRGroqFallbackConfig } from './supabaseSync.ts';

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
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
];

function safeDiagnosticMessage(error: any): string {
  return String(error?.message || error || 'Unknown error')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_API_KEY]')
    .replace(/sk-or-v1-[A-Za-z0-9]{20,}/g, '[REDACTED_API_KEY]')
    .replace(/gsk_[A-Za-z0-9]{20,}/g, '[REDACTED_API_KEY]')
    .slice(0, 600);
}

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
const MAX_MODELS_PER_KEY_PER_REQUEST = 3;
const GENERAL_MAX_ROTATION_CYCLES = 2;

function rotationPairKey(key: string, model: string): string {
  return `${key}:${model}`;
}

// Persist only a one-way key fingerprint with the model; never store API keys in job payloads.
function rotationProgressPairId(key: string, model: string): string {
  const keyFingerprint = createHash('sha256').update(key).digest('hex').slice(0, 24);
  return `${keyFingerprint}:${model}`;
}

async function recordRotationProgress(options: KeyRotationExecutionOptions | undefined, key: string, model: string) {
  const progress = options?.rotationAttemptedPairs;
  if (!progress) return;
  const id = rotationProgressPairId(key, model);
  if (progress.includes(id)) return;
  progress.push(id);
  try {
    await options?.persistRotationProgress?.([...progress]);
  } catch (error: any) {
    removeRotationProgress(options, key, model);
    const persistError: any = new Error('تعذر حفظ موضع تدوير مفاتيح Gemini على الخادم قبل بدء المحاولة. ستتم إعادة جدولة المهمة.');
    persistError.status = 503;
    persistError.statusCode = 503;
    persistError.rotationProgressPersistenceFailed = true;
    persistError.cause = error;
    throw persistError;
  }
}

function removeRotationProgress(options: KeyRotationExecutionOptions | undefined, key: string, model: string): { progress: string[]; id: string; index: number } | null {
  const progress = options?.rotationAttemptedPairs;
  if (!progress) return null;
  const id = rotationProgressPairId(key, model);
  const index = progress.indexOf(id);
  if (index < 0) return null;
  progress.splice(index, 1);
  return { progress, id, index };
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
  } else if (kind === 'quota' || status === 429) {
    if (pool === 'ocr') keyCooldowns.set(key, now + KEY_QUOTA_COOLDOWN_MS);
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

function selectModelsForKey( models: string[], key: string, pool: 'general' | 'ocr' = 'general', now = Date.now(), avoidPairs?: Set<string>, maxModels = MAX_MODELS_PER_KEY_PER_REQUEST, retryCoolingPairs = false, ): string[] {
  const pairCooldowns = pool === 'ocr' ? ocrKeyModelCooldownUntil : keyModelCooldownUntil;
  const modelCooldowns = pool === 'ocr' ? ocrModelCooldownUntil : modelCooldownUntil;
  const available = models.filter((model) =>
    (retryCoolingPairs || !isCooling(modelCooldowns, model, now)) &&
    (retryCoolingPairs || !isCooling(pairCooldowns, rotationPairKey(key, model), now)) &&
    !avoidPairs?.has(`${key}::${model}`)
  );
  return available.slice(0, Math.max(0, maxModels));
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
  const msg = String(err?.message || err?.error?.message || '').toLowerCase();
  const status = Number(err?.status || err?.statusCode || err?.response?.status);
  if (status === 429 || /resource_exhausted|quota exceeded|rate.?limit|too many requests/.test(msg)) return 'quota';
  if (status === 401 || /api key not valid|invalid api key|api_key_invalid|key.*(invalid|revoked|deleted)|credential.*invalid/.test(msg)) return 'invalid';
  if (status === 503 || status === 504 || /timeout|timed out|aborted|high demand|service unavailable|temporarily unavailable|\b503\b/.test(msg)) return 'temporary';
  return 'other';
}

function isRetryableRotationFailure(err: any): boolean {
  const status = Number(err?.status || err?.statusCode || err?.response?.status);
  const message = String(err?.message || err?.error?.message || '').toLowerCase();
  if (status === 408 || status === 504) return true;
  return /network|fetch failed|connection reset|connection refused|socket|econn|timed out|timeout|aborted/.test(message);
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

/** * دالة استخراج النص الخاصة بـ Groq الاحتياطي المباشر (المجاني) عندما تفشل محاولات Gemini */
async function executeGroqOCRFallback(action: (ai: GoogleGenAI, key: string, model: string) => Promise<any>, deadlineAt = Date.now() + 90000): Promise<any> {
  const fallbackConfig = await fetchServerCloudOCRGroqFallbackConfig();
  if (!fallbackConfig.enabled || !fallbackConfig.apiKey) {
    throw new Error('احتياطي Groq لـ OCR غير مفعل أو لم يتم حفظ مفتاحه.');
  }

  console.log('🔄 جاري تشغيل بديل Groq المباشر لـ OCR...');
  
  const remainingMs = Math.max(1000, deadlineAt - Date.now());
  
  // الاتصال المباشر بخوادم Groq عبر واجهة OpenAI المتوافقة
  const client = createOpenAICompatibleClient(
    Math.min(60000, remainingMs), 
    deadlineAt, 
    'https://api.groq.com/openai/v1', 
    fallbackConfig.apiKey
  );
  
  const modelToUse = fallbackConfig.model || 'meta-llama/llama-3.2-11b-vision-preview';
  
  return await action(client as unknown as GoogleGenAI, fallbackConfig.apiKey, modelToUse);
}

/** تدوير OCR المكثف عبر مفاتيح Gemini أولاً، وعند فشلها يتم الانتقال التلقائي لـ Groq المباشر */
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
    // Reserve most of each round for a full Gemini key/model rotation; Groq remains the fallback.
    const geminiDeadlineAt = roundStart + Math.floor((roundEnd - roundStart) * 0.88);
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

    console.warn(`⚠️ فشلت محاولات Gemini لـ OCR في الجولة ${round + 1}. جاري تجربة Groq المباشر الاحتياطي...`);
    try {
      if (roundEnd - Date.now() < 10000) {
        lastError = lastError || new Error('لم يتبق وقت كاف لتجربة Groq في هذه الجولة.');
        continue;
      }
      const groqResult = await executeGroqOCRFallback(action, roundEnd);
      if (groqResult) {
        console.log(`✅ تم إتمام استخراج النص بنجاح عبر Groq المباشر في الجولة ${round + 1}!`);
        return groqResult;
      }
      lastError = new Error('أعاد Groq نتيجة فارغة لاستخراج النص.');
    } catch (groqError: any) {
      lastError = groqError;
      console.error(`❌ فشل Groq المباشر في الجولة ${round + 1}:`, groqError?.message);
    }

    if (Date.now() >= deadlineAt || deadlineAt - Date.now() < 10000) break;
  }

  const finalError: any = new Error(`فشلت محاولتان كاملتان لاستخراج النص: Gemini بمفاتيح ونماذج ثم Groq. ${String(lastError?.message || '')}`);
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
  providerAttempt?: 'gemini-primary' | 'groq-fallback';
  /** Previously used key/model pairs are avoided first during continuation. */
  avoidPairs?: string[];
  /** Force two complete Gemini key/model passes before direct Groq fallback. */
  fullGeminiRetryPass?: boolean;
  /** Match the reference's single complete Gemini key/model rotation for drafting. */
  singleGeminiRotationPass?: boolean;
  /** Hashed Gemini key/model pairs already attempted by this durable job. Mutated as attempts begin. */
  rotationAttemptedPairs?: string[];
  /** Durably save the attempted-pair set before sending a provider request. */
  persistRotationProgress?: (pairs: string[]) => Promise<void>;
};

async function getDirectGroqConfig() {
  let stored: any = null;
  try {
    stored = await fetchServerCloudOCRGroqFallbackConfig();
  } catch {
    // A missing OCR-specific setting must not prevent use of a server env key.
  }
  const apiKey = String((stored?.enabled && stored?.apiKey) || process.env.GROQ_API_KEY || '').trim();
  const model = String(process.env.GROQ_MODEL || 'openai/gpt-oss-120b').trim();
  if (!apiKey) {
    const error: any = new Error('احتياطي Groq غير مضبوط؛ فعّل إعداد Groq الموجود في إعدادات OCR أو أضف GROQ_API_KEY إلى متغيرات Vercel.');
    error.status = 503;
    error.statusCode = 503;
    throw error;
  }
  return { apiKey, model };
}

export async function executeWithKeyRotation<T>(
  action: (ai: GoogleGenAI, key: string, model: string) => Promise<T>,
  preferredModels: string[] = GEMINI_MODELS,
  _ignoredClientFallbackKey?: string,
  _forceGeminiFallback = false,
  executionOptions?: KeyRotationExecutionOptions
): Promise<T> {
  if (!executionOptions?.deadlineAt) {
    executionOptions = { ...executionOptions, deadlineAt: Date.now() + (executionOptions?.ocrMode ? 240000 : 270000) };
  }
  const deadlineAt = Number(executionOptions.deadlineAt);
  const timeoutError = () => Object.assign(
    new Error('انتهت المهلة المتاحة لتوليد النتيجة قبل اكتمالها.'),
    { status: 504, statusCode: 504 },
  );

  if (!_forceGeminiFallback && !executionOptions?.ocrMode && !executionOptions?.providerAttempt) {
    const totalBudget = Math.max(0, deadlineAt - Date.now());
    const groqReserveMs = Math.floor(totalBudget * 0.1);
    const geminiDeadlineAt = deadlineAt - groqReserveMs;
    let geminiError: any = null;

    // Complete the Gemini key/model rotation before allowing generation fallback.
    try {
      return await executeWithKeyRotation(action, preferredModels, _ignoredClientFallbackKey, true, {
        ...executionOptions,
        deadlineAt: geminiDeadlineAt,
        providerAttempt: 'gemini-primary',
      });
    } catch (error: any) {
      geminiError = error;
      if (error?.geminiPassesIncomplete || error?.rotationProgressPersistenceFailed) throw error;
    }

    if (deadlineAt - Date.now() < 10000) throw geminiError || timeoutError();

    try {
      return await executeWithKeyRotation(action, preferredModels, _ignoredClientFallbackKey, false, {
        ...executionOptions,
        deadlineAt,
        providerAttempt: 'groq-fallback',
        previousProviderError: String(geminiError?.message || 'تعذر استخدام Gemini.'),
      });
    } catch (groqError: any) {
      const combined: any = new Error(
        `تعذر تنفيذ الطلب بعد استنفاد محاولات Gemini وتجربة احتياطي Groq المباشر. (Gemini: ${String(geminiError?.message || 'غير معروف')}؛ Groq: ${String(groqError?.message || 'غير معروف')}).`,
      );
      combined.status = groqError?.status || groqError?.statusCode || geminiError?.status || geminiError?.statusCode || 503;
      combined.statusCode = combined.status;
      combined.cause = groqError;
      throw combined;
    }
  }

  if (!_forceGeminiFallback) {
    const { apiKey, model } = await getDirectGroqConfig().catch((error: any) => {
      if (executionOptions?.ocrMode) return { apiKey: '', model: '' };
      throw error;
    });
    if (!apiKey) return executeWithKeyRotation(action, preferredModels, _ignoredClientFallbackKey, true, executionOptions);
    try {
      const client = withAdaptiveAnswerLength(
        createOpenAICompatibleClient(15000, deadlineAt, 'https://api.groq.com/openai/v1', apiKey),
      ) as unknown as GoogleGenAI;
      const result = await action(client, 'groq', model);
      if (Date.now() >= deadlineAt) throw timeoutError();
      return result;
    } catch (error: any) {
      if (executionOptions?.ocrMode && deadlineAt - Date.now() >= 10000) {
        return executeWithKeyRotation(action, preferredModels, _ignoredClientFallbackKey, true, executionOptions);
      }
      throw error;
    }
  }

  const keys = (await getAvailableGeminiKeys()).filter((key) => !permanentlyInvalidKeys.has(key));
  if (keys.length === 0) {
    throw new Error('لم يتم العثور على مفتاح Gemini صالح في إعدادات الخادم.');
  }

  if (activeKeyIndex >= keys.length) activeKeyIndex = 0;

  let lastError: any = null;
  let attemptedModelCount = 0;
  const avoidedPairs = new Set(executionOptions?.avoidPairs || []);
  const attemptedBeforeRun = new Set(executionOptions?.rotationAttemptedPairs || []);
  const keyFailureKinds = new Map<string, string>();
  const retryablePairs = new Set<string>();
  const startIdx = reserveStartIndex(keys.length, 'general');
  const totalGeminiBudget = Math.max(0, deadlineAt - Date.now());
  // Keep a small, explicit window for one retry pass; the rest remains available
  // for the first pass and normal model response time.
  const exhaustiveGeminiPasses = executionOptions?.fullGeminiRetryPass === true;
  const firstCycleDeadlineAt = exhaustiveGeminiPasses
    ? Date.now() + Math.floor(totalGeminiBudget / 2)
    : deadlineAt - Math.min(30000, Math.max(10000, Math.floor(totalGeminiBudget * 0.12)));
  let completedGeminiPasses = 0;

  const maxRotationCycles = executionOptions?.singleGeminiRotationPass === true ? 1 : GENERAL_MAX_ROTATION_CYCLES;
  for (let cycle = 0; cycle < maxRotationCycles; cycle++) {
    if (cycle > 0) {
      if ((!exhaustiveGeminiPasses && retryablePairs.size === 0) || Date.now() >= deadlineAt) break;
      await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(0, deadlineAt - Date.now()))));
    }
    let passCompleted = true;
    geminiKeyLoop: for (let offset = 0; offset < keys.length; offset++) {
      if (exhaustiveGeminiPasses && cycle === 0 && Date.now() >= firstCycleDeadlineAt) {
        passCompleted = false;
        break geminiKeyLoop;
      }
      const currentKeyIndex = (startIdx + offset) % keys.length;
      const currentKey = keys[currentKeyIndex];
      if ((!exhaustiveGeminiPasses && isCooling(keyCooldownUntil, currentKey)) || permanentlyInvalidKeys.has(currentKey)) continue;
      const keyModels = (cycle === 0
        ? selectModelsForKey(preferredModels, currentKey, 'general', Date.now(), avoidedPairs, preferredModels.length, exhaustiveGeminiPasses)
        : exhaustiveGeminiPasses
          ? preferredModels.filter((model) => !avoidedPairs.has(`${currentKey}::${model}`))
          : preferredModels.filter((model) => retryablePairs.has(rotationPairKey(currentKey, model)) && !avoidedPairs.has(`${currentKey}::${model}`)))
        .filter((model) => !attemptedBeforeRun.has(rotationProgressPairId(currentKey, model)));

      for (let m = 0; m < keyModels.length; m++) {
        const model = keyModels[m];
        const pair = rotationPairKey(currentKey, model);
        if (cycle > 0) retryablePairs.delete(pair);
        attemptedModelCount += 1;
        await recordRotationProgress(executionOptions, currentKey, model);
        const cycleDeadlineAt = cycle === 0 ? firstCycleDeadlineAt : deadlineAt;
        const remainingMs = cycleDeadlineAt - Date.now();
        if (remainingMs < 1000) {
          lastError = timeoutError();
          passCompleted = false;
          break geminiKeyLoop;
        }
        const ai = withAdaptiveAnswerLength(createGeminiClient(currentKey, Math.min(30000, remainingMs)));
        try {
          const result = await action(ai, currentKey, model);
          if (Date.now() >= deadlineAt) throw timeoutError();
          activeKeyIndex = currentKeyIndex;
          return result;
        } catch (err: any) {
          lastError = err;
          const kind = markRotationFailure(currentKey, model, err, 'general');
          keyFailureKinds.set(currentKey, kind);
          if (cycle === 0 && isRetryableRotationFailure(err)) retryablePairs.add(pair);
          activeKeyIndex = keys.length > 1 ? (currentKeyIndex + 1) % keys.length : currentKeyIndex;
          if (permanentlyInvalidKeys.has(currentKey)) break;
          if (exhaustiveGeminiPasses && Date.now() >= cycleDeadlineAt) {
            passCompleted = false;
            break geminiKeyLoop;
          }
        }
      }
    }
    if (exhaustiveGeminiPasses) {
      if (cycle === 0 && Date.now() >= firstCycleDeadlineAt) passCompleted = false;
      if (!passCompleted) break;
      completedGeminiPasses += 1;
    }
  }

  if (exhaustiveGeminiPasses && completedGeminiPasses < 2) {
    const incompletePassError: any = timeoutError();
    incompletePassError.geminiPassesIncomplete = true;
    throw incompletePassError;
  }

  if (attemptedModelCount === 0 && attemptedBeforeRun.size > 0 && executionOptions?.rotationAttemptedPairs?.length && Date.now() < deadlineAt) {
    const progress = executionOptions.rotationAttemptedPairs;
    progress.splice(0, progress.length);
    return executeWithKeyRotation(action, preferredModels, _ignoredClientFallbackKey, _forceGeminiFallback, {
      ...executionOptions,
      rotationAttemptedPairs: progress,
    });
  }

  if (attemptedModelCount === 0 && avoidedPairs.size > 0 && Date.now() < deadlineAt) {
    if (executionOptions?.providerAttempt === 'gemini-primary') {
      throw Object.assign(new Error('لا توجد أزواج مفتاح/نموذج غير مستخدمة متاحة للاستكمال عبر Gemini.'), { status: 503, statusCode: 503 });
    }
    return executeWithKeyRotation(action, preferredModels, _ignoredClientFallbackKey, true, {
      ...executionOptions,
      avoidPairs: undefined,
    });
  }

  const finalKind = getGeminiErrorKind(lastError);
  if (finalKind === 'quota') {
    const quotaError: any = new Error('تعذر تنفيذ الطلب: استنفدت حصص مفاتيح Gemini المتاحة أو تم بلوغ حد الاستخدام.');
    quotaError.allGeminiQuotasExhausted = keys.length > 0 && keys.every((key) => keyFailureKinds.get(key) === 'quota');
    throw quotaError;
  }
  throw lastError || new Error('فشلت جميع محاولات تدوير المفاتيح.');
}

export async function executeWithKeyRotationStream( action: (ai: GoogleGenAI, key: string, model: string) => Promise<AsyncIterable<any>>, onChunk: (text: string) => void, preferredModels: string[] = GEMINI_MODELS, _ignoredClientFallbackKey?: string, _forceGeminiFallback = false, executionOptions?: KeyRotationExecutionOptions ): Promise<void> {
  if (!executionOptions?.deadlineAt) {
    executionOptions = { ...executionOptions, deadlineAt: Date.now() + 270000 };
  }
  const deadlineAt = Number(executionOptions.deadlineAt);
  const timeoutError = () => Object.assign(new Error('انتهت المهلة المتاحة للتوليد.'), { status: 504, statusCode: 504 });

  if (!_forceGeminiFallback && !executionOptions?.ocrMode && !executionOptions?.providerAttempt) {
    const totalBudget = Math.max(0, deadlineAt - Date.now());
    const groqReserveMs = Math.floor(totalBudget * 0.1);
    const geminiDeadlineAt = deadlineAt - groqReserveMs;
    let geminiError: any = null;
    let geminiEmittedText = false;

    // Complete the Gemini key/model rotation before allowing generation fallback.
    try {
      await executeWithKeyRotationStream(action, (chunk) => {
        if (chunk) geminiEmittedText = true;
        onChunk(chunk);
      }, preferredModels, _ignoredClientFallbackKey, true, {
        ...executionOptions,
        deadlineAt: geminiDeadlineAt,
        providerAttempt: 'gemini-primary',
      });
      return;
    } catch (error: any) {
      geminiError = error;
      if (error?.geminiPassesIncomplete || error?.rotationProgressPersistenceFailed) throw error;
      // Never restart the same document with another provider after text was shown.
      if (geminiEmittedText) throw error;
    }

    if (deadlineAt - Date.now() < 10000) throw geminiError || timeoutError();

    let groqEmittedText = false;
    try {
      await executeWithKeyRotationStream(action, (chunk) => {
        if (chunk) groqEmittedText = true;
        onChunk(chunk);
      }, preferredModels, _ignoredClientFallbackKey, false, {
        ...executionOptions,
        deadlineAt,
        providerAttempt: 'groq-fallback',
        previousProviderError: String(geminiError?.message || 'تعذر استخدام Gemini.'),
      });
      return;
    } catch (groqError: any) {
      if (groqEmittedText) throw groqError;
      const combined: any = new Error(
        `تعذر تنفيذ الطلب بعد استنفاد محاولات Gemini وتجربة احتياطي Groq المباشر. (Gemini: ${String(geminiError?.message || 'غير معروف')}؛ Groq: ${String(groqError?.message || 'غير معروف')}).`,
      );
      combined.status = groqError?.status || groqError?.statusCode || geminiError?.status || geminiError?.statusCode || 503;
      combined.statusCode = combined.status;
      combined.cause = groqError;
      throw combined;
    }
  }

  if (!_forceGeminiFallback && executionOptions?.providerAttempt === 'groq-fallback' && !executionOptions?.ocrMode) {
    const { apiKey, model } = await getDirectGroqConfig();
    const ai = withAdaptiveAnswerLength(
      createOpenAICompatibleClient(60000, deadlineAt, 'https://api.groq.com/openai/v1', apiKey),
    ) as unknown as GoogleGenAI;
    let emittedGroqText = false;
    try {
      const stream = await action(ai, 'groq', model);
      for await (const chunk of stream) {
        const text = typeof chunk?.text === 'string' ? chunk.text : '';
        if (text) {
          emittedGroqText = true;
          onChunk(text);
        }
      }
      if (!emittedGroqText) {
        const emptyError: any = new Error(`أعاد نموذج Groq (${model}) استجابة فارغة.`);
        emptyError.status = 503;
        emptyError.statusCode = 503;
        throw emptyError;
      }
      return;
    } catch (error: any) {
      if (emittedGroqText) throw error;
      throw error;
    }
  }

  const keys = (await getAvailableGeminiKeys()).filter((key) => !permanentlyInvalidKeys.has(key));
  if (keys.length === 0) throw new Error('لم يتم العثور على مفتاح Gemini صالح.');

  const avoidedPairs = new Set(executionOptions?.avoidPairs || []);
  const attemptedBeforeRun = new Set(executionOptions?.rotationAttemptedPairs || []);
  const retryablePairs = new Set<string>();
  let attemptedModelCount = 0;
  let lastGeminiError: any = null;
  let lastFailedModel = '';
  let lastFailedKeyIndex = 0;
  const startIdx = reserveStartIndex(keys.length, 'general');
  const totalGeminiBudget = Math.max(0, deadlineAt - Date.now());
  const exhaustiveGeminiPasses = executionOptions?.fullGeminiRetryPass === true;
  const firstCycleDeadlineAt = exhaustiveGeminiPasses
    ? Date.now() + Math.floor(totalGeminiBudget / 2)
    : deadlineAt - Math.min(30000, Math.max(10000, Math.floor(totalGeminiBudget * 0.12)));
  let completedGeminiPasses = 0;

  for (let cycle = 0; cycle < GENERAL_MAX_ROTATION_CYCLES; cycle++) {
    if (cycle > 0) {
      if ((!exhaustiveGeminiPasses && retryablePairs.size === 0) || Date.now() >= deadlineAt) break;
      await new Promise((r) => setTimeout(r, Math.min(1000, Math.max(0, deadlineAt - Date.now()))));
    }
    let passCompleted = true;
    geminiKeyLoop: for (let offset = 0; offset < keys.length; offset++) {
      if (exhaustiveGeminiPasses && cycle === 0 && Date.now() >= firstCycleDeadlineAt) {
        passCompleted = false;
        break geminiKeyLoop;
      }
      const currentKeyIndex = (startIdx + offset) % keys.length;
      const currentKey = keys[currentKeyIndex];
      if (permanentlyInvalidKeys.has(currentKey)) continue;
      const keyModels = (cycle === 0
        ? selectModelsForKey(preferredModels, currentKey, 'general', Date.now(), avoidedPairs, preferredModels.length, exhaustiveGeminiPasses)
        : exhaustiveGeminiPasses
          ? preferredModels.filter((model) => !avoidedPairs.has(`${currentKey}::${model}`))
          : preferredModels.filter((model) => retryablePairs.has(rotationPairKey(currentKey, model)) && !avoidedPairs.has(`${currentKey}::${model}`)))
        .filter((model) => !attemptedBeforeRun.has(rotationProgressPairId(currentKey, model)));

      for (let m = 0; m < keyModels.length; m++) {
        const model = keyModels[m];
        const pair = rotationPairKey(currentKey, model);
        if (cycle > 0) retryablePairs.delete(pair);
        const cycleDeadlineAt = cycle === 0 ? firstCycleDeadlineAt : deadlineAt;
        const remainingMs = cycleDeadlineAt - Date.now();
        if (remainingMs < 1000) {
          passCompleted = false;
          break geminiKeyLoop;
        }
        attemptedModelCount += 1;
        await recordRotationProgress(executionOptions, currentKey, model);
        const ai = withAdaptiveAnswerLength(createGeminiClient(currentKey, Math.min(120000, Math.max(1000, remainingMs))));
        let emittedAnyChunk = false;
        try {
          const stream = await action(ai, currentKey, model);
          for await (const chunk of stream) {
            const text = typeof chunk?.text === 'string' ? chunk.text : '';
            if (text) {
              emittedAnyChunk = true;
              onChunk(text);
            }
          }
          activeKeyIndex = currentKeyIndex;
          return;
        } catch (err: any) {
          lastGeminiError = err;
          lastFailedModel = model;
          lastFailedKeyIndex = currentKeyIndex + 1;
          markRotationFailure(currentKey, model, err, 'general');
          if (cycle === 0 && !emittedAnyChunk && isRetryableRotationFailure(err)) retryablePairs.add(pair);
          console.warn('[Gemini stream attempt failed]', {
            provider: 'Gemini',
            model,
            keyIndex: currentKeyIndex + 1,
            status: Number(err?.status || err?.statusCode || err?.response?.status) || null,
            message: safeDiagnosticMessage(err),
          });
          if (emittedAnyChunk) {
            activeKeyIndex = keys.length > 1 ? (currentKeyIndex + 1) % keys.length : currentKeyIndex;
            throw err;
          }
          if (permanentlyInvalidKeys.has(currentKey)) break;
          if (exhaustiveGeminiPasses && Date.now() >= cycleDeadlineAt) {
            passCompleted = false;
            break geminiKeyLoop;
          }
        }
      }
    }
    if (exhaustiveGeminiPasses) {
      if (cycle === 0 && Date.now() >= firstCycleDeadlineAt) passCompleted = false;
      if (!passCompleted) break;
      completedGeminiPasses += 1;
    }
  }
  if (exhaustiveGeminiPasses && completedGeminiPasses < 2) {
    const incompletePassError: any = timeoutError();
    incompletePassError.geminiPassesIncomplete = true;
    throw incompletePassError;
  }

  if (attemptedModelCount === 0 && attemptedBeforeRun.size > 0 && executionOptions?.rotationAttemptedPairs?.length && Date.now() < deadlineAt) {
    const progress = executionOptions.rotationAttemptedPairs;
    progress.splice(0, progress.length);
    return executeWithKeyRotationStream(action, onChunk, preferredModels, _ignoredClientFallbackKey, _forceGeminiFallback, {
      ...executionOptions,
      rotationAttemptedPairs: progress,
    });
  }

  if (attemptedModelCount === 0 && avoidedPairs.size > 0 && Date.now() < deadlineAt) {
    if (executionOptions?.providerAttempt === 'gemini-primary') {
      throw Object.assign(new Error('لا توجد أزواج مفتاح/نموذج غير مستخدمة متاحة للاستكمال عبر Gemini.'), { status: 503, statusCode: 503 });
    }
    return executeWithKeyRotationStream(action, onChunk, preferredModels, _ignoredClientFallbackKey, true, {
      ...executionOptions,
      avoidPairs: undefined,
    });
  }
  const failureStatus = Number(lastGeminiError?.status || lastGeminiError?.statusCode || lastGeminiError?.response?.status) || 503;
  const diagnostic = lastGeminiError
    ? `آخر محاولة: Gemini model ${lastFailedModel || 'غير معروف'}، المفتاح رقم ${lastFailedKeyIndex || 'غير معروف'}، HTTP ${failureStatus}: ${safeDiagnosticMessage(lastGeminiError)}`
    : 'لم تُنفذ محاولة Gemini؛ لا توجد أزواج مفتاح/نموذج متاحة أو انتهت المهلة قبل بدء المحاولة.';
  const finalError: any = new Error(`فشلت جميع محاولات تدوير بث Gemini. ${diagnostic}`);
  finalError.status = failureStatus;
  finalError.statusCode = failureStatus;
  finalError.provider = 'Gemini';
  finalError.model = lastFailedModel || undefined;
  finalError.cause = lastGeminiError;
  throw finalError;
}

export default function handler(req: any, res: any) {
  return res.status(200).json({ ok: true, activeKeys: getKeysStatus().totalCount });
}
