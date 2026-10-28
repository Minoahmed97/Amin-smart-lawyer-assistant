import { GoogleGenAI } from '@google/genai';
import { sanitizeGeminiKey } from './centralKeys.ts';
import fs from 'fs';
import path from 'path';
import { createOpenRouterCompatibleClient, getOpenRouterModels } from './openrouterAdapter.ts';
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
const MAX_MODELS_PER_KEY_PER_REQUEST = 2;

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

function selectModelsForKey(
  models: string[],
  key: string,
  pool: 'general' | 'ocr' = 'general',
  now = Date.now(),
  avoidPairs?: Set<string>,
): string[] {
  const pairCooldowns = pool === 'ocr' ? ocrKeyModelCooldownUntil : keyModelCooldownUntil;
  const modelCooldowns = pool === 'ocr' ? ocrModelCooldownUntil : modelCooldownUntil;
  const available = models.filter((model) =>
    !isCooling(modelCooldowns, model, now) &&
    !isCooling(pairCooldowns, rotationPairKey(key, model), now) &&
    !avoidPairs?.has(`${key}::${model}`)
  );
  return available.slice(0, MAX_MODELS_PER_KEY_PER_REQUEST);
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

function shouldFallbackFromOpenRouter(error: any): boolean {
  const status = Number(error?.status || error?.statusCode || error?.response?.status);
  const message = String(error?.message || error?.error?.message || '').toLowerCase();
  return status === 401 || status === 402 || status === 403 || status === 404 || status === 408 || status === 413 || status === 429 || status >= 500 ||
    (status === 400 && /max_tokens|context.?length|model|unsupported|parameter/.test(message)) ||
    /quota|rate.?limit|free.*(limit|unavailable|exhaust)|no free models|temporarily unavailable|service unavailable|timed out|timeout/.test(message);
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

/** 
 * دالة استخراج النص الخاصة بـ Groq الاحتياطي المباشر (المجاني) عندما تفشل محاولات Gemini 
 */
async function executeGroqOCRFallback(action: (ai: GoogleGenAI, key: string, model: string) => Promise<any>, deadlineAt = Date.now() + 90000): Promise<any> {
  const fallbackConfig = await fetchServerCloudOCRGroqFallbackConfig();
  if (!fallbackConfig.enabled || !fallbackConfig.apiKey) {
    throw new Error('احتياطي Groq لـ OCR غير مفعل أو لم يتم حفظ مفتاحه.');
  }

  console.log('🔄 جاري تشغيل بديل Groq المباشر لـ OCR...');
  
  const remainingMs = Math.max(1000, deadlineAt - Date.now());
  
  // الاتصال المباشر بخوادم Groq لمنع أخطاء الـ 402 الخاصة بـ OpenRouter
  const client = createOpenRouterCompatibleClient(
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
    const geminiDeadlineAt = roundStart + Math.floor((roundEnd - roundStart) * 0.55);
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
        const keyModels = selectModelsForKey(preferredModels, key, 'ocr');

        for (let modelIndex = 0; modelIndex < keyModels.length; modelIndex++) {
          const remainingMs = geminiDeadlineAt - Date.now();
          if (remainingMs < 10000) break ocrKeyLoop;
          const model = keyModels[modelIndex];
          try {
            const ai = withAdaptiveAnswerLength(createGeminiClient(key, Math.min(18000, remainingMs)));
            const result = await action(ai, key, model);
            if (Date.now() >= geminiDeadlineAt) throw Object.assign(new Error('انتهت مهلة محاولة OCR عبر Gemini.'), { status: 504, statusCode: 504 });
            dedicatedOCRActiveKey = key;
            return result;
          } catch (error: any) {
            lastError = error;
            markRotationFailure(key, model, error, 'ocr');
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
  providerAttempt?: 'gemini-primary' | 'openrouter-fallback';
  /** Previously used key/model pairs are avoided first during continuation. */
  avoidPairs?: string[];
};

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
    const overallStart = Date.now();
    const totalBudget = Math.max(0, deadlineAt - overallStart);
    let lastProviderError: any = null;

    for (let round = 0; round < 2; round++) {
      const roundStart = overallStart + Math.floor(totalBudget * round / 2);
      const roundEnd = overallStart + Math.floor(totalBudget * (round + 1) / 2);
      const geminiDeadlineAt = roundStart + Math.floor((roundEnd - roundStart) * 0.55);
      if (deadlineAt - Date.now() < 10000) break;
      try {
        return await executeWithKeyRotation(action, preferredModels, _ignoredClientFallbackKey, true, {
          ...executionOptions,
          deadlineAt: geminiDeadlineAt,
          providerAttempt: 'gemini-primary',
        });
      } catch (geminiError: any) {
        lastProviderError = geminiError;
      }
      if (roundEnd - Date.now() < 10000) break;
      try {
        return await executeWithKeyRotation(action, preferredModels, _ignoredClientFallbackKey, false, {
          ...executionOptions,
          deadlineAt: roundEnd,
          providerAttempt: 'openrouter-fallback',
          previousProviderError: String(lastProviderError?.message || 'تعذر استخدام Gemini.'),
        });
      } catch (openRouterError: any) {
        lastProviderError = openRouterError;
      }
    }
    const combined: any = new Error('تعذر تنفيذ الطلب بعد محاولتين كاملتين: Gemini أولاً ثم OpenRouter في كل محاولة.');
    combined.status = 503;
    combined.statusCode = 503;
    combined.cause = lastProviderError;
    throw combined;
  }

  if (!_forceGeminiFallback) {
    const availableModels = executionOptions?.ocrMode ? ['openrouter/free'] : getOpenRouterModels();
    const avoidedPairs = new Set(executionOptions?.avoidPairs || []);
    const preferredModelsForAttempt = availableModels.filter((model) => !avoidedPairs.has(`openrouter::${model}`));
    const models = preferredModelsForAttempt.length ? preferredModelsForAttempt : availableModels;
    let lastError: any = null;
    if (!process.env.OPENROUTER_API_KEY?.trim()) {
      lastError = Object.assign(new Error('مفتاح OpenRouter غير مضبوط.'), { status: 503, statusCode: 503 });
    }
    for (const model of (process.env.OPENROUTER_API_KEY?.trim() ? models : [])) {
      try {
        const result = await action(
          withAdaptiveAnswerLength(createOpenRouterCompatibleClient(12000, deadlineAt)) as unknown as GoogleGenAI,
          'openrouter',
          model,
        );
        if (Date.now() >= deadlineAt) throw timeoutError();
        return result;
      } catch (error: any) {
        lastError = error;
      }
    }
    if ((executionOptions?.ocrMode || shouldFallbackFromOpenRouter(lastError)) && executionOptions?.providerAttempt !== 'openrouter-fallback') {
      if (deadlineAt - Date.now() < 10000) throw timeoutError();
      return executeWithKeyRotation(action, preferredModels, _ignoredClientFallbackKey, true, executionOptions);
    }
    throw lastError || new Error('تعذر الاتصال بننماذج OpenRouter.');
  }

  const keys = (await getAvailableGeminiKeys()).filter((key) => !permanentlyInvalidKeys.has(key));
  if (keys.length === 0) {
    throw new Error('لم يتم العثور على مفتاح Gemini صالح في إعدادات الخادم.');
  }

  if (activeKeyIndex >= keys.length) activeKeyIndex = 0;

  const MAX_ROTATION_CYCLES = 1;
  let lastError: any = null;
  let attemptedModelCount = 0;
  const avoidedPairs = new Set(executionOptions?.avoidPairs || []);
  const keyFailureKinds = new Map<string, string>();

  for (let cycle = 0; cycle < MAX_ROTATION_CYCLES; cycle++) {
    if (cycle > 0) {
      await new Promise((r) => setTimeout(r, 2000));
    }

    const startIdx = reserveStartIndex(keys.length, 'general');
    geminiKeyLoop: for (let offset = 0; offset < keys.length; offset++) {
      const currentKeyIndex = (startIdx + offset) % keys.length;
      const currentKey = keys[currentKeyIndex];
      if (isCooling(keyCooldownUntil, currentKey) || permanentlyInvalidKeys.has(currentKey)) continue;
      const keyModels = selectModelsForKey(preferredModels, currentKey, 'general', Date.now(), avoidedPairs);

      for (let m = 0; m < keyModels.length; m++) {
        attemptedModelCount += 1;
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs < 10000) {
          lastError = timeoutError();
          break geminiKeyLoop;
        }
        const model = keyModels[m];
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
          activeKeyIndex = keys.length > 1 ? (currentKeyIndex + 1) % keys.length : currentKeyIndex;
          if (permanentlyInvalidKeys.has(currentKey)) break;
        }
      }
    }
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

export async function executeWithKeyRotationStream(
  action: (ai: GoogleGenAI, key: string, model: string) => Promise<AsyncIterable<any>>,
  onChunk: (text: string) => void,
  preferredModels: string[] = GEMINI_MODELS,
  _ignoredClientFallbackKey?: string,
  _forceGeminiFallback = false,
  executionOptions?: KeyRotationExecutionOptions
): Promise<void> {
  if (!executionOptions?.deadlineAt) {
    executionOptions = { ...executionOptions, deadlineAt: Date.now() + 270000 };
  }
  const deadlineAt = Number(executionOptions.deadlineAt);
  const timeoutError = () => Object.assign(new Error('انتهت المهلة المتاحة للتوليد.'), { status: 504, statusCode: 504 });

  if (!_forceGeminiFallback && !executionOptions?.ocrMode && !executionOptions?.providerAttempt) {
    const overallStart = Date.now();
    const totalBudget = Math.max(0, deadlineAt - overallStart);
    let lastProviderError: any = null;
    for (let round = 0; round < 2; round++) {
      const roundStart = overallStart + Math.floor(totalBudget * round / 2);
      const roundEnd = overallStart + Math.floor(totalBudget * (round + 1) / 2);
      const geminiDeadlineAt = roundStart + Math.floor((roundEnd - roundStart) * 0.55);
      if (deadlineAt - Date.now() < 10000) break;
      let anyProviderEmittedText = false;
      try {
        await executeWithKeyRotationStream(action, (chunk) => {
          if (chunk) anyProviderEmittedText = true;
          onChunk(chunk);
        }, preferredModels, _ignoredClientFallbackKey, true, {
          ...executionOptions,
          deadlineAt: geminiDeadlineAt,
          providerAttempt: 'gemini-primary',
        });
        return;
      } catch (geminiError: any) {
        lastProviderError = geminiError;
        if (anyProviderEmittedText) throw geminiError;
      }
      if (roundEnd - Date.now() < 10000) break;
      try {
        await executeWithKeyRotationStream(action, (chunk) => {
          if (chunk) anyProviderEmittedText = true;
          onChunk(chunk);
        }, preferredModels, _ignoredClientFallbackKey, false, {
          ...executionOptions,
          deadlineAt: roundEnd,
          providerAttempt: 'openrouter-fallback',
          previousProviderError: String(lastProviderError?.message || 'تعذر استخدام Gemini.'),
        });
        return;
      } catch (openRouterError: any) {
        lastProviderError = openRouterError;
        if (anyProviderEmittedText) throw openRouterError;
      }
    }
    const combined: any = new Error('تعذر تنفيذ الطلب بعد محاولتين كاملتين: Gemini أولاً ثم OpenRouter في كل محاولة.');
    combined.status = 503;
    combined.statusCode = 503;
    combined.cause = lastProviderError;
    throw combined;
  }

  if (!_forceGeminiFallback && executionOptions?.providerAttempt === 'openrouter-fallback' && !executionOptions?.ocrMode) {
    const availableModels = getOpenRouterModels();
    const avoidedPairs = new Set(executionOptions?.avoidPairs || []);
    const preferredModelsForAttempt = availableModels.filter((model) => !avoidedPairs.has(`openrouter::${model}`));
    const models = preferredModelsForAttempt.length ? preferredModelsForAttempt : availableModels;
    let lastOpenRouterError: any = null;

    if (!process.env.OPENROUTER_API_KEY?.trim()) {
      const missingKeyError: any = new Error('مفتاح OpenRouter غير مضبوط.');
      missingKeyError.status = 503;
      missingKeyError.statusCode = 503;
      throw missingKeyError;
    }

    for (const model of models) {
      if (deadlineAt - Date.now() < 10000) break;
      let emittedOpenRouterText = false;
      try {
        const ai = withAdaptiveAnswerLength(
          createOpenRouterCompatibleClient(12000, deadlineAt),
        ) as unknown as GoogleGenAI;
        const stream = await action(ai, 'openrouter', model);
        for await (const chunk of stream) {
          const text = typeof chunk?.text === 'string' ? chunk.text : '';
          if (text) {
            emittedOpenRouterText = true;
            onChunk(text);
          }
        }
        if (!emittedOpenRouterText) {
          const emptyError: any = new Error(`أعاد موديل OpenRouter (${model}) استجابة فارغة.`);
          emptyError.status = 503;
          emptyError.statusCode = 503;
          throw emptyError;
        }
        return;
      } catch (error: any) {
        if (emittedOpenRouterText) throw error;
        lastOpenRouterError = error;
      }
    }

    throw lastOpenRouterError || new Error('تعذر الحصول على نتيجة من نماذج OpenRouter الاحتياطية.');
  }

  const keys = (await getAvailableGeminiKeys()).filter((key) => !permanentlyInvalidKeys.has(key));
  if (keys.length === 0) throw new Error('لم يتم العثور على مفتاح Gemini صالح.');

  const avoidedPairs = new Set(executionOptions?.avoidPairs || []);
  let attemptedModelCount = 0;
  for (let cycle = 0; cycle < 1; cycle++) {
    const startIdx = reserveStartIndex(keys.length, 'general');
    for (let offset = 0; offset < keys.length; offset++) {
      const currentKeyIndex = (startIdx + offset) % keys.length;
      const currentKey = keys[currentKeyIndex];
      const keyModels = selectModelsForKey(preferredModels, currentKey, 'general', Date.now(), avoidedPairs);

      for (let m = 0; m < keyModels.length; m++) {
        attemptedModelCount += 1;
        const ai = withAdaptiveAnswerLength(createGeminiClient(currentKey, 18000));
        let emittedAnyChunk = false;
        try {
          const stream = await action(ai, currentKey, keyModels[m]);
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
          markRotationFailure(currentKey, keyModels[m], err, 'general');
          if (emittedAnyChunk) {
            activeKeyIndex = keys.length > 1 ? (currentKeyIndex + 1) % keys.length : currentKeyIndex;
            throw err;
          }
          if (permanentlyInvalidKeys.has(currentKey)) break;
        }
      }
    }
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
  throw new Error('فشلت جميع محاولات تدوير البث.');
}

export default function handler(req: any, res: any) {
  return res.status(200).json({ ok: true, activeKeys: getKeysStatus().totalCount });
}
