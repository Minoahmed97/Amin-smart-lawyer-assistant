import { GoogleGenAI } from '@google/genai';
import { sanitizeGeminiKey } from './centralKeys.ts';
import fs from 'fs';
import path from 'path';
import { createOpenRouterCompatibleClient, getOpenRouterModels } from './openrouterAdapter.ts';
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
  // Prefer the current stable Flash model, then stable fallbacks.
  // Gemini 3.7 Flash is deprecated and automatically routed to 3.8 Flash.
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
];

let activeKeyIndex = 0;
const permanentlyInvalidKeys = new Set<string>();
// A caller may bound an attempt when it must leave time to rotate providers or
// persist a terminal job state. Unbounded non-OCR requests retain their old behavior.
function createGeminiClient(apiKey: string, timeoutMs?: number): GoogleGenAI {
  const httpOptions: any = { headers: { 'User-Agent': 'aistudio-build' } };
  if (Number.isFinite(timeoutMs) && Number(timeoutMs) >= 1000) {
    // Keep OCR failover attempts bounded. Other AI features retain their prior timeout behavior.
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
  // Keep the app available through Gemini when OpenRouter credentials, free capacity,
  // or a provider/model endpoint fail. The admin diagnostics report provider failures separately.
  return status === 401 || status === 402 || status === 403 || status === 404 || status === 408 || status === 413 || status === 429 || status >= 500 ||
    (status === 400 && /max_tokens|context.?length|model|unsupported|parameter/.test(message)) ||
    /quota|rate.?limit|free.*(limit|unavailable|exhaust)|no free models|temporarily unavailable|service unavailable|timed out|timeout/.test(message);
}
const KEYS_FILE = path.join(process.cwd(), '.keys_config.json');
let inMemoryDynamicKeys: string[] = [];

export function getFileStoredKeys(): string[] {
  // .keys_config.json is a development-only convenience. Production keys must
  // come from durable Supabase storage or explicitly configured server env vars.
  if (process.env.NODE_ENV === 'production') return [];
  try {
    if (fs.existsSync(KEYS_FILE)) {
      const data = fs.readFileSync(KEYS_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        return parsed.filter((k) => isValidGeminiApiKey(k));
      }
    }
  } catch (e) {
    // ignore
  }
  return inMemoryDynamicKeys;
}

export function saveFileStoredKeys(keys: string[]): void {
  inMemoryDynamicKeys = keys.filter((k) => isValidGeminiApiKey(k));
  try {
    fs.writeFileSync(KEYS_FILE, JSON.stringify(inMemoryDynamicKeys, null, 2), 'utf-8');
  } catch (e) {
    console.warn('Error saving keys config to disk:', e);
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

  // Validate the credential and model access without calling generateContent.
  // This prevents adding a key or opening the admin panel from consuming text-generation quota.
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
          message: `تم التحقق من المفتاح والوصول إلى بيانات النموذج ${model}. هذا الفحص لا يولد نصوصاً ولا يستهلك حصة توليد المحتوى.`,
        };
      }

      const status = Number(data?.error?.code || response.status);
      const apiMessage = String(data?.error?.message || '').trim();
      lastFailure = `فشل فحص ${model} (${status})${apiMessage ? `: ${apiMessage.slice(0, 240)}` : '.'}`;

      const errorText = `${data?.error?.status || ''} ${apiMessage}`;
      if (status === 401 || /api key not valid|invalid api key|api_key_invalid|key.*(invalid|revoked|deleted)|credential.*invalid/i.test(errorText)) {
        return { success: false, message: `أكدت Google أن مفتاح Gemini غير صالح أو ملغى (${status}). أنشئ مفتاحاً جديداً.` };
      }

      // Try the next configured model if this model is unavailable or access is restricted.
      if (status === 403 || status === 404 || status === 400) continue;
      if (status === 429) {
        return {
          success: false,
          message: `رفض طلب فحص بيانات النموذج بسبب حد طلبات واجهة البرمجة (${status}). لم يتم توليد أي نص ولم تُستهلك حصة توليد المحتوى.`,
        };
      }
    } catch (err: any) {
      lastFailure = controller.signal.aborted
        ? `انتهت مهلة فحص ${model}.`
        : `تعذر الاتصال بـ Gemini عبر ${model}: ${err?.message || 'خطأ في الشبكة.'}`;
      if (controller.signal.aborted) break;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    success: false,
    message: lastFailure || 'تعذر التحقق من مفتاح Gemini أو الوصول إلى أي نموذج متاح.',
  };
}


