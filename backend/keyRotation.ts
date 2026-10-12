import { GoogleGenAI } from '@google/genai';
import { sanitizeGeminiKey } from './centralKeys.ts';
import { fetchServerCloudGeminiKeys } from './supabaseSync.ts';
import fs from 'fs';
import path from 'path';

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
const KEY_ATTEMPT_TIMEOUT_MS = 12000;

function getGeminiErrorKind(err: any): 'quota' | 'invalid' | 'temporary' | 'other' {
  const msg = String(err?.message || err?.error?.message || '').toLowerCase();
  const status = Number(err?.status || err?.statusCode || err?.response?.status);
  if (status === 429 || /resource_exhausted|quota exceeded|rate.?limit|too many requests/.test(msg)) return 'quota';
  if (status === 401 || /api key not valid|invalid api key|api_key_invalid|key.*(invalid|revoked|deleted)|credential.*invalid/.test(msg)) return 'invalid';
  if (status === 503 || status === 504 || /timeout|timed out|aborted|high demand|service unavailable|temporarily unavailable|\b503\b/.test(msg)) return 'temporary';
  return 'other';
}

function withGeminiAttemptTimeout<T>(promise: Promise<T>, timeoutMs = KEY_ATTEMPT_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`Gemini attempt timed out after ${timeoutMs}ms`), { code: 'GEMINI_ATTEMPT_TIMEOUT' })), timeoutMs);
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
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
      message: 'مفتاح Gemini غير صالح شكلياً. الصق المفتاح كاملاً من Google AI Studio كما هو، ويجب أن يبدأ بـ AQ. أو AIza.',
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
          message: `تم التحقق من المفتاح والوصول إلى بيانات النموذج ${model}. هذا الفحص لا يولّد نصوصاً ولا يستهلك حصة توليد المحتوى.`,
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
          message: `تم رفض طلب فحص بيانات النموذج بسبب حدّ طلبات API (${status}). لم يتم توليد أي نص ولم تُستهلك حصة توليد المحتوى.`,
        };
      }
    } catch (err: any) {
      lastFailure = controller.signal.aborted
        ? `انتهت مهلة فحص ${model}.`
        : `تعذر الاتصال بـGemini عبر ${model}: ${err?.message || 'خطأ في الشبكة.'}`;
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

  const localKeys = getVercelGeminiKeys();
  let cloudKeys: string[] = [];
  try {
    cloudKeys = await fetchServerCloudGeminiKeys();
  } catch (err: any) {
    throw new Error(`تعذر قراءة المفاتيح المحفوظة لاختبارها: ${err?.message || 'خطأ في التخزين.'}`);
  }

  const merged = [...localKeys];
  const seenMasked = new Set(localKeys.map((k) => k.length > 8 ? `${k.slice(0, 4)}...${k.slice(-4)}` : '****'));
  for (const key of cloudKeys) {
    const masked = key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-4)}` : '****';
    if (!seenMasked.has(masked)) {
      merged.push(key);
      seenMasked.add(masked);
    }
  }
  const key = merged[index];
  if (!key) throw new Error('المفتاح المطلوب غير موجود. حدّث قائمة المفاتيح ثم حاول مرة أخرى.');
  return key;
}

export function getKeysStatus() {
  const keys = getVercelGeminiKeys();
  const maskedList = keys.map((k, idx) => ({
    index: idx,
    id: `key_${idx + 1}`,
    name: idx === 0 ? 'مفتاح رئيسي' : `مفتاح تدوير (${idx + 1})`,
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

export async function executeWithKeyRotation<T>(
  action: (ai: GoogleGenAI, key: string, model: string) => Promise<T>,
  preferredModels: string[] = GEMINI_MODELS,
  _ignoredClientFallbackKey?: string
): Promise<T> {
  // Preserve the legacy function signature for compatibility, but never use a client-provided key.
  const localAndEnvKeys = getVercelGeminiKeys();
  let cloudKeys: string[] = [];
  let cloudLoadError: any = null;

  try {
    cloudKeys = await fetchServerCloudGeminiKeys();
  } catch (err: any) {
    // Supabase key storage must not take down AI when a valid server/env key
    // is already configured. The admin UI can still report the storage error.
    cloudLoadError = err;
    console.error('Gemini: failed to load central keys from Supabase; using server/env keys.');
  }

  const keys = [...new Set([...cloudKeys, ...localAndEnvKeys])].filter((key) => !permanentlyInvalidKeys.has(key));

  if (keys.length === 0) {
    if (cloudLoadError) {
      throw new Error(`تعذر قراءة مفاتيح Gemini المركزية من Supabase: ${cloudLoadError?.message || 'خطأ غير معروف.'}`);
    }
    throw new Error(
      'لم يتم العثور على أي مفاتيح ذكاء اصطناعي (Gemini API Key) صالحة.'
    );
  }

  if (activeKeyIndex >= keys.length) activeKeyIndex = 0;
  // Sweep all configured keys/models once per server request. The caller may retry
  // a transient request failure, but repeating a full sweep here multiplies latency.
  // This does NOT reduce the number of distinct keys or fallback models tried.
  const MAX_ROTATION_CYCLES = 1;
  let lastError: any = null;

  for (let cycle = 0; cycle < MAX_ROTATION_CYCLES; cycle++) {
    const startIdx = activeKeyIndex;
    for (let offset = 0; offset < keys.length; offset++) {
      const currentKeyIndex = (startIdx + offset) % keys.length;
      const currentKey = keys[currentKeyIndex];
      const ai = new GoogleGenAI({
        apiKey: currentKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });

      for (let m = 0; m < preferredModels.length; m++) {
        const model = preferredModels[m];
        try {
          const result = await withGeminiAttemptTimeout(action(ai, currentKey, model));
          activeKeyIndex = currentKeyIndex;
          return result;
        } catch (err: any) {
          lastError = err;
          const kind = getGeminiErrorKind(err);
          if (kind === 'invalid') permanentlyInvalidKeys.add(currentKey);
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
  const finalKind = getGeminiErrorKind(lastError);
  if (finalKind === 'quota') throw new Error('تعذّر تنفيذ الطلب: حصص مفاتيح Gemini المتاحة مستنفدة أو تم بلوغ حد الاستخدام. انتظر تجدد الحصة أو أضف مفتاحًا متاحًا.');
  if (finalKind === 'temporary') throw new Error('خدمة Gemini مشغولة مؤقتًا أو تأخر الاتصال. جرّب مرة أخرى بعد قليل.');
  if (keys.every((key) => permanentlyInvalidKeys.has(key))) throw new Error('مفاتيح Gemini المتاحة غير صالحة. حدّث المفاتيح من لوحة الإدارة.');
  throw lastError || new Error('فشلت جميع محاولات التدوير.');
}


export async function executeWithKeyRotationStream( action: (ai: GoogleGenAI, key: string, model: string) => Promise<AsyncIterable<any>>, onChunk: (text: string) => void, preferredModels: string[] = GEMINI_MODELS, _ignoredClientFallbackKey?: string ): Promise<void> {
  // Preserve the legacy function signature for compatibility, but never use a client-provided key.
  const localAndEnvKeys = getVercelGeminiKeys();
  let cloudKeys: string[] = [];
  let cloudLoadError: any = null;

  try {
    cloudKeys = await fetchServerCloudGeminiKeys();
  } catch (err: any) {
    cloudLoadError = err;
    console.error('Gemini stream: failed to load central keys from Supabase; using server/env keys.');
  }

  const keys = [...new Set([...cloudKeys, ...localAndEnvKeys])].filter((key) => !permanentlyInvalidKeys.has(key));

  if (keys.length === 0) {
    if (cloudLoadError) {
      throw new Error(`تعذر قراءة مفاتيح Gemini المركزية من Supabase: ${cloudLoadError?.message || 'خطأ غير معروف.'}`);
    }
    throw new Error('لم يتم العثور على أي مفاتيح ذكاء اصطناعي (Gemini API Key) صالحة.');
  }

  if (activeKeyIndex >= keys.length) activeKeyIndex = 0;
  // Sweep all configured keys/models once per server request. The caller may retry
  // a transient request failure, but repeating a full sweep here multiplies latency.
  // This does NOT reduce the number of distinct keys or fallback models tried.
  const MAX_ROTATION_CYCLES = 1;
  let lastError: any = null;

  for (let cycle = 0; cycle < MAX_ROTATION_CYCLES; cycle++) {
    const startIdx = activeKeyIndex;

    for (let offset = 0; offset < keys.length; offset++) {
      const currentKeyIndex = (startIdx + offset) % keys.length;
      const currentKey = keys[currentKeyIndex];
      const ai = new GoogleGenAI({
        apiKey: currentKey,
        httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
      });

      for (let m = 0; m < preferredModels.length; m++) {
        let emittedAnyChunk = false;
        try {
          const stream = await withGeminiAttemptTimeout(action(ai, currentKey, preferredModels[m]));
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
          lastError = err;

          // Once Gemini has started streaming, the response may already be visible
          // to the user, so do not silently restart and duplicate the answer.
          if (emittedAnyChunk) {
            throw err;
          }

          const kind = getGeminiErrorKind(err);
          if (kind === 'invalid') permanentlyInvalidKeys.add(currentKey);
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

  const finalKind = getGeminiErrorKind(lastError);
  if (finalKind === 'quota') throw new Error('تعذّر تنفيذ الطلب: حصص مفاتيح Gemini المتاحة مستنفدة أو تم بلوغ حد الاستخدام. انتظر تجدد الحصة أو أضف مفتاحًا متاحًا.');
  if (finalKind === 'temporary') throw new Error('خدمة Gemini مشغولة مؤقتًا أو تأخر الاتصال. جرّب مرة أخرى بعد قليل.');
  if (keys.every((key) => permanentlyInvalidKeys.has(key))) throw new Error('مفاتيح Gemini المتاحة غير صالحة. حدّث المفاتيح من لوحة الإدارة.');
  throw lastError || new Error('فشلت جميع محاولات التدوير.');
}

export default function handler(req: any, res: any) {
  return res.status(200).json({ ok: true, activeKeys: getKeysStatus().totalCount });
}
