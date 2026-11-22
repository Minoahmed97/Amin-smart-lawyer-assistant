import { requireActiveSession } from './auth.ts';

const MAX_CASE_BYTES = 240_000;
const CASE_ID_PATTERN = /^[a-zA-Z0-9_-]{8,120}$/;

function getSupabaseConfig() {
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
  const key = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim();
  if (!url || !key) {
    const error: any = new Error('إعدادات التخزين السحابي غير مكتملة على الخادم.');
    error.statusCode = 503;
    throw error;
  }
  return { url, key };
}

async function supabaseRequest(path: string, init: RequestInit = {}) {
  const { url, key } = getSupabaseConfig();
  const headers: Record<string, string> = {
    apikey: key,
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> || {}),
  };
  if (!key.startsWith('sb_')) headers.Authorization = `Bearer ${key}`;
  return fetch(`${url}/rest/v1/${path}`, { ...init, headers, signal: init.signal || AbortSignal.timeout(12_000) });
}

function parseBody(req: any) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return req.body && typeof req.body === 'object' ? req.body : null;
}

export default async function handler(req: any, res: any) {
  try {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'طريقة الطلب غير مدعومة.' });
    }

    const { session } = await requireActiveSession(req);
    if (req.method === 'GET') {
      const caseId = String(req.query?.caseId || '').trim();
      if (caseId && !CASE_ID_PATTERN.test(caseId)) {
        return res.status(400).json({ error: 'معرف ملف القضية غير صالح.' });
      }
      const filter = caseId ? `&case_id=eq.${encodeURIComponent(caseId)}` : '';
      const response = await supabaseRequest(
        `legal_case_files?select=case_id,case_data,created_at,updated_at&owner_user_id=eq.${encodeURIComponent(session.userId)}${filter}&order=updated_at.desc&limit=${caseId ? 1 : 100}`
      );
      if (!response.ok) {
        console.error('Legal case read failed:', response.status);
        return res.status(503).json({ error: 'تعذر تحميل ملفات القضايا من التخزين السحابي.' });
      }
      const rows = await response.json();
      return res.status(200).json({ cases: Array.isArray(rows) ? rows : [] });
    }

    const body = parseBody(req);
    const caseId = String(body?.caseId || '').trim();
    const caseData = body?.caseData;
    if (!CASE_ID_PATTERN.test(caseId) || !caseData || typeof caseData !== 'object' || Array.isArray(caseData)) {
      return res.status(400).json({ error: 'بيانات ملف القضية أو معرفه غير صالحة.' });
    }
    if (String(caseData.caseId || '') !== caseId || Number(caseData.schemaVersion) !== 1) {
      return res.status(400).json({ error: 'معرف ملف القضية أو إصدار بياناته غير متطابق.' });
    }
    const serialized = JSON.stringify(caseData);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_CASE_BYTES) {
      return res.status(413).json({ error: 'حجم ملف القضية تجاوز الحد المسموح. اختصر محتوى المستندات قبل الحفظ.' });
    }

    const now = new Date().toISOString();
    const response = await supabaseRequest(
      'legal_case_files?on_conflict=owner_user_id,case_id',
      {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({
          owner_user_id: session.userId,
          case_id: caseId,
          case_data: caseData,
          updated_at: now,
        }),
      },
    );
    if (!response.ok) {
      console.error('Legal case save failed:', response.status);
      return res.status(503).json({ error: 'تعذر حفظ ملف القضية في التخزين السحابي.' });
    }
    const rows = await response.json().catch(() => []);
    return res.status(200).json({ success: true, case: Array.isArray(rows) ? rows[0] || null : null });
  } catch (error: any) {
    const status = Number(error?.statusCode) || 500;
    return res.status(status).json({
      error: status < 500 ? (error?.message || 'تعذر تنفيذ الطلب.') : 'حدث خطأ أثناء التعامل مع ملف القضية.',
    });
  }
}
