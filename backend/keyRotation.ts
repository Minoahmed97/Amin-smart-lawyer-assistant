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
  // Use documented, broadly available model IDs rather than guessed aliases.
  // Keep a fallback in case one model is unavailable to this project.
  'gemini-2.5-flash',
  'gemini-2.0-flash',
];

let activeKeyIndex = 0;
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

export async function testGeminiKey(apiKey: string, timeoutMs = 12000): Promise<{ success: boolean; message: string }> {
  const cleanKey = sanitizeGeminiKey(apiKey);
  if (!isValidGeminiApiKey(cleanKey)) {
    return {
      success: false,
      message: 'مفتاح Gemini غير صالح شكلياً. الصق المفتاح كاملاً من Google AI Studio كما هو، ويجب أن يبدأ بـ AQ. أو AIza.',
    };
  }

  let lastFailure = '';
  let sawCredentialAcceptance = false;
  let sawModelAccess = false;
  const deadline = Date.now() + Math.max(1000, timeoutMs);

  for (const model of GEMINI_MODELS) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      lastFailure = 'انتهت المهلة المحددة لفحص Gemini قبل تأكيد استجابة صالحة.';
      break;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), remainingMs);
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': cleanKey,
          },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [{ parts: [{ text: 'اختبار اتصال قصير.' }] }],
            generationConfig: { maxOutputTokens: 8 },
          }),
        },
      );

      const raw = await response.text();
      let data: any = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch {}

      if (response.ok) {
        const generatedText = Array.isArray(data?.candidates?.[0]?.content?.parts)
          ? data.candidates[0].content.parts.map((part: any) => typeof part?.text === 'string' ? part.text : '').join('').trim()
          : '';
        if (generatedText) {
          return { success: true, message: `تم التحقق من مفتاح Gemini بنجاح عبر ${model}، واستُلم نص فعلي من النموذج.` };
        }
        lastFailure = `أعاد ${model} استجابة HTTP ناجحة لكن دون نص مولّد يمكن التحقق منه.`;
        continue;
      }

      const status = Number(data?.error?.code || response.status);
      const reason = String(
        data?.error?.details?.find?.((d: any) => d?.reason)?.reason ||
        data?.error?.status ||
        ''
      );
      const apiMessage = String(data?.error?.message || '').trim();
      lastFailure = `فشل ${model} (${status})${apiMessage ? `: ${apiMessage.slice(0, 240)}` : '.'}`;

      if (status === 401) {
        return {
          success: false,
          message: 'Google رفض مفتاح Gemini (401). المفتاح غير صالح أو تم إلغاؤه. استبدله بمفتاح Gemini صالح.',
        };
      }

      if (status === 403) {
        const permissionText = `${reason} ${apiMessage}`.toLowerCase();
        if (/quota|resource_exhausted|rate limit/i.test(permissionText)) {
          sawCredentialAcceptance = true;
          sawModelAccess = true;
          continue;
        }
        return {
          success: false,
          message: `المفتاح وصل إلى Google لكن لا يملك صلاحية استخدام Gemini API (403)${reason ? ` — ${reason}` : ''}. راجع قيود المفتاح وربطه بخدمة Gemini API.`,
        };
      }

      if (status === 429 || /quota|resource_exhausted|rate limit/i.test(`${reason} ${apiMessage}`)) {
        sawCredentialAcceptance = true;
        sawModelAccess = true;
        continue;
      }

      const isModelUnavailable =
        status === 404 ||
        status === 400 ||
        /not found|no longer available|model not found|unsupported model|invalid argument/i.test(apiMessage);

      if (isModelUnavailable) continue;

      if (status === 503 || /unavailable|high demand/i.test(apiMessage)) {
        // Service availability does not prove that this credential is valid.
        continue;
      }
    } catch (err: any) {
      lastFailure = controller.signal.aborted
        ? `انتهت مهلة فحص Gemini بعد ${Math.max(1, Math.round(timeoutMs / 1000))} ثوانٍ.`
        : `تعذر الاتصال بـGemini عبر ${model}: ${err?.message || 'خطأ في الشبكة.'}`;
      if (controller.signal.aborted) break;
    } finally {
      clearTimeout(timeout);
    }
  }

  if (sawCredentialAcceptance && sawModelAccess) {
    return {
      success: false,
      message: 'Google تعرّف على المفتاح لكنه أبلغ عن نفاد الحصة أو تحديد المعدل؛ المفتاح ليس مثبتًا كقادر على توليد رد الآن. افحص الحصة ثم أعد الاختبار.',
    };
  }

  return {
    success: false,
    message: lastFailure || 'فشل فحص مفتاح Gemini عبر جميع النماذج المتاحة.',
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
    console.error('Gemini: failed to load central keys from Supabase; using server/env keys.', err);
  }

  const keys = [...cloudKeys, ...localAndEnvKeys.filter((k) => !cloudKeys.includes(k))];

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
          const result = await action(ai, currentKey, model);
          activeKeyIndex = currentKeyIndex;
          return result;
        } catch (err: any) {
          lastError = err;
          const msg = String(err?.message || '').toLowerCase();
          const status = err?.status || err?.statusCode;
          const isQuotaOrRateLimit =
            status === 429 ||
            status === 'RESOURCE_EXHAUSTED' ||
            msg.includes('quota') ||
            msg.includes('resource_exhausted') ||
            msg.includes('rate limit') ||
            msg.includes('429');
          // 503/high-demand is a model/service availability failure, not a
          // credential failure. Try the next configured model on the SAME key
          // before rotating the key. The old code rotated immediately on 503,
          // so it could exhaust all keys while never trying the fallback models.
          const isModelUnavailable =
            status === 404 ||
            status === 503 ||
            status === 'NOT_FOUND' ||
            status === 'UNAVAILABLE' ||
            msg.includes('not found') ||
            msg.includes('no longer available') ||
            msg.includes('model not found') ||
            msg.includes('unsupported model') ||
            msg.includes('high demand') ||
            msg.includes('unavailable') ||
            /\"code\"\s*:\s*503\b/.test(msg);

          // Quota/rate-limit errors usually apply to the key or project. Do not
          // spend extra latency trying every model on an exhausted key; rotate
          // immediately. Model-not-found/temporary-unavailable errors still try
          // the remaining model fallbacks on this key first.
          if (isQuotaOrRateLimit && keys.length > 1) {
            activeKeyIndex = (currentKeyIndex + 1) % keys.length;
            break;
          }
          if (isModelUnavailable && m < preferredModels.length - 1) {
            continue;
          }
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
    console.error('Gemini stream: failed to load central keys from Supabase; using server/env keys.', err);
  }

  const keys = [...cloudKeys, ...localAndEnvKeys.filter((k) => !cloudKeys.includes(k))];

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
          const stream = await action(ai, currentKey, preferredModels[m]);
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

          const msg = String(err?.message || '').toLowerCase();
          const status = err?.status || err?.statusCode;
          const isQuotaOrRateLimit =
            status === 429 ||
            status === 'RESOURCE_EXHAUSTED' ||
            msg.includes('quota') ||
            msg.includes('resource_exhausted') ||
            msg.includes('rate limit') ||
            msg.includes('429');
          // 503/high-demand is a model/service availability failure, not a
          // credential failure. Try the next configured model on the SAME key
          // before rotating the key. The old code rotated immediately on 503,
          // so it could exhaust all keys while never trying the fallback models.
          const isModelUnavailable =
            status === 404 ||
            status === 503 ||
            status === 'NOT_FOUND' ||
            status === 'UNAVAILABLE' ||
            msg.includes('not found') ||
            msg.includes('no longer available') ||
            msg.includes('model not found') ||
            msg.includes('unsupported model') ||
            msg.includes('high demand') ||
            msg.includes('unavailable') ||
            /\"code\"\s*:\s*503\b/.test(msg);

          // Quota/rate limits should rotate to another key before spending
          // time trying model fallbacks on a key whose project quota is spent.
          if (isQuotaOrRateLimit && keys.length > 1) {
            activeKeyIndex = (currentKeyIndex + 1) % keys.length;
            break;
          }
          if (isModelUnavailable && m < preferredModels.length - 1) {
            continue;
          }

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

  throw lastError || new Error('فشلت جميع محاولات التدوير.');
}

export default function handler(req: any, res: any) {
  return res.status(200).json({ ok: true, activeKeys: getKeysStatus().totalCount });
}
