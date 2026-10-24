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
  // تفضيل نموذج Flash المستقر الحالي، ثم البدائل المستقرة.
  // Gemini 3.7 Flash قديم ويتم توجيهه تلقائياً إلى 3.8 Flash.
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
];

let activeKeyIndex = 0;
const permanentlyInvalidKeys = new Set<string>();
const permanentlyInvalidOCRKeys = new Set<string>();
// حالة الفشل السريع لكل مثيل. تنتهي صلاحية إدخالات التبريد بكسل عند الوصول،
// لذا لا توجد حاجة لوجود مؤقتات أو وظائف خادم إضافية.
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
    // OCR يحتفظ بسلوكه المعزول الحالي دون أي تغيير. في التدوير العام، قد تكون
    // الحصة محددة بالنموذج؛ لذلك لا نوقف المفتاح كله بسبب 429 من نموذج واحد.
    if (pool === 'ocr') keyCooldowns.set(key, now + KEY_QUOTA_COOLDOWN_MS);
    pairCooldowns.set(pair, now + KEY_QUOTA_COOLDOWN_MS);
  } else if (status === 503 || /high demand|service unavailable|temporarily unavailable/.test(message)) {
    // خطأ 503 الذي يتم ملاحظته مع مفتاح واحد يجب ألا يبرد النموذج عالمياً لكل
    // مفتاح آخر: فهذا قد يجعل المجدول يبلغ بأن كل نموذج يبرد
    // بعد محاولات قليلة فقط، مما يترك المفاتيح التي لم يتم لمسها بدون استخدام. قم بتبريد مفتاح زوج المفتاح/النموذج هذا فقط واترك المفتاح التالي يجرب نفس النموذج.
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

function selectModelsForKey(models: string[], key: string, pool: 'general' | 'ocr' = 'general', now = Date.now()): string[] {
  const pairCooldowns = pool === 'ocr' ? ocrKeyModelCooldownUntil : keyModelCooldownUntil;
  const modelCooldowns = pool === 'ocr' ? ocrModelCooldownUntil : modelCooldownUntil;
  const available = models.filter((model) =>
    !isCooling(modelCooldowns, model, now) &&
    !isCooling(pairCooldowns, rotationPairKey(key, model), now)
  );
  // لا تقم مطلقاً بإعادة محاولة زوج مفتاح/نموذج مبرد لمجرد عدم جاهزية زوج آخر.
  return available.slice(0, MAX_MODELS_PER_KEY_PER_REQUEST);
}
// يمكن للمستدعي تقييد المحاولة عندما يجب أن تترك وقتاً لتدوير المزودين أو
// الحفاظ على حالة مهمة نهائية. تحافظ طلبات غير OCR غير المقيدة على سلوكها القديم.
function createGeminiClient(apiKey: string, timeoutMs?: number): GoogleGenAI {
  const httpOptions: any = { headers: { 'User-Agent': 'aistudio-build' } };
  if (Number.isFinite(timeoutMs) && Number(timeoutMs) >= 1000) {
    // تحديد وقت كل محاولة للمزود حتى يتمكن الرد المتوقف مؤقتاً من الفشل دون استهلاك الموعد النهائي للمهمة بالكامل.
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
  // الحفاظ على توفر التطبيق من خلال Gemini عند بيانات اعتماد OpenRouter، السعة المجانية،
  // أو فشل نقطة نهاية المزود/النموذج. تقارير تشخيص المشرف تشير إلى اخفاقات المزود بشكل منفصل.
  return status === 401 || status === 402 || status === 403 || status === 404 || status === 408 || status === 413 || status === 429 || status >= 500 ||
    (status === 400 && /max_tokens|context.?length|model|unsupported|parameter/.test(message)) ||
    /quota|rate.?limit|free.*(limit|unavailable|exhaust)|no free models|temporarily unavailable|service unavailable|timed out|timeout/.test(message);
}
const KEYS_FILE = path.join(process.cwd(), '.keys_config.json');
let inMemoryDynamicKeys: string[] = [];

export function getFileStoredKeys(): string[] {
  // ملف .keys_config.json هو وسيلة راحة للتطوير فقط. يجب أن تأتي مفاتيح الإنتاج
  // من تخزين Supabase الدائم أو متغيرات بيئة الخادم التي تم تكوينها صراحةً.
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
    // تجاهل
  }
  return inMemoryDynamicKeys;
}

export function saveFileStoredKeys(keys: string[]): void {
  inMemoryDynamicKeys = keys.filter((k) => isValidGeminiApiKey(k));
  try {
    fs.writeFileSync(KEYS_FILE, JSON.stringify(inMemoryDynamicKeys, null, 2), 'utf-8');
  } catch (e) {
    console.warn('خطأ في حفظ تكوين المفاتيح على القرص:', e);
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

  // التحقق من صحة بيانات الاعتماد والوصول إلى النموذج دون استدعاء generateContent.
  // هذا يمنع إضافة مفتاح أو فتح لوحة المشرف من استهلاك حصة توليد النصوص.
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
          message: `المفتاح صالح ويمكنه الوصول إلى النموذج ${model}. هذا الفحص لا يولد نصاً؛ لكن Google لا تعرض عبر هذا الطلب مقدار حصة التوليد المتبقية، لذلك لا يمكن تأكيد أن الحصة لم تنتهِ من هذا الفحص وحده.`,
        };
      }

      const status = Number(data?.error?.code || response.status);
      const apiMessage = String(data?.error?.message || '').trim();
      lastFailure = `فشل فحص ${model} (${status})${apiMessage ? `: ${apiMessage.slice(0, 240)}` : '.'}`;

      const errorText = `${data?.error?.status || ''} ${apiMessage}`;
      if (status === 401 || /api key not valid|invalid api key|api_key_invalid|key.*(invalid|revoked|deleted)|credential.*invalid/i.test(errorText)) {
        return { success: false, message: `أكدت Google أن مفتاح Gemini غير صالح أو ملغى (${status}). أنشئ مفتاحاً جديداً.` };
      }

      // جرب النموذج التالي الذي تم تكوينه إذا كان هذا النموذج غير متوفر أو كان الوصول مقيداً.
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


let dedicatedOCRActiveKey = '';

/** * فحص الجاهزية السريع لمجموعة OCR المعزولة. تتحقق من وصول النموذج دون توليد محتوى. * لا يتم استشارة أي مفتاح Gemini عام، أو بيانات اعتماد OpenRouter، أو متغير بيئة Gemini في Vercel. */
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
      message: 'لا توجد مفاتيح مخصصة للصور والمستندات والخانزة (OCR). أضف مفتاحاً من لوحة إدارة المنصة؛ لن تُستخدم المفاتيح العامة كبديل.',
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

/** تدوير OCR فقط: لا توجد OpenRouter، أو مفاتيح بيئة Gemini، أو مرشحات احتياطية لمفاتيح الذكاء الاصطناعي القانوني العام. */
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
    throw new Error('لا توجد مفاتيح مخصصة للصور والمستندات والخانزة (OCR). أضف مفتاحاً من لوحة إدارة المنصة؛ المفاتيح العامة للصياغة القانونية لا تستخدم هنا.');
  }

  // تفضيل المفتاح الدقيق الذي نجح آخر مرة في OCR في مثيل الخادم الدافئ هذا.
  // تخزين قيمة المفتاح (ليس الفهرس الخاص به)، لأن المشرف قد يعيد ترتيب قائمة مفاتيح Supabase.
  // إذا تم إزالة هذا المفتاح، أو تم تبريده، أو لم يعد متاحاً، استخدم التدوير العادي.
  const rememberedKeyIndex = dedicatedOCRActiveKey ? keys.indexOf(dedicatedOCRActiveKey) : -1;
  const startIndex = rememberedKeyIndex >= 0 &&
    !isCooling(ocrKeyCooldownUntil, dedicatedOCRActiveKey) &&
    !permanentlyInvalidOCRKeys.has(dedicatedOCRActiveKey)
      ? rememberedKeyIndex
      : reserveStartIndex(keys.length, 'ocr');
  let lastError: any = null;
  const usableOCRKeys = keys.filter((candidate) => !permanentlyInvalidOCRKeys.has(candidate));
  if (usableOCRKeys.length && usableOCRKeys.every((candidate) => isCooling(ocrKeyCooldownUntil, candidate))) {
    throw new Error('مفاتيح OCR وصلت مؤقتاً إلى حدود الاستخدام. تم تجاوزها دون إعادة تجربتها؛ انتظر انتهاء التبريد أو أضف مفاتيح متاحة.');
  }
  const hasReadyOCRPair = usableOCRKeys.some((candidate) =>
    !isCooling(ocrKeyCooldownUntil, candidate) && preferredModels.some((model) =>
      !isCooling(ocrModelCooldownUntil, model) && !isCooling(ocrKeyModelCooldownUntil, rotationPairKey(candidate, model))
    )
  );
  if (!hasReadyOCRPair) throw new Error('نماذج OCR المتاحة في فترة تبريد مؤقت. تم تجاوز المحاولات غير الجاهزة دون تكرارها؛ أعد المحاولة بعد قليل.');

  ocrKeyLoop: for (let offset = 0; offset < keys.length; offset++) {
    const keyIndex = (startIndex + offset) % keys.length;
    const key = keys[keyIndex];
    if (isCooling(ocrKeyCooldownUntil, key) || permanentlyInvalidOCRKeys.has(key)) continue;
    const keyModels = selectModelsForKey(preferredModels, key, 'ocr');
    for (let modelIndex = 0; modelIndex < keyModels.length; modelIndex++) {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs < 10000) break ocrKeyLoop;
      const model = keyModels[modelIndex];
      try {
        const ai = withAdaptiveAnswerLength(createGeminiClient(key, Math.min(18000, remainingMs)));
        const result = await action(ai, key, model);
        if (Date.now() >= deadlineAt) throw Object.assign(new Error('انتهت مهلة استخراج النص عبر مجموعة OCR.'), { status: 504, statusCode: 504 });
        dedicatedOCRActiveKey = key;
        // تفضيل المفتاح الناجح داخل مثيل الخادم الحالي؛ لا نعتمد على دالة تخزين غير موجودة.
        return result;
      } catch (error: any) {
        lastError = error;
        const status = Number(error?.status || error?.statusCode || error?.response?.status);
        const message = String(error?.message || '').toLowerCase();
        const kind = markRotationFailure(key, model, error, 'ocr');
        console.error('[Dedicated OCR key rotation] attempt failed', {
          model,
          keyIndex: keyIndex + 1,
          status: status || undefined,
          errorKind: kind,
          message: String(error?.message || 'Unknown OCR error').slice(0, 220),
        });
        const isModelUnavailable = status === 404 || status === 400 || /model.*not found|unsupported model|no longer available/.test(message);
        // جرب نموذجاً ديلاً واحداً على نفس المفتاح لتوفر النموذج و
        // اخفاقات المزود المؤقتة، بما في ذلك أخطاء المهلة 503/504.
        // لا تزال اخفاقات الحصة/المصادقة تقوم بالتدوير إلى المفتاح التالي دون إعادة محاولة هذا المفتاح.
        const shouldTryAlternateModel = isModelUnavailable ||
          status === 503 || status === 504 ||
          kind === 'temporary' ||
          /deadline_exceeded|timed out|timeout|high demand|service unavailable|temporarily unavailable/.test(message);
        if (
          shouldTryAlternateModel &&
          modelIndex < keyModels.length - 1 &&
          deadlineAt - Date.now() >= 10000
        ) {
          continue;
        }
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

  // متغيرات Gemini الصريحة فقط. لا تقم أبداً بمسح قيم process.env الاعتباطية:
  // يجب عدم معاملة أسرار Supabase/service-role أبداً كبيانات اعتماد Gemini.
  for (let i = 1; i <= 50; i++) {
    addKey(process.env[`GEMINI_API_KEY_${i}`]);
    addKey(process.env[`GEMINI_KEY_${i}`]);
  }
  addKey(process.env.GEMINI_API_KEYS);
  addKey(process.env.GEMINI_API_KEY);
  addKey(process.env.GOOGLE_GENAI_API_KEY);
  addKey(process.env.GOOGLE_API_KEY);

  // المفاتيح المضافة من لوحة إدارة جانب الخادم يتم تخزينها محلياً لـ
  // التطوير ويجب أن تشارك في نفس مسار تدوير مفتاح الذكاء الاصطناعي.
  for (const storedKey of getFileStoredKeys()) addKey(storedKey);

  return keys;
}

/** * استخدام كل من مفاتيح بيئة الخادم والمفاتيح المحفوظة من خلال لوحة إدارة * Supabase الحالية. احتفظ ببيانات الاعتماد على جانب الخادم وحافظ على ترتيب المفاتيح. */
async function getAvailableGeminiKeys(timeoutMs?: number): Promise<string[]> {
  const keys = getVercelGeminiKeys();
  try {
    for (const key of await fetchServerCloudGeminiKeys(timeoutMs)) {
      if (isValidGeminiApiKey(key) && !keys.includes(key)) keys.push(key);
    }
  } catch (error) {
    // إذا كانت مفاتيح البيئة موجودة، يجب ألا يمنع فشل القراءة المؤقت لـ Supabase
    // المزود الذي تم تكوينه مسبقاً من العمل.
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

/** إضافة إرشاد للسماح للنموذج اختيار طول الإجابة وفقاً للمهمة القانونية، دون عدد كلمات ثابت. */
function withAdaptiveAnswerLength(ai: any): any {
  const instruction = 'اختر طول الإجابة وفقاً لطبيعة الطلب وتعقيده؛ لا تلتزم بعدد كلمات ثابت ولا تختصر لمجرد الاختصار. قدم إجابة قانونية مكتملة ومفصلة بالقدر اللازم، مع الوقائع والتحليل والأساليب والخطوات العملية عند الحاجة. تجنب التكرار والحشو، ولا تختلق نصوصاً أو أحكاماً أو وقائع غير متحقق منها، وصرح بما يحتاج إلى تحقق. إذا طلب المستخدم الإيجاز صراحةً، التزم بطلبه.';
  const adaptOptions = (options: any) => {
    const { skipAdaptiveAnswerLength, ...apiOptions } = options || {};
    // يجب أن يحافظ OCR على موجه الاستخراج الحرفي الخاص به دون تعليمات صياغة قانونية غير ذات صلة.
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
  /** يستخدم OCR مسار مزود مقيد وواعي للرؤية؛ يحافظ جميع المستدعين الآخرين على التدوير القياسي. */
  ocrMode?: boolean;
  deadlineAt?: number;
  previousProviderError?: string;
  /** اختيار داخلي يمنع تكرار المحاولة عند ترتيب Gemini أولاً ثم OpenRouter. */
  providerAttempt?: 'gemini-primary' | 'openrouter-fallback';
};

export async function executeWithKeyRotation<T>(
  action: (ai: GoogleGenAI, key: string, model: string) => Promise<T>,
  preferredModels: string[] = GEMINI_MODELS,
  _ignoredClientFallbackKey?: string,
  _forceGeminiFallback = false,
  executionOptions?: KeyRotationExecutionOptions
): Promise<T> {
  if (!executionOptions?.deadlineAt) {
    // تقييد الطلبات المستقلة أيضاً. يحافظ OCR على الموعد النهائي الأقصر الحالي؛
    // تحتفظ الطلبات الأخرى بما يقرب من كل نافذة تنفيذ لخمس دقائق لـ Vercel.
    executionOptions = { ...executionOptions, deadlineAt: Date.now() + (executionOptions?.ocrMode ? 240000 : 270000) };
  }
  const deadlineAt = Number(executionOptions.deadlineAt);
  const timeoutError = () => Object.assign(
    new Error('انتهت المهلة المتاحة لتوليد النتيجة قبل اكتمالها. احتفظ بالنص الجزئي إن وجد.'),
    { status: 504, statusCode: 504 },
  );

  // للمهام القانونية العادية: جرّب Gemini أولاً بنفس تدوير المفاتيح والنماذج الحالي،
  // واحتفظ بوقت كافٍ لـ OpenRouter كبديل عند فشل Gemini. OCR يحتفظ بمساره الحالي.
  if (!_forceGeminiFallback && !executionOptions?.ocrMode && !executionOptions?.providerAttempt) {
    const geminiDeadlineAt = Math.min(deadlineAt - 120000, Date.now() + 150000);
    try {
      return await executeWithKeyRotation(action, preferredModels, _ignoredClientFallbackKey, true, {
        ...executionOptions,
        deadlineAt: geminiDeadlineAt,
        providerAttempt: 'gemini-primary',
      });
    } catch (geminiError: any) {
      // OpenRouter مسار أخير فقط بعد التأكد من أن كل مفاتيح Gemini استنفدت الحصة.
      if (geminiError?.allGeminiQuotasExhausted !== true) throw geminiError || timeoutError();
      if (deadlineAt - Date.now() < 10000) throw geminiError || timeoutError();
      try {
        return await executeWithKeyRotation(action, preferredModels, _ignoredClientFallbackKey, false, {
          ...executionOptions,
          providerAttempt: 'openrouter-fallback',
          previousProviderError: String(geminiError?.message || 'تعذر استخدام Gemini.'),
        });
      } catch (openRouterError: any) {
        const combined: any = new Error(`تعذر تنفيذ الطلب عبر Gemini أولاً (${String(geminiError?.message || 'فشل غير محدد').slice(0, 160)})، ثم تعذر OpenRouter الاحتياطي (${String(openRouterError?.message || 'فشل غير محدد').slice(0, 160)}).`);
        combined.status = Number(openRouterError?.status || openRouterError?.statusCode) || 503;
        combined.statusCode = combined.status;
        throw combined;
      }
    }
  }

  // OpenRouter يعمل هنا فقط عندما يكون هو المحاولة الاحتياطية أو في مسار OCR القديم.
  if (!_forceGeminiFallback) {
    // تحافظ مهام الذكاء الاصطناعي العامة على تدوير النماذج المكونة الخاصة بها. يستخدم OCR الموجه فقط أولاً،
    // ثم يجرب Gemini عند أي فشل بدلاً من قضاء 4 انتظارات متتالية على النماذج المجانية.
    const models = executionOptions?.ocrMode ? ['openrouter/free'] : getOpenRouterModels();
    let lastError: any = null;
    // الحفاظ على عمليات إعادة محاولة المزود الصامتة ضمن ميزانية مشتركة، مع الحفاظ على الوقت لـ
    // بديل Gemini في جانب الخادم بدلاً من الانتظار مرة واحدة لكل نموذج.
    const openRouterDeadlineAt = executionOptions?.providerAttempt === 'openrouter-fallback'
      ? Math.min(deadlineAt - 10000, Date.now() + 120000)
      : Math.min(deadlineAt - 90000, Date.now() + 120000);
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
      const attemptTimeoutMs = Math.min(20000, remainingMs, providerBudgetMs);
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
          // قد يكون نموذج/مزود واحد خارج السعة بينما يكون بديل آخر مكون
          // لا يزال متاحاً. جرب النماذج المتبقية قبل بديل Gemini.
          continue;
        }
        const canRetry = status === 400 || status === 401 || status === 404 || status === 408 || status === 413 || status >= 500 || /timeout|rate.?limit|quota|unavailable|model.*not found/.test(message);
        if (!canRetry && !executionOptions?.ocrMode) throw error;
      }
    }
    if ((executionOptions?.ocrMode || shouldFallbackFromOpenRouter(lastError)) && executionOptions?.providerAttempt !== 'openrouter-fallback') {
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
  // الحفاظ على توقيع الوظيفة القديمة للتوافق، ولكن لا تستخدم أبداً مفتاحاً مقدمأ من العميل.
  // تتم قراءة بيانات اعتماد بديل Gemini من جانب الخادم من متغيرات بيئة Vercel
  // ومتجر مفاتيح Supabase المدار من قبل المشرف الحالي.
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
  // مسح جميع المفاتيح/الننماذج المكونة مرة واحدة لكل طلب خادم. قد يعيد المستدعي محاولة
  // فشل طلب عابر، لكن تكرار مسح كامل هنا يضاعف وقت الاستجابة.
  // هذا لا يقلل من عدد المفاتيح المميزة أو نماذج البديل التي تمت تجربتها.
  const MAX_ROTATION_CYCLES = 1;
  let lastError: any = null;
  const keyFailureKinds = new Map<string, string>();
  if (keys.length && keys.every((candidate) => isCooling(keyCooldownUntil, candidate))) {
    throw new Error('مفاتيح Gemini وصلت مؤقتاً إلى حدود الاستخدام. تم تجاوزها دون إعادة تجربتها؛ انتظر انتهاء التبريد أو أضف مفاتيح متاحة.');
  }
  const hasReadyGeneralPair = keys.some((candidate) =>
    !isCooling(keyCooldownUntil, candidate) && !permanentlyInvalidKeys.has(candidate) && preferredModels.some((model) =>
      !isCooling(modelCooldownUntil, model) && !isCooling(keyModelCooldownUntil, rotationPairKey(candidate, model))
    )
  );
  if (!hasReadyGeneralPair) throw new Error('نماذج Gemini المتاحة في فترة تبريد مؤقت. تم تجاوز المحاولات غير الجاهزة دون تكرارها؛ أعد المحاولة بعد قليل.');

  for (let cycle = 0; cycle < MAX_ROTATION_CYCLES; cycle++) {
    const startIdx = reserveStartIndex(keys.length, 'general');
    geminiKeyLoop: for (let offset = 0; offset < keys.length; offset++) {
      const currentKeyIndex = (startIdx + offset) % keys.length;
      const currentKey = keys[currentKeyIndex];
      if (isCooling(keyCooldownUntil, currentKey) || permanentlyInvalidKeys.has(currentKey)) continue;
      const keyModels = selectModelsForKey(preferredModels, currentKey, 'general');

      for (let m = 0; m < keyModels.length; m++) {
        const remainingMs = deadlineAt - Date.now();
        // توقف عن بدء المحاولات عندما لا يكون هناك وقت كافٍ للانتهاء و
        // الاحتفاظ بنتيجة نهائية. لا يزال OCR يستخدم الحد الأقصى الحالي البالغ 30 ثانية.
        if (remainingMs < 10000) {
          lastError = timeoutError();
          break geminiKeyLoop;
        }
        const model = keyModels[m];
        const attemptTimeoutMs = Math.min(executionOptions?.ocrMode ? 18000 : 30000, remainingMs);
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
          const kind = markRotationFailure(currentKey, model, err, 'general');
          // لا نعتبر المفتاح مستنفداً للحصة إذا سبق أن فشل بنوع آخر؛ احتفظ
          // بتصنيف quota فقط عندما تكون كل محاولات هذا المفتاح بسبب الحصة.
          const previousKind = keyFailureKinds.get(currentKey);
          keyFailureKinds.set(currentKey, previousKind === undefined ? kind :
            (previousKind === 'quota' && kind === 'quota' ? 'quota' : 'other'));
          const msg = String(err?.message || '').toLowerCase();
          const status = Number(err?.status || err?.statusCode || err?.response?.status);
          const isModelUnavailable = status === 404 || status === 400 || err?.status === 'NOT_FOUND' ||
            /not found|no longer available|model not found|unsupported model/.test(msg);
          // لا تعيد محاولة زوج المفتاح/النموذج نفسه. جرّب النموذج البديل على المفتاح
          // نفسه أيضاً عند 429، لأن حد الحصة قد يختلف من نموذج لآخر.
          if ((isModelUnavailable || status === 503 || kind === 'quota') && m < keyModels.length - 1) continue;
          activeKeyIndex = keys.length > 1 ? (currentKeyIndex + 1) % keys.length : currentKeyIndex;
          break;
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
  if (finalKind === 'quota') {
    const quotaError: any = new Error('تعذر تنفيذ الطلب: استنفدت حصص مفاتيح Gemini المتاحة أو تم بلوغ حد الاستخدام. انتظر تجدد الحصة أو أضف مفتاحاً متاحة.');
    quotaError.allGeminiQuotasExhausted = keys.length > 0 && keys.every((key) => keyFailureKinds.get(key) === 'quota');
    throw quotaError;
  }
  if (finalKind === 'temporary') throw new Error('خدمة Gemini مشغولة مؤقتاً أو الاتصال متأخر. جرب مرة أخرى بعد قليل.');
  if (keys.every((key) => permanentlyInvalidKeys.has(key))) throw new Error('مفاتيح Gemini المتاحة غير صالحة. حدّث المفاتيح من لوحة الإدارة.');
  throw lastError || new Error('فشلت جميع محاولات تدوير المفاتيح.');
}


export async function executeWithKeyRotationStream( action: (ai: GoogleGenAI, key: string, model: string) => Promise<AsyncIterable<any>>, onChunk: (text: string) => void, preferredModels: string[] = GEMINI_MODELS, _ignoredClientFallbackKey?: string, _forceGeminiFallback = false, executionOptions?: KeyRotationExecutionOptions ): Promise<void> {
  // يحدد api/index.ts حد خمس دقائق لـ Vercel. التوقف عند 4:30 لترك 30 ثانية
  // لمعالجة الأخطاء والاحتفاظ بحالة المهمة النهائية.
  if (!executionOptions?.deadlineAt) {
    executionOptions = { ...executionOptions, deadlineAt: Date.now() + 270000 };
  }
  const deadlineAt = Number(executionOptions.deadlineAt);
  const timeoutError = () => Object.assign(
    new Error('انتهت المهلة المتاحة لتوليد المستند قبل اكتمالها. احتفظ بالنص الجزئي إن وجد.'),
    { status: 504, statusCode: 504 },
  );

  // في التوليد المتدفق، جرّب Gemini أولاً مع الحفاظ على منطق تدوير المفاتيح الحالي.
  // لا تنتقل إلى مزود آخر بعد ظهور أي نص حتى لا تختلط مسودتان في مربع النتيجة.
  if (!_forceGeminiFallback && !executionOptions?.ocrMode && !executionOptions?.providerAttempt) {
    const geminiDeadlineAt = Math.min(deadlineAt - 120000, Date.now() + 150000);
    let geminiEmittedText = false;
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
    } catch (geminiError: any) {
      if (geminiEmittedText) throw geminiError;
      // لا ننتقل إلى OpenRouter بسبب الضغط المؤقت أو انتهاء المهلة.
      if (geminiError?.allGeminiQuotasExhausted !== true) throw geminiError || timeoutError();
      if (deadlineAt - Date.now() < 10000) throw geminiError || timeoutError();
      try {
        await executeWithKeyRotationStream(action, onChunk, preferredModels, _ignoredClientFallbackKey, false, {
          ...executionOptions,
          providerAttempt: 'openrouter-fallback',
          previousProviderError: String(geminiError?.message || 'تعذر استخدام Gemini.'),
        });
        return;
      } catch (openRouterError: any) {
        const combined: any = new Error(`تعذر التوليد عبر Gemini أولاً (${String(geminiError?.message || 'فشل غير محدد').slice(0, 160)})، ثم تعذر OpenRouter الاحتياطي (${String(openRouterError?.message || 'فشل غير محدد').slice(0, 160)}).`);
        combined.status = Number(openRouterError?.status || openRouterError?.statusCode) || 503;
        combined.statusCode = combined.status;
        throw combined;
      }
    }
  }

  if (!_forceGeminiFallback) {
    const models = getOpenRouterModels();
    let lastError: any = null;
    // تحديد عمليات إعادة محاولة OpenRouter/النموذج الصامتة كمجموعة بحيث يكون بديل Gemini
    // لا يزال لديه وقت مفيد متاح قبل موعد انتهاء مهلة وظيفة Vercel الصعبة.
    const openRouterFirstTextDeadlineAt = executionOptions?.providerAttempt === 'openrouter-fallback'
      ? Math.min(deadlineAt - 15000, Date.now() + 105000)
      : Math.min(deadlineAt - 90000, Date.now() + 105000);
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
      // تقييد الانتظار الأولي وإعادة المحاولات الصامتة الإجمالية؛ بمجرد بدء الإخراج،
      // يتيح المحول ما يصل إلى 90 ثانية بين قطع النص الفعلية.
      const attemptTimeoutMs = Math.min(12000, remainingMs, firstTextBudgetMs);
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
        // لا تقم مطلقاً بإعادة البدء على نموذج آخر بعد الإخراج المرئي، لأن ذلك يكرر أو يفسد النص القانوني.
        if (emitted) throw error;
        const status = Number(error?.status || error?.statusCode);
        const message = String(error?.message || '').toLowerCase();
        if (status === 401 || status === 403) break;
        if (status === 402 || status === 429 || /no free models|free.*(limit|unavailable|exhaust)|quota exhausted/.test(message)) {
          // الاستمرار في تجربة النماذج المكونة المتبقية قبل استخدام بديل Gemini.
          continue;
        }
        const canRetry = status === 400 || status === 401 || status === 404 || status === 408 || status === 413 || status >= 500 || /timeout|rate.?limit|quota|unavailable|model.*not found/.test(message);
        if (!canRetry) throw error;
      }
    }
    if (shouldFallbackFromOpenRouter(lastError) && executionOptions?.providerAttempt !== 'openrouter-fallback') {
      console.warn('OpenRouter free route unavailable before stream output; retrying through server-side Gemini fallback.');
      if (deadlineAt - Date.now() < 10000) throw timeoutError();
      return executeWithKeyRotationStream(action, onChunk, preferredModels, _ignoredClientFallbackKey, true, executionOptions);
    }
    if (deadlineAt - Date.now() < 10000 || Number(lastError?.status || lastError?.statusCode) === 504) throw lastError || timeoutError();
    const status = Number(lastError?.status || lastError?.statusCode);
    if (status === 402 || status === 429) throw new Error('تعذر الاتصال بنماذج OpenRouter المتاحة بسبب حدود الاستخدام أو نفاذ الرصيد أو الحصة. راجع الرصيد أو جرب لاحقاً، وتأكد من إعداد مفتاح Gemini الاحتياطي إن كنت تستخدمه.');
    throw lastError || new Error('تعذر الاتصال بجميع نماذج OpenRouter المتاحة.');
  }
  // الحفاظ على توقيع الوظيفة القديمة للتوافق، ولكن لا تستخدم أبداً مفتاحاً مقدمأ من العميل.
  // يستخدم بديل البث أيضاً بيئة جانب الخادم ومفاتيح إدارة المشرف.
  const remainingBeforeKeyLoad = deadlineAt - Date.now();
  if (remainingBeforeKeyLoad < 10000) throw timeoutError();
  const keys = (await getAvailableGeminiKeys(Math.min(8000, remainingBeforeKeyLoad - 2000))).filter((key) => !permanentlyInvalidKeys.has(key));

  if (keys.length === 0) {
    throw new Error('لم يتم العثور على مفتاح Gemini صالح في متغيرات البيئة أو لوحة إدارة المفاتيح.');
  }

  if (activeKeyIndex >= keys.length) activeKeyIndex = 0;
  // مسح جميع المفاتيح/الننماذج المكونة مرة واحدة لكل طلب خادم. قد يعيد المستدعي محاولة
  // فشل طلب عابر، لكن تكرار مسح كامل هنا يضاعف وقت الاستجابة.
  // هذا لا يقلل من عدد المفاتيح المميزة أو نماذج البديل التي تمت تجربتها.
  const MAX_ROTATION_CYCLES = 1;
  let lastError: any = null;
  const keyFailureKinds = new Map<string, string>();
  if (keys.length && keys.every((candidate) => isCooling(keyCooldownUntil, candidate))) {
    throw new Error('مفاتيح Gemini وصلت مؤقتاً إلى حدود الاستخدام. تم تجاوزها دون إعادة تجربتها؛ انتظر انتهاء التبريد أو أضف مفاتيح متاحة.');
  }
  const hasReadyGeneralPair = keys.some((candidate) =>
    !isCooling(keyCooldownUntil, candidate) && !permanentlyInvalidKeys.has(candidate) && preferredModels.some((model) =>
      !isCooling(modelCooldownUntil, model) && !isCooling(keyModelCooldownUntil, rotationPairKey(candidate, model))
    )
  );
  if (!hasReadyGeneralPair) throw new Error('نماذج Gemini المتاحة في فترة تبريد مؤقت. تم تجاوز المحاولات غير الجاهزة دون تكرارها؛ أعد المحاولة بعد قليل.');

  for (let cycle = 0; cycle < MAX_ROTATION_CYCLES; cycle++) {
    const startIdx = reserveStartIndex(keys.length, 'general');

    geminiKeyLoop: for (let offset = 0; offset < keys.length; offset++) {
      const currentKeyIndex = (startIdx + offset) % keys.length;
      const currentKey = keys[currentKeyIndex];
      if (isCooling(keyCooldownUntil, currentKey) || permanentlyInvalidKeys.has(currentKey)) continue;
      const keyModels = selectModelsForKey(preferredModels, currentKey, 'general');

      for (let m = 0; m < keyModels.length; m++) {
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs < 10000) {
          lastError = timeoutError();
          break geminiKeyLoop;
        }
        const ai = withAdaptiveAnswerLength(createGeminiClient(currentKey, Math.min(18000, remainingMs))); 
        let emittedAnyChunk = false;
        try {
          const stream = await action(ai, currentKey, keyModels[m]);
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
            model: keyModels[m],
            keyIndex: currentKeyIndex + 1,
            emittedAnyChunk,
            status: Number(err?.status || err?.statusCode || err?.response?.status) || undefined,
            code: typeof err?.code === 'string' ? err.code : undefined,
            message: String(err?.message || 'Unknown Gemini stream error').slice(0, 300),
          });

          // بمجرد أن يبدأ Gemini في البث، قد تكون الاستجابة مرئية بالفعل
          // للمستخدم، لذا لا تقم بإعادة البدء بصمت وتكرار الإجابة.
          if (emittedAnyChunk) {
            throw err;
          }

          const kind = markRotationFailure(currentKey, keyModels[m], err, 'general');
          // لا نعتبر المفتاح مستنفداً للحصة إذا سبق أن فشل بنوع آخر؛ احتفظ
          // بتصنيف quota فقط عندما تكون كل محاولات هذا المفتاح بسبب الحصة.
          const previousKind = keyFailureKinds.get(currentKey);
          keyFailureKinds.set(currentKey, previousKind === undefined ? kind :
            (previousKind === 'quota' && kind === 'quota' ? 'quota' : 'other'));
          const msg = String(err?.message || '').toLowerCase();
          const status = Number(err?.status || err?.statusCode || err?.response?.status);
          const isModelUnavailable = status === 404 || status === 400 || err?.status === 'NOT_FOUND' ||
            /not found|no longer available|model not found|unsupported model/.test(msg);
          // لا تقم بإعادة البدء بعد الإخراج المرئي. قبل الإخراج جرّب النموذج البديل
          // كذلك عند 429، لأن حدود الاستخدام قد تختلف بين النماذج.
          if ((isModelUnavailable || status === 503 || kind === 'quota') && m < keyModels.length - 1) continue;
          activeKeyIndex = keys.length > 1 ? (currentKeyIndex + 1) % keys.length : currentKeyIndex;
          break;
        }
      }
    }

    if (cycle < MAX_ROTATION_CYCLES - 1) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  if (Date.now() >= deadlineAt || Number(lastError?.status || lastError?.statusCode) === 504) throw lastError || timeoutError();
  const finalKind = getGeminiErrorKind(lastError);
  if (finalKind === 'quota') {
    const quotaError: any = new Error('تعذر تنفيذ الطلب: استنفدت حصص مفاتيح Gemini المتاحة أو تم بلوغ حد الاستخدام. انتظر تجدد الحصة أو أضف مفتاحاً متاحة.');
    quotaError.allGeminiQuotasExhausted = keys.length > 0 && keys.every((key) => keyFailureKinds.get(key) === 'quota');
    throw quotaError;
  }
  if (finalKind === 'temporary') throw new Error('خدمة Gemini مشغولة مؤقتاً أو الاتصال متأخر. جرب مرة أخرى بعد قليل.');
  if (keys.every((key) => permanentlyInvalidKeys.has(key))) throw new Error('مفاتيح Gemini المتاحة غير صالحة. حدّث المفاتيح من لوحة الإدارة.');
  throw lastError || new Error('فشلت جميع محاولات تدوير المفاتيح.');
}

export default function handler(req: any, res: any) {
  return res.status(200).json({ ok: true, activeKeys: getKeysStatus().totalCount });
}
