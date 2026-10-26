import { sanitizeGeminiKey, isValidKeyFormat } from './centralKeys.ts';

let cachedServerCloudKeys: string[] = [];
let cachedServerCloudKeysAt = 0;
const SERVER_CLOUD_KEYS_CACHE_MS = 30_000;

function getSupabaseServerConfig() {
  const supabaseUrl = (process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
  // Gemini credentials are platform secrets: only the server-side service role
  // can read or mutate this table. Never attempt writes with a public anon key.
  const supabaseKey = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim();
  return { supabaseUrl, supabaseKey };
}

function requireSupabaseServerConfig() {
  const config = getSupabaseServerConfig();
  if (!config.supabaseUrl || !config.supabaseKey) {
    throw new Error('إعدادات Supabase السرية غير مكتملة على الخادم. يلزم ضبط SUPABASE_URL وSUPABASE_SECRET_KEY (أو مفتاح Service Role القديم).');
  }
  return config;
}

export async function fetchServerCloudGeminiKeys(timeoutMs?: number): Promise<string[]> {
  const { supabaseUrl, supabaseKey } = getSupabaseServerConfig();
  if (!supabaseUrl || !supabaseKey) {
    cachedServerCloudKeys = [];
    cachedServerCloudKeysAt = 0;
    return [];
  }

  // Avoid an extra Supabase round-trip before every Gemini request. The cache
  // is short-lived so Vercel instances still pick up admin key changes quickly,
  // while add/delete operations below invalidate their local cache immediately.
  if (cachedServerCloudKeysAt && Date.now() - cachedServerCloudKeysAt < SERVER_CLOUD_KEYS_CACHE_MS) {
    return [...cachedServerCloudKeys];
  }

  try {
    const timeout = Number(timeoutMs);
    const res = await fetch(`${supabaseUrl}/rest/v1/app_gemini_keys?select=api_key,is_active`, {
      method: 'GET',
      headers: {
        apikey: supabaseKey,
        ...(supabaseKey.startsWith('sb_') ? {} : { Authorization: `Bearer ${supabaseKey}` }),
        'Content-Type': 'application/json',
      },
      ...(Number.isFinite(timeout) && timeout >= 1000 ? { signal: AbortSignal.timeout(timeout) } : {}),
    });
    if (!res.ok) throw new Error(`Supabase رفض قراءة مفاتيح Gemini (HTTP ${res.status}).`);
    const records = (await res.json()) as any[];
    if (!Array.isArray(records)) throw new Error('استجابة مفاتيح Gemini من Supabase غير صالحة.');
    cachedServerCloudKeys = records
      .filter((r) => r.is_active !== false && r.api_key)
      .map((r) => sanitizeGeminiKey(r.api_key))
      .filter(isValidKeyFormat);
    cachedServerCloudKeysAt = Date.now();
    return [...cachedServerCloudKeys];
  } catch (err) {
    console.error('Server: Error fetching keys from Supabase:', err);
    throw new Error(err instanceof Error ? err.message : 'تعذر قراءة مفاتيح Gemini من Supabase.');
  }
}

export async function saveServerCloudGeminiKey(geminiKey: string): Promise<boolean> {
  const { supabaseUrl, supabaseKey } = requireSupabaseServerConfig();
  const cleanKey = sanitizeGeminiKey(geminiKey);
  if (!isValidKeyFormat(cleanKey)) throw new Error('صيغة مفتاح Gemini غير صالحة.');

  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/app_gemini_keys?on_conflict=api_key`, {
      method: 'POST',
      headers: {
        apikey: supabaseKey,
        ...(supabaseKey.startsWith('sb_') ? {} : { Authorization: `Bearer ${supabaseKey}` }),
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({ api_key: cleanKey, is_active: true }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`فشل حفظ مفتاح Gemini في Supabase (HTTP ${res.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`);
    }
    cachedServerCloudKeys = [];
    cachedServerCloudKeysAt = 0;
    return true;
  } catch (err) {
    console.error('Server: Error saving Gemini key to Supabase:', err);
    throw new Error(err instanceof Error ? err.message : 'تعذر حفظ مفتاح Gemini في التخزين الدائم.');
  }
}

export async function deleteServerCloudGeminiKey(geminiKey: string): Promise<boolean> {
  const { supabaseUrl, supabaseKey } = requireSupabaseServerConfig();
  const cleanKey = sanitizeGeminiKey(geminiKey);
  if (!isValidKeyFormat(cleanKey)) throw new Error('صيغة مفتاح Gemini المراد حذفه غير صالحة.');
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/app_gemini_keys?api_key=eq.${encodeURIComponent(cleanKey)}`, {
      method: 'DELETE',
      headers: {
        apikey: supabaseKey,
        ...(supabaseKey.startsWith('sb_') ? {} : { Authorization: `Bearer ${supabaseKey}` }),
        Prefer: 'return=representation',
      },
    });
    if (!res.ok) throw new Error(`فشل حذف مفتاح Gemini من Supabase (HTTP ${res.status}).`);
    const deleted = await res.json().catch(() => []);
    if (!Array.isArray(deleted) || deleted.length === 0) {
      throw new Error('لم يتم العثور على المفتاح في التخزين الدائم؛ لم يُعتبر الحذف ناجحًا.');
    }
    cachedServerCloudKeys = [];
    cachedServerCloudKeysAt = 0;
    return true;
  } catch (err) {
    console.error('Server: Error deleting Gemini key from Supabase:', err);
    throw new Error(err instanceof Error ? err.message : 'تعذر حذف مفتاح Gemini من التخزين الدائم.');
  }
}


// OCR/document credentials are stored independently from the general legal-AI key pool.
let cachedServerCloudOCRKeys: string[] = [];
let cachedServerCloudOCRKeysAt = 0;

export async function fetchServerCloudOCRGeminiKeys(timeoutMs?: number): Promise<string[]> {
  const { supabaseUrl, supabaseKey } = getSupabaseServerConfig();
  if (!supabaseUrl || !supabaseKey) {
    cachedServerCloudOCRKeys = [];
    cachedServerCloudOCRKeysAt = 0;
    return [];
  }
  if (cachedServerCloudOCRKeysAt && Date.now() - cachedServerCloudOCRKeysAt < SERVER_CLOUD_KEYS_CACHE_MS) {
    return [...cachedServerCloudOCRKeys];
  }
  try {
    const timeout = Number(timeoutMs);
    const res = await fetch(`${supabaseUrl}/rest/v1/app_gemini_ocr_keys?select=api_key,is_active&order=created_at.asc,id.asc`, {
      method: 'GET',
      headers: {
        apikey: supabaseKey,
        ...(supabaseKey.startsWith('sb_') ? {} : { Authorization: `Bearer ${supabaseKey}` }),
        'Content-Type': 'application/json',
      },
      ...(Number.isFinite(timeout) && timeout >= 1000 ? { signal: AbortSignal.timeout(timeout) } : {}),
    });
    if (!res.ok) throw new Error(`تعذر قراءة مفاتيح الصور والمستندات من Supabase (HTTP ${res.status}).`);
    const records = (await res.json()) as any[];
    if (!Array.isArray(records)) throw new Error('استجابة مفاتيح OCR من Supabase غير صالحة.');
    cachedServerCloudOCRKeys = records
      .filter((r) => r.is_active !== false && r.api_key)
      .map((r) => sanitizeGeminiKey(r.api_key))
      .filter(isValidKeyFormat);
    cachedServerCloudOCRKeysAt = Date.now();
    return [...cachedServerCloudOCRKeys];
  } catch (err) {
    console.error('Server: Error fetching dedicated OCR Gemini keys:', err);
    throw new Error(err instanceof Error ? err.message : 'تعذر قراءة مفاتيح الصور والمستندات من Supabase.');
  }
}

export async function saveServerCloudOCRGeminiKey(geminiKey: string): Promise<boolean> {
  const { supabaseUrl, supabaseKey } = requireSupabaseServerConfig();
  const cleanKey = sanitizeGeminiKey(geminiKey);
  if (!isValidKeyFormat(cleanKey)) throw new Error('صيغة مفتاح Gemini لمجموعة الصور والمستندات غير صالحة.');
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/app_gemini_ocr_keys?on_conflict=api_key`, {
      method: 'POST',
      headers: {
        apikey: supabaseKey,
        ...(supabaseKey.startsWith('sb_') ? {} : { Authorization: `Bearer ${supabaseKey}` }),
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({ api_key: cleanKey, is_active: true }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`فشل حفظ مفتاح الصور والمستندات في Supabase (HTTP ${res.status})${detail ? `: ${detail.slice(0, 240)}` : ''}`);
    }
    cachedServerCloudOCRKeys = [];
    cachedServerCloudOCRKeysAt = 0;
    return true;
  } catch (err) {
    console.error('Server: Error saving dedicated OCR Gemini key:', err);
    throw new Error(err instanceof Error ? err.message : 'تعذر حفظ مفتاح الصور والمستندات.');
  }
}

export async function deleteServerCloudOCRGeminiKey(geminiKey: string): Promise<boolean> {
  const { supabaseUrl, supabaseKey } = requireSupabaseServerConfig();
  const cleanKey = sanitizeGeminiKey(geminiKey);
  if (!isValidKeyFormat(cleanKey)) throw new Error('صيغة مفتاح Gemini المراد حذفه من مجموعة الصور والمستندات غير صالحة.');
  try {
    const res = await fetch(`${supabaseUrl}/rest/v1/app_gemini_ocr_keys?api_key=eq.${encodeURIComponent(cleanKey)}`, {
      method: 'DELETE',
      headers: {
        apikey: supabaseKey,
        ...(supabaseKey.startsWith('sb_') ? {} : { Authorization: `Bearer ${supabaseKey}` }),
        Prefer: 'return=representation',
      },
    });
    if (!res.ok) throw new Error(`فشل حذف مفتاح الصور والمستندات من Supabase (HTTP ${res.status}).`);
    const deleted = await res.json().catch(() => []);
    if (!Array.isArray(deleted) || deleted.length === 0) throw new Error('لم يُعثر على مفتاح OCR المطلوب في التخزين الدائم.');
    cachedServerCloudOCRKeys = [];
    cachedServerCloudOCRKeysAt = 0;
    return true;
  } catch (err) {
    console.error('Server: Error deleting dedicated OCR Gemini key:', err);
    throw new Error(err instanceof Error ? err.message : 'تعذر حذف مفتاح الصور والمستندات.');
  }
}

export default function handler(req: any, res: any) {
  return res.status(200).json({ ok: true });
}


// Groq vision is a separate, server-only OCR fallback configuration stored in
// platform_settings (this table is already part of the central schema and is
// not readable by anon/authenticated clients).
export type OCRGroqFallbackConfig = {
  enabled: boolean;
  apiKey: string;
  model: string;
};

const OCR_GROQ_FALLBACK_SETTING_KEY = 'ocr_groq_fallback';
const OCR_GROQ_DEFAULT_MODEL = 'qwen/qwen3.8-27b';
let cachedOCRGroqFallback: OCRGroqFallbackConfig | null = null;
let cachedOCRGroqFallbackAt = 0;
const OCR_GROQ_FALLBACK_CACHE_MS = 15_000;

function cleanOCRGroqFallbackConfig(value: any): OCRGroqFallbackConfig {
  const object = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const apiKey = typeof object.apiKey === 'string' ? object.apiKey.trim() : '';
  const configuredModel = typeof object.model === 'string' && object.model.trim()
    ? object.model.trim().slice(0, 100)
    : OCR_GROQ_DEFAULT_MODEL;
  // Replace vision models that Groq has retired so existing saved settings
  // continue to work without requiring the user to re-enter the API key.
  const model = ['meta-llama/llama-3.2-11b-vision-preview', 'meta-llama/llama-3.2-90b-vision-preview', 'qwen/qwen3.6-27b'].includes(configuredModel)
    ? OCR_GROQ_DEFAULT_MODEL
    : configuredModel;
  return {
    enabled: object.enabled === true,
    apiKey: apiKey.startsWith('gsk_') && apiKey.length >= 20 ? apiKey : '',
    model,
  };
}

export async function fetchServerCloudOCRGroqFallbackConfig(forceRefresh = false): Promise<OCRGroqFallbackConfig> {
  const { supabaseUrl, supabaseKey } = getSupabaseServerConfig();
  if (!supabaseUrl || !supabaseKey) return { enabled: false, apiKey: '', model: OCR_GROQ_DEFAULT_MODEL };
  if (!forceRefresh && cachedOCRGroqFallback && Date.now() - cachedOCRGroqFallbackAt < OCR_GROQ_FALLBACK_CACHE_MS) {
    return { ...cachedOCRGroqFallback };
  }
  const response = await fetch(
    `${supabaseUrl}/rest/v1/platform_settings?select=value&key=eq.${encodeURIComponent(OCR_GROQ_FALLBACK_SETTING_KEY)}&limit=1`,
    {
      headers: {
        apikey: supabaseKey,
        ...(supabaseKey.startsWith('sb_') ? {} : { Authorization: `Bearer ${supabaseKey}` }),
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(7000),
    },
  );
  if (!response.ok) throw new Error(`تعذر قراءة إعداد احتياطي OCR من Supabase (HTTP ${response.status}).`);
  const rows = await response.json().catch(() => []);
  const config = cleanOCRGroqFallbackConfig(Array.isArray(rows) ? rows[0]?.value : null);
  cachedOCRGroqFallback = config;
  cachedOCRGroqFallbackAt = Date.now();
  return { ...config };
}

export async function saveServerCloudOCRGroqFallbackConfig(config: OCRGroqFallbackConfig): Promise<boolean> {
  const { supabaseUrl, supabaseKey } = requireSupabaseServerConfig();
  const clean = cleanOCRGroqFallbackConfig(config);
  if (config.apiKey && !clean.apiKey) throw new Error('صيغة مفتاح Groq غير صحيحة. يجب أن يكون المفتاح كاملاً ويبدأ بـ gsk_.');
  const response = await fetch(`${supabaseUrl}/rest/v1/platform_settings?on_conflict=key`, {
    method: 'POST',
    headers: {
      apikey: supabaseKey,
      ...(supabaseKey.startsWith('sb_') ? {} : { Authorization: `Bearer ${supabaseKey}` }),
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({
      key: OCR_GROQ_FALLBACK_SETTING_KEY,
      value: clean,
      updated_at: new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(7000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`تعذر حفظ إعداد Groq الاحتياطي في Supabase (HTTP ${response.status})${detail ? `: ${detail.slice(0, 180)}` : ''}`);
  }
  cachedOCRGroqFallback = clean;
  cachedOCRGroqFallbackAt = Date.now();
  return true;
}