let dedicatedOCRActiveKeyIndex = 0;

/**
 * Fast readiness check for the isolated OCR pool. It checks model access without generating content.
 * No general Gemini key, OpenRouter credential, or Vercel Gemini environment variable is consulted.
 */
export async function checkDedicatedOCRGeminiReadiness(totalTimeoutMs = 9000): Promise<{ ready: boolean; keyCount: number; checkedKeys: number; message: string }> {
  let keys: string[];
  try {
    keys = await fetchServerCloudOCRGeminiKeys(Math.min(5000, totalTimeoutMs));
  } catch (error: any) {
    return { ready: false, keyCount: 0, checkedKeys: 0, message: error?.message || 'تعذر قراءة مجموعة مفاتيح الصور والمستندات.' };
  }
  if (!keys.length) {
    return {
      ready: false,
      keyCount: 0,
      checkedKeys: 0,
      message: 'لا توجد مفاتيح مخصصة للصور والمستندات والخازنة (OCR). أضف مفتاحاً من لوحة إدارة المنصة؛ لن تُستخدم المفاتيح العامة كبديل.',
    };
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
      return { ready: true, keyCount: keys.length, checkedKeys, message: `مجموعة OCR جاهزة: تم التحقق من وصول نموذج Gemini عبر أحد مفاتيح الصور والمستندات (${keys.length} مفتاح مسجل).` };
    }
    lastFailure = result.message || 'لم ينجح فحص الوصول إلى نموذج Gemini.';
    if (Date.now() >= deadlineAt) break;
  }
  return {
    ready: false,
    keyCount: keys.length,
    checkedKeys,
    message: `توجد ${keys.length} مفاتيح في مجموعة OCR، لكن تعذر التحقق من وصول أي نموذج في الفحص السريع. افحص المفتاح من لوحة الإدارة قبل رفع الدفعة. آخر نتيجة: ${lastFailure || 'انتهت مهلة الفحص.'}`,
  };
}

/** OCR-only rotation: no OpenRouter, environment Gemini keys, or general legal-AI keys are fallback candidates. */
export async function executeWithDedicatedOCRKeyRotation<T>(
  action: (ai: GoogleGenAI, key: string, model: string) => Promise<T>,
  preferredModels: string[] = GEMINI_MODELS,
  timeoutMs = 240000,
): Promise<T> {
  const deadlineAt = Date.now() + Math.max(15000, timeoutMs);
  let keys: string[];
  try {
    keys = await fetchServerCloudOCRGeminiKeys(Math.min(8000, Math.max(1000, deadlineAt - Date.now() - 2000)));
  } catch (error: any) {
    throw new Error(`تعذر تحميل مفاتيح الصور والمستندات من التخزين المركزي: ${String(error?.message || 'خطأ في Supabase').slice(0, 180)}`);
  }
  if (!keys.length) {
    throw new Error('لا توجد مفاتيح مخصصة للصور والمستندات والخازنة (OCR). أضف مفتاحاً من لوحة إدارة المنصة؛ المفاتيح العامة للصياغة القانونية لا تستخدم هنا.');
  }

  if (dedicatedOCRActiveKeyIndex >= keys.length) dedicatedOCRActiveKeyIndex = 0;
  const startIndex = dedicatedOCRActiveKeyIndex;
  let lastError: any = null;

  ocrKeyLoop: for (let offset = 0; offset < keys.length; offset++) {
    const keyIndex = (startIndex + offset) % keys.length;
    const key = keys[keyIndex];
    for (let modelIndex = 0; modelIndex < preferredModels.length; modelIndex++) {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs < 10000) break ocrKeyLoop;
      const model = preferredModels[modelIndex];
      try {
        const ai = withAdaptiveAnswerLength(createGeminiClient(key, Math.min(45000, remainingMs)));
        const result = await action(ai, key, model);
        if (Date.now() >= deadlineAt) throw Object.assign(new Error('انتهت مهلة استخراج النص عبر مجموعة OCR.'), { status: 504, statusCode: 504 });
        dedicatedOCRActiveKeyIndex = keyIndex;
        return result;
      } catch (error: any) {
        lastError = error;
        const status = Number(error?.status || error?.statusCode || error?.response?.status);
        const message = String(error?.message || '').toLowerCase();
        const kind = getGeminiErrorKind(error);
        console.error('[Dedicated OCR key rotation] attempt failed', {
          model,
          keyIndex: keyIndex + 1,
          status: status || undefined,
          message: String(error?.message || 'Unknown OCR error').slice(0, 220),
        });
        if ((kind === 'temporary' || status === 404 || status === 400 || /model.*not found|unsupported model|no longer available/.test(message)) && modelIndex < preferredModels.length - 1) {
          continue;
        }
        // Quota, revoked keys and other request errors move only within the OCR key pool.
        break;
      }
    }
  }

  const status = Number(lastError?.status || lastError?.statusCode || lastError?.response?.status);
  const message = String(lastError?.message || '').toLowerCase();
  if (Date.now() >= deadlineAt || status === 504 || /deadline_exceeded|timed out|timeout/.test(message)) {
    throw new Error('انتهت مهلة مجموعة OCR قبل اكتمال استخراج النص. قلل حجم الملف أو أعد المحاولة لاحقاً.');
  }
  if (status === 429 || /resource_exhausted|quota exceeded|rate.?limit|too many requests/.test(message)) {
    throw new Error('نفدت الحصة أو حدود الطلبات في مفاتيح مجموعة الصور والمستندات (OCR). حدّث هذه المجموعة أو انتظر تجدد الحصة؛ لن يتم استخدام المفاتيح العامة.');
  }
  if (status === 401 || /api key not valid|invalid api key|api_key_invalid|credential.*invalid/.test(message)) {
    throw new Error('فشلت مفاتيح مجموعة OCR بسبب اعتماد غير صالح. افحص مفاتيح الصور والمستندات من لوحة الإدارة واستبدل المفتاح غير الصالح.');
  }
  throw new Error(`فشلت جميع محاولات مفاتيح مجموعة الصور والمستندات (OCR).${lastError?.message ? ` آخر خطأ: ${String(lastError.message).slice(0, 180)}` : ' افحص المفتاح والنماذج من لوحة الإدارة.'}`);
}

