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

export async function fetchServerCloudGeminiKeys(): Promise<string[]> {
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
    const res = await fetch(`${supabaseUrl}/rest/v1/app_gemini_keys?select=api_key,is_active`, {
      method: 'GET',
      headers: {
        apikey: supabaseKey,
        ...(supabaseKey.startsWith('sb_') ? {} : { Authorization: `Bearer ${supabaseKey}` }),
        'Content-Type': 'application/json',
      },
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

export default function handler(req: any, res: any) {
  return res.status(200).json({ ok: true });
}
