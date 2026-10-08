import { sanitizeGeminiKey, isValidKeyFormat } from '../config/centralKeys.ts';
import { getAdminSessionToken } from './authService.ts';

const SUPABASE_URL_KEY = 'judicial_supabase_url';
const SUPABASE_ANON_KEY = 'judicial_supabase_key';
const CACHED_CLOUD_KEYS = 'judicial_cloud_cached_keys';

export interface SupabaseConfig {
  url: string;
  anonKey: string;
  isConnected: boolean;
}

export function getStoredSupabaseConfig(): SupabaseConfig {
  let url = '';
  let anonKey = '';
  try {
    url = localStorage.getItem(SUPABASE_URL_KEY) || '';
    anonKey = localStorage.getItem(SUPABASE_ANON_KEY) || '';
  } catch {}

  // Check Vite env
  if (!url && typeof (import.meta as any) !== 'undefined' && (import.meta as any).env) {
    url = (import.meta as any).env.VITE_SUPABASE_URL || (import.meta as any).env.SUPABASE_URL || '';
    anonKey = (import.meta as any).env.VITE_SUPABASE_ANON_KEY || (import.meta as any).env.SUPABASE_ANON_KEY || '';
  }

  return {
    url: url.trim().replace(/\/$/, ''),
    anonKey: anonKey.trim(),
    isConnected: !!(url.trim() && anonKey.trim()),
  };
}

export function saveSupabaseConfig(url: string, anonKey: string): void {
  try {
    const cleanUrl = url.trim().replace(/\/$/, '');
    const cleanKey = anonKey.trim();
    localStorage.setItem(SUPABASE_URL_KEY, cleanUrl);
    localStorage.setItem(SUPABASE_ANON_KEY, cleanKey);
  } catch (e) {
    console.warn('Failed to save Supabase config to local storage:', e);
  }
}

export function clearSupabaseConfig(): void {
  try {
    localStorage.removeItem(SUPABASE_URL_KEY);
    localStorage.removeItem(SUPABASE_ANON_KEY);
    localStorage.removeItem(CACHED_CLOUD_KEYS);
  } catch (e) {
    console.warn('Failed to clear Supabase config:', e);
  }
}

export async function testSupabaseConnection(
  urlInput: string,
  keyInput: string
): Promise<{ success: boolean; message: string }> {
  const url = urlInput.trim().replace(/\/$/, '');
  const key = keyInput.trim();
  if (!url.startsWith('https://')) {
    return { success: false, message: 'يجب أن يبدأ الرابط بـ https:// (مثال: https://xyz.supabase.co)' };
  }
  if (!key || key.length < 20) {
    return { success: false, message: 'مفتاح المشروع غير صحيح (يجب أن يكون anon public key صالحاً).' };
  }
  try {
    // The browser only verifies the public Supabase project connection here.
    // The protected app_gemini_keys table is intentionally server-only and
    // is accessed by the protected server-side central API with its private server credentials.
    // Do not probe that table from the browser: its RLS protection is expected.
    const authRes = await fetch(`${url}/auth/v1/settings`, {
      method: 'GET',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    });

    if (authRes.status === 401 || authRes.status === 403) {
      return { success: false, message: 'فشل التحقق من مفتاح Supabase: المفتاح العام غير صالح أو غير مقبول من المشروع.' };
    }
    if (!authRes.ok) {
      return { success: false, message: `تعذر التحقق من مفتاح Supabase (${authRes.status}). تحقق من رابط المشروع والمفتاح.` };
    }

    return {
      success: true,
      message: 'تم الاتصال بـ Supabase والتحقق من المفتاح بنجاح. تخزين مفاتيح Gemini المركزي يتم عبر خادم المنصة بصلاحية Service Role ولا يعتمد على فتح جدول app_gemini_keys للمتصفح.',
    };
  } catch (err: any) {
    return { success: false, message: `تعذر الاتصال بـ Supabase: ${err?.message || 'خطأ في الشبكة'}` };
  }
}

/**
 * Gemini keys are server-only secrets. These compatibility functions never
 * read/write app_gemini_keys from the browser.
 */
export async function fetchCloudGeminiKeys(): Promise<string[]> {
  try {
    const token = getAdminSessionToken();
    if (!token) return [];
    const res = await fetch('/api/admin/keys-status', {
      headers: { 'x-admin-session': token },
    });
    if (!res.ok) return [];
    // Never return actual API keys to client code. This function remains for
    // backward compatibility and therefore returns an empty secret list.
    return [];
  } catch {
    return [];
  }
}

export async function saveGeminiKeyToSupabase(geminiKey: string): Promise<{ success: boolean; message: string }> {
  const cleanKey = sanitizeGeminiKey(geminiKey);
  if (!isValidKeyFormat(cleanKey)) return { success: false, message: 'مفتاح Gemini غير صالح.' };
  const token = getAdminSessionToken();
  if (!token) return { success: false, message: 'جلسة الإدارة غير متاحة.' };
  try {
    const res = await fetch('/api/admin/keys/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-session': token },
      body: JSON.stringify({ apiKey: cleanKey }),
    });
    const data = await res.json().catch(() => ({}));
    return { success: res.ok && data?.ok !== false, message: data?.message || data?.error || 'تعذر حفظ المفتاح.' };
  } catch (err: any) {
    return { success: false, message: err?.message || 'تعذر حفظ المفتاح.' };
  }
}

export async function deleteGeminiKeyFromSupabase(geminiKey: string): Promise<boolean> {
  // The central admin endpoint accepts an index rather than a secret value.
  // Preserve the old function without ever transmitting the secret to Supabase.
  return false;
}