export function getVercelGeminiKeys(_ignoredClientFallbackKey?: string): string[] {
  const keys: string[] = [];
  const addKey = (k: any) => {
    if (!k || typeof k !== 'string') return;
    for (const part of k.split(/[\n,;]+/)) {
      const clean = sanitizeGeminiKey(part.trim());
      if (isValidGeminiApiKey(clean) && !keys.includes(clean)) keys.push(clean);
    }
  };

  // Explicit Gemini variables only. Never scan arbitrary process.env values:
  // Supabase/service-role secrets must never be treated as Gemini credentials.
  for (let i = 1; i <= 50; i++) {
    addKey(process.env[`GEMINI_API_KEY_${i}`]);
    addKey(process.env[`GEMINI_KEY_${i}`]);
  }
  addKey(process.env.GEMINI_API_KEYS);
  addKey(process.env.GEMINI_API_KEY);
  addKey(process.env.GOOGLE_GENAI_API_KEY);
  addKey(process.env.GOOGLE_API_KEY);

  // Keys added from the server-side admin panel are stored locally for
  // development and must participate in the same AI key rotation path.
  for (const storedKey of getFileStoredKeys()) addKey(storedKey);

  return keys;
}

/** * Use both server environment keys and keys saved through the existing admin * panel in Supabase. Keep credentials server-side and preserve key order. */
async function getAvailableGeminiKeys(timeoutMs?: number): Promise<string[]> {
  const keys = getVercelGeminiKeys();
  try {
    for (const key of await fetchServerCloudGeminiKeys(timeoutMs)) {
      if (isValidGeminiApiKey(key) && !keys.includes(key)) keys.push(key);
    }
  } catch (error) {
    // If environment keys exist, a temporary Supabase read failure must not
    // prevent the existing configured provider from working.
    if (keys.length === 0) throw error;
    console.error('[Gemini key rotation] Could not load admin-managed Gemini keys; using configured environment keys.');
  }
  return keys;
}

export function getActiveGeminiKey(): string {
  const keys = getVercelGeminiKeys();
  if (keys.length === 0) return '';
  if (activeKeyIndex >= keys.length) activeKeyIndex = 0;
  return keys[activeKeyIndex];
}

export function rotateToNextGeminiKey(): string {
  const keys = getVercelGeminiKeys();
  if (keys.length <= 1) return keys[0] || '';
  activeKeyIndex = (activeKeyIndex + 1) % keys.length;
  return keys[activeKeyIndex];
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

/** Add guidance to let the model choose answer length based on the legal task, without a fixed word count. */
function withAdaptiveAnswerLength(ai: any): any {
  const instruction = 'اختر طول الإجابة وفقاً لطبيعة الطلب وتعقيده؛ لا تلتزم بعدد كلمات ثابت ولا تختصر لمجرد الاختصار. قدم إجابة قانونية مكتملة ومفصلة بالقدر اللازم، مع الوقائع والتحليل والأسانيد والخطوات العملية عند الحاجة. تجنب التكرار والحشو، ولا تختلق نصوصاً أو أحكاماً أو وقائع غير متحقق منها، وصرح بما يحتاج إلى تحقق. إذا طلب المستخدم الإيجاز صراحةً، التزم بطلبه.';
  const adaptOptions = (options: any) => {
    const { skipAdaptiveAnswerLength, ...apiOptions } = options || {};
    // OCR must preserve its literal-extraction prompt without unrelated legal-drafting instructions.
    if (skipAdaptiveAnswerLength === true) return apiOptions;
    const config = { ...(apiOptions?.config || {}) };
    const current = config.systemInstruction;
    if (typeof current === 'string' && current.trim()) {
      config.systemInstruction = `${current}\n\n${instruction}`;
    } else if (Array.isArray(current)) {
      config.systemInstruction = [...current, { text: instruction }];
    } else if (current && typeof current === 'object') {
      config.systemInstruction = { ...current, parts: [...(Array.isArray(current.parts) ? current.parts : []), { text: instruction }] };
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
  /** OCR uses a bounded, vision-aware provider path; all other callers keep the standard rotation. */
  ocrMode?: boolean;
  deadlineAt?: number;
  previousProviderError?: string;
};

export async function executeWithKeyRotation<T>(
  action: (ai: GoogleGenAI, key: string, model: string) => Promise<T>,
  preferredModels: string[] = GEMINI_MODELS,
  _ignoredClientFallbackKey?: string,
  _forceGeminiFallback = false,
  executionOptions?: KeyRotationExecutionOptions
): Promise<T> {
  if (!executionOptions?.deadlineAt) {
    // Bound standalone requests too. OCR keeps its existing shorter deadline;
    // other requests retain nearly all of Vercel's five-minute execution window.
    executionOptions = { ...executionOptions, deadlineAt: Date.now() + (executionOptions?.ocrMode ? 240000 : 270000) };
  }
  const deadlineAt = Number(executionOptions.deadlineAt);
  const timeoutError = () => Object.assign(
    new Error('انتهت المهلة المتاحة لتوليد النتيجة قبل اكتمالها. احتفظ بالنص الجزئي إن وجد.'),
    { status: 504, statusCode: 504 },
  );
  // OpenRouter is primary unless explicitly forced to use the Gemini fallback.
  if (!_forceGeminiFallback) {
    // Generic AI tasks keep their configured model rotation. OCR uses only the router first,
    // then tries Gemini on any failure instead of spending 4 sequential waits on free models.
    const models = executionOptions?.ocrMode ? ['openrouter/free'] : getOpenRouterModels();
    let lastError: any = null;
    // Keep silent provider retries within a shared budget, preserving time for
    // the server-side Gemini fallback rather than waiting once per model.
    const openRouterDeadlineAt = Math.min(deadlineAt - 90000, Date.now() + 120000);
    if (!process.env.OPENROUTER_API_KEY?.trim()) {
      lastError = Object.assign(new Error('مفتاح OpenRouter غير مضبوط.'), { status: 503, statusCode: 503 });
    }
    for (const model of (process.env.OPENROUTER_API_KEY?.trim() ? models : [])) {
      const remainingMs = deadlineAt - Date.now();
      const providerBudgetMs = openRouterDeadlineAt - Date.now();
      if (remainingMs < 10000 || providerBudgetMs < 10000) {
        if (remainingMs < 10000) lastError = timeoutError();
        break;
      }
      const attemptTimeoutMs = Math.min(60000, remainingMs, providerBudgetMs);
      try {
        const result = await action(
          withAdaptiveAnswerLength(createOpenRouterCompatibleClient(attemptTimeoutMs, deadlineAt)) as unknown as GoogleGenAI,
          'openrouter',
          model,
        );
        if (Date.now() >= deadlineAt) throw timeoutError();
        return result;
      } catch (error: any) {
        lastError = error;
        const status = Number(error?.status || error?.statusCode);
        const message = String(error?.message || '').toLowerCase();
        if (status === 401 || status === 403) break;
        if (status === 402 || status === 429 || /no free models|free.*(limit|unavailable|exhaust)|quota exhausted/.test(message)) {
          // A single model/provider may be out of capacity while another configured
          // fallback is still available. Try the remaining models before Gemini fallback.
          continue;
        }
        const canRetry = status === 400 || status === 401 || status === 404 || status === 408 || status === 413 || status >= 500 || /timeout|rate.?limit|quota|unavailable|model.*not found/.test(message);
        if (!canRetry && !executionOptions?.ocrMode) throw error;
      }
    }
    if (executionOptions?.ocrMode || shouldFallbackFromOpenRouter(lastError)) {
      if (deadlineAt - Date.now() < 10000) throw timeoutError();
      const providerMessage = String(lastError?.message || 'تعذر الاتصال عبر OpenRouter.').slice(0, 220);
      console.warn(executionOptions?.ocrMode
        ? 'OCR OpenRouter attempt failed; switching to bounded server-side Gemini fallback.'
        : 'OpenRouter free route unavailable; retrying this operation through server-side Gemini fallback.');
      return executeWithKeyRotation(action, preferredModels, _ignoredClientFallbackKey, true, {
        ...executionOptions,
        previousProviderError: executionOptions?.ocrMode ? providerMessage : executionOptions?.previousProviderError,
      });
    }
    const status = Number(lastError?.status || lastError?.statusCode);
    if (status === 402 || status === 429) throw new Error('تعذر الاتصال بنماذج OpenRouter المتاحة بسبب حدود الاستخدام أو نفاذ الرصيد أو الحصة. راجع الرصيد أو جرب لاحقاً، وتأكد من إعداد مفتاح Gemini الاحتياطي إن كنت تستخدمه.');
    throw lastError || new Error('تعذر الاتصال بجميع نماذج OpenRouter المتاحة.');
  }
  // Preserve the legacy function signature for compatibility, but never use a client-provided key.
  // Gemini fallback credentials are read server-side from Vercel environment variables
  // and the existing admin-managed Supabase key store.
  const remainingBeforeKeyLoad = deadlineAt - Date.now();
  if (remainingBeforeKeyLoad < 10000) throw timeoutError();
  let availableKeys: string[];
  try {
    availableKeys = await getAvailableGeminiKeys(Math.min(8000, remainingBeforeKeyLoad - 2000));
  } catch (keyLoadError: any) {
    if (executionOptions?.ocrMode && executionOptions.previousProviderError) {
      throw new Error(`فشل مسار OpenRouter أولاً (${executionOptions.previousProviderError}), وتعذر تحميل مفاتيح Gemini الاحتياطية من الخادم: ${String(keyLoadError?.message || 'حدث خطأ في الاتصال بالخادم المركزي').slice(0, 180)}`);
    }
    throw keyLoadError;
  }
  const keys = availableKeys.filter((key) => !permanentlyInvalidKeys.has(key));

  if (keys.length === 0) {
    if (executionOptions?.ocrMode && executionOptions.previousProviderError) {
      throw new Error(`تعذر استخراج النص عبر OpenRouter (${executionOptions.previousProviderError}), ولا يوجد مفتاح Gemini احتياطي صالح في إعدادات الخادم.`);
    }
    throw new Error('لم يتم العثور على مفتاح Gemini صالح في متغيرات البيئة أو لوحة إدارة المفاتيح.');
  }

  if (activeKeyIndex >= keys.length) activeKeyIndex = 0;
  // Sweep all configured keys/models once per server request. The caller may retry
  // a transient request failure, but repeating a full sweep here multiplies latency.
  // This does NOT reduce the number of distinct keys or fallback models tried.
  const MAX_ROTATION_CYCLES = 1;
  let lastError: any = null;

  for (let cycle = 0; cycle < MAX_ROTATION_CYCLES; cycle++) {
    const startIdx = activeKeyIndex;
    geminiKeyLoop: for (let offset = 0; offset < keys.length; offset++) {
      const currentKeyIndex = (startIdx + offset) % keys.length;
      const currentKey = keys[currentKeyIndex];

      for (let m = 0; m < preferredModels.length; m++) {
        const remainingMs = deadlineAt - Date.now();
        // Stop starting attempts when there is no longer time to finish and
        // persist a terminal result. OCR still uses its existing 30-second cap.
        if (remainingMs < 10000) {
          lastError = timeoutError();
          break geminiKeyLoop;
        }
        const model = preferredModels[m];
        const attemptTimeoutMs = executionOptions?.ocrMode
          ? Math.min(45000, remainingMs)
          : remainingMs;
        const ai = withAdaptiveAnswerLength(createGeminiClient(currentKey, attemptTimeoutMs));
        try {
          const result = await action(ai, currentKey, model);
          if (Date.now() >= deadlineAt) throw timeoutError();
          activeKeyIndex = currentKeyIndex;
          return result;
        } catch (err: any) {
          lastError = err;
          console.error('[Gemini key rotation] attempt failed', {
            model,
            keyIndex: currentKeyIndex + 1,
            status: Number(err?.status || err?.statusCode || err?.response?.status) || undefined,
            code: typeof err?.code === 'string' ? err.code : undefined,
            message: String(err?.message || 'Unknown Gemini error').slice(0, 300),
          });
          const kind = getGeminiErrorKind(err);
          if (kind === 'invalid') permanentlyInvalidKeys.add(currentKey);
          // A 503/high-demand response is usually model-specific and transient.
          // Try the next configured Gemini model with the same key before rotating keys.
          if (kind === 'temporary' && m < preferredModels.length - 1) continue;
          if (kind === 'quota' || kind === 'temporary' || kind === 'invalid') {
            activeKeyIndex = keys.length > 1 ? (currentKeyIndex + 1) % keys.length : currentKeyIndex;
            break;
          }
          const msg = String(err?.message || '').toLowerCase();
          const isModelUnavailable = err?.status === 404 || err?.status === 'NOT_FOUND' ||
            /not found|no longer available|model not found|unsupported model/.test(msg);
          if (isModelUnavailable && m < preferredModels.length - 1) continue;
          if (keys.length > 1) {
            activeKeyIndex = (currentKeyIndex + 1) % keys.length;
            break;
          }
        }
      }
    }
    if (cycle < MAX_ROTATION_CYCLES - 1) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  if (Date.now() >= deadlineAt || String(lastError?.message || '').includes('انتهت المهلة')) {
    throw lastError || timeoutError();
  }
  const finalKind = getGeminiErrorKind(lastError);
  if (executionOptions?.ocrMode && executionOptions.previousProviderError) {
    if (finalKind === 'quota') throw new Error('فشل استخراج النص عبر OpenRouter ثم تعذر استخدام Gemini بسبب بلوغ حدود الاستخدام. تحقق من الحصة المتاحة ثم أعد المحاولة.');
    if (finalKind === 'temporary') throw new Error('فشل استخراج النص عبر OpenRouter ثم انتهت مهلة Gemini أو تعذر الاتصال به بعد محاولات التبديل. أعد محاولة رفع المستند، وإذا تكرر الخطأ فرجع سجل /api/ocr على الخادم.');
    throw new Error(`فشل استخراج النص: تعطل OpenRouter (${executionOptions.previousProviderError}) ثم تعذر Gemini (${String(lastError?.message || 'لم ترجع الخدمة نتيجة صالحة').slice(0, 180)}).`);
  }
  if (finalKind === 'quota') throw new Error('تعذر تنفيذ الطلب: استنفذت حصص مفاتيح Gemini المتاحة أو تم بلوغ حد الاستخدام. انتظر تجدد الحصة أو أضف مفتاحاً متاحاً.');
  if (finalKind === 'temporary') throw new Error('خدمة Gemini مشغولة مؤقتاً أو الاتصال متأخر. جرب مرة أخرى بعد قليل.');
  if (keys.every((key) => permanentlyInvalidKeys.has(key))) throw new Error('مفاتيح Gemini المتاحة غير صالحة. حدّث المفاتيح من لوحة الإدارة.');
  throw lastError || new Error('فشلت جميع محاولات تدوير المفاتيح.');
}


export async function executeWithKeyRotationStream( action: (ai: GoogleGenAI, key: string, model: string) => Promise<AsyncIterable<any>>, onChunk: (text: string) => void, preferredModels: string[] = GEMINI_MODELS, _ignoredClientFallbackKey?: string, _forceGeminiFallback = false, executionOptions?: KeyRotationExecutionOptions ): Promise<void> {
  // api/index.ts sets a five-minute Vercel limit. Stop at 4:30 to leave 30 seconds
  // for error handling and persisting the terminal job state.
  if (!executionOptions?.deadlineAt) {
    executionOptions = { ...executionOptions, deadlineAt: Date.now() + 270000 };
  }
  const deadlineAt = Number(executionOptions.deadlineAt);
  const timeoutError = () => Object.assign(
    new Error('انتهت المهلة المتاحة لتوليد المستند قبل اكتمالها. احتفظ بالنص الجزئي إن وجد.'),
    { status: 504, statusCode: 504 },
  );

  if (!_forceGeminiFallback) {
    const models = getOpenRouterModels();
    let lastError: any = null;
    // Limit silent OpenRouter/model retries as a group so the Gemini fallback
    // still has useful time available before Vercel's hard function deadline.
    const openRouterFirstTextDeadlineAt = Math.min(deadlineAt - 90000, Date.now() + 105000);
    if (!process.env.OPENROUTER_API_KEY?.trim()) {
      lastError = Object.assign(new Error('مفتاح OpenRouter غير مضبوط.'), { status: 503, statusCode: 503 });
    }
    for (const model of (process.env.OPENROUTER_API_KEY?.trim() ? models : [])) {
      let emitted = false;
      const remainingMs = deadlineAt - Date.now();
      const firstTextBudgetMs = openRouterFirstTextDeadlineAt - Date.now();
      if (remainingMs < 10000 || firstTextBudgetMs < 10000) {
        if (remainingMs < 10000) lastError = timeoutError();
        break;
      }
      // Bound the initial wait and total silent retries; once output starts,
      // the adapter allows up to 90 seconds between actual text chunks.
      const attemptTimeoutMs = Math.min(35000, remainingMs, firstTextBudgetMs);
      try {
        const stream = await action(withAdaptiveAnswerLength(createOpenRouterCompatibleClient(attemptTimeoutMs, deadlineAt)) as unknown as GoogleGenAI, 'openrouter', model);
        for await (const chunk of stream) {
          if (Date.now() >= deadlineAt) throw timeoutError();
          const chunkText = typeof chunk?.text === 'string' ? chunk.text : '';
          if (chunkText) { emitted = true; onChunk(chunkText); }
        }
        if (!emitted) {
          const emptyStreamError: any = new Error(`OpenRouter model ${model} انتهى بدون إرجاع أو جزء من النص.`);
          emptyStreamError.status = 503;
          emptyStreamError.statusCode = 503;
          throw emptyStreamError;
        }
        return;
      } catch (error: any) {
        lastError = error;
        console.error('[OpenRouter stream] provider attempt failed', {
          model,
          emittedText: emitted,
          status: Number(error?.status || error?.statusCode || error?.response?.status) || undefined,
          code: typeof error?.code === 'string' ? error.code : undefined,
          message: String(error?.message || 'Unknown OpenRouter stream error').slice(0, 300),
        });
        // Never restart on another model after visible output, as that duplicates or corrupts legal text.
        if (emitted) throw error;
        const status = Number(error?.status || error?.statusCode);
        const message = String(error?.message || '').toLowerCase();
        if (status === 401 || status === 403) break;
        if (status === 402 || status === 429 || /no free models|free.*(limit|unavailable|exhaust)|quota exhausted/.test(message)) {
          // Keep trying remaining configured models before using the Gemini fallback.
          continue;
        }
        const canRetry = status === 400 || status === 401 || status === 404 || status === 408 || status === 413 || status >= 500 || /timeout|rate.?limit|quota|unavailable|model.*not found/.test(message);
        if (!canRetry) throw error;
      }
    }
    if (shouldFallbackFromOpenRouter(lastError)) {
      console.warn('OpenRouter free route unavailable before stream output; retrying through server-side Gemini fallback.');
      if (deadlineAt - Date.now() < 10000) throw timeoutError();
      return executeWithKeyRotationStream(action, onChunk, preferredModels, _ignoredClientFallbackKey, true, executionOptions);
    }
    if (deadlineAt - Date.now() < 10000 || Number(lastError?.status || lastError?.statusCode) === 504) throw lastError || timeoutError();
    const status = Number(lastError?.status || lastError?.statusCode);
    if (status === 402 || status === 429) throw new Error('تعذر الاتصال بنماذج OpenRouter المتاحة بسبب حدود الاستخدام أو نفاذ الرصيد أو الحصة. راجع الرصيد أو جرب لاحقاً، وتأكد من إعداد مفتاح Gemini الاحتياطي إن كنت تستخدمه.');
    throw lastError || new Error('تعذر الاتصال بجميع نماذج OpenRouter المتاحة.');
  }
  // Preserve the legacy function signature for compatibility, but never use a client-provided key.
  // Streaming fallback also uses server-side environment and admin-managed keys.
  const remainingBeforeKeyLoad = deadlineAt - Date.now();
  if (remainingBeforeKeyLoad < 10000) throw timeoutError();
  const keys = (await getAvailableGeminiKeys(Math.min(8000, remainingBeforeKeyLoad - 2000))).filter((key) => !permanentlyInvalidKeys.has(key));

  if (keys.length === 0) {
    throw new Error('لم يتم العثور على مفتاح Gemini صالح في متغيرات البيئة أو لوحة إدارة المفاتيح.');
  }

  if (activeKeyIndex >= keys.length) activeKeyIndex = 0;
  // Sweep all configured keys/models once per server request. The caller may retry
  // a transient request failure, but repeating a full sweep here multiplies latency.
  // This does NOT reduce the number of distinct keys or fallback models tried.
  const MAX_ROTATION_CYCLES = 1;
  let lastError: any = null;

  for (let cycle = 0; cycle < MAX_ROTATION_CYCLES; cycle++) {
    const startIdx = activeKeyIndex;

    geminiKeyLoop: for (let offset = 0; offset < keys.length; offset++) {
      const currentKeyIndex = (startIdx + offset) % keys.length;
      const currentKey = keys[currentKeyIndex];

      for (let m = 0; m < preferredModels.length; m++) {
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs < 10000) {
          lastError = timeoutError();
          break geminiKeyLoop;
        }
        const ai = withAdaptiveAnswerLength(createGeminiClient(currentKey, remainingMs));
        let emittedAnyChunk = false;
        try {
          const stream = await action(ai, currentKey, preferredModels[m]);
          for await (const chunk of stream) {
            if (Date.now() >= deadlineAt) throw timeoutError();
            const text = typeof chunk?.text === 'string' ? chunk.text : '';
            if (text) {
              emittedAnyChunk = true;
              onChunk(text);
            }
          }
          activeKeyIndex = currentKeyIndex;
          return;
        } catch (err: any) {
          lastError = err;
          console.error('[Gemini stream key rotation] attempt failed', {
            model: preferredModels[m],
            keyIndex: currentKeyIndex + 1,
            emittedAnyChunk,
            status: Number(err?.status || err?.statusCode || err?.response?.status) || undefined,
            code: typeof err?.code === 'string' ? err.code : undefined,
            message: String(err?.message || 'Unknown Gemini stream error').slice(0, 300),
          });

          // Once Gemini has started streaming, the response may already be visible
          // to the user, so do not silently restart and duplicate the answer.
          if (emittedAnyChunk) {
            throw err;
          }

          const kind = getGeminiErrorKind(err);
          if (kind === 'invalid') permanentlyInvalidKeys.add(currentKey);
          // If Gemini is overloaded (503/504), try another model before moving
          // to another key. Never restart after visible output (handled above).
          if (kind === 'temporary' && m < preferredModels.length - 1) continue;
          if (kind === 'quota' || kind === 'temporary' || kind === 'invalid') {
            activeKeyIndex = keys.length > 1 ? (currentKeyIndex + 1) % keys.length : currentKeyIndex;
            break;
          }
          const msg = String(err?.message || '').toLowerCase();
          const isModelUnavailable = err?.status === 404 || err?.status === 'NOT_FOUND' ||
            /not found|no longer available|model not found|unsupported model/.test(msg);
          if (isModelUnavailable && m < preferredModels.length - 1) continue;
          if (keys.length > 1) {
            activeKeyIndex = (currentKeyIndex + 1) % keys.length;
            break;
          }
        }
      }
    }

    if (cycle < MAX_ROTATION_CYCLES - 1) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  if (Date.now() >= deadlineAt || Number(lastError?.status || lastError?.statusCode) === 504) throw lastError || timeoutError();
  const finalKind = getGeminiErrorKind(lastError);
  if (finalKind === 'quota') throw new Error('تعذر تنفيذ الطلب: استنفذت حصص مفاتيح Gemini المتاحة أو تم بلوغ حد الاستخدام. انتظر تجدد الحصة أو أضف مفتاحاً متاحاً.');
  if (finalKind === 'temporary') throw new Error('خدمة Gemini مشغولة مؤقتاً أو الاتصال متأخر. جرب مرة أخرى بعد قليل.');
  if (keys.every((key) => permanentlyInvalidKeys.has(key))) throw new Error('مفاتيح Gemini المتاحة غير صالحة. حدّث المفاتيح من لوحة الإدارة.');
  throw lastError || new Error('فشلت جميع محاولات تدوير المفاتيح.');
}

export default function handler(req: any, res: any) {
  return res.status(200).json({ ok: true, activeKeys: getKeysStatus().totalCount });
}
