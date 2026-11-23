import { requireActiveSession } from '../auth.ts';

const TABLE = 'app_strategic_case_files';
const MAX_CASE_BYTES = 5 * 1024 * 1024;

function getSupabaseConfig() {
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
  const key = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim();
  if (!url || !key) {
    const error: any = new Error('إعدادات التخزين المركزي غير مكتملة على الخادم.');
    error.statusCode = 503;
    throw error;
  }
  return { url, key };
}

async function supabase(path: string, init: RequestInit = {}) {
  const { url, key } = getSupabaseConfig();
  return fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      ...(key.startsWith('sb_') ? {} : { Authorization: `Bearer ${key}` }),
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
    signal: init.signal || AbortSignal.timeout(12000),
  });
}

function parseBody(req: any): any {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch {}
  }
  return {};
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function jsonSize(value: unknown): number {
  try { return new TextEncoder().encode(JSON.stringify(value)).length; } catch { return MAX_CASE_BYTES + 1; }
}

function validateCaseFile(value: any): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'بيانات ملف القضية غير صالحة.';
  if (value.schemaVersion !== 1) return 'إصدار ملف القضية غير مدعوم.';
  if (!validId(value.id)) return 'معرّف ملف القضية غير صالح.';
  if (typeof value.title !== 'string' || !value.title.trim()) return 'يجب إدخال عنوان لملف القضية.';
  if (!Array.isArray(value.parties) || !Array.isArray(value.originalFacts) ||
      !Array.isArray(value.documents) || !Array.isArray(value.memory) ||
      !Array.isArray(value.contextChanges)) return 'بنية ملف القضية غير مكتملة.';
  if (jsonSize(value) > MAX_CASE_BYTES) return 'حجم ملف القضية يتجاوز الحد المسموح. قسّم النصوص أو المستندات الكبيرة.';
  return '';
}

async function readRows(path: string) {
  const response = await supabase(path);
  if (!response.ok) {
    const error: any = new Error('تعذر قراءة ملفات القضايا من التخزين المركزي.');
    error.statusCode = response.status >= 500 ? 503 : 400;
    throw error;
  }
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

export default async function handler(req: any, res: any) {
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(String(req.method || '').toUpperCase())) {
    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ error: 'طريقة الطلب غير مسموح بها.' });
  }

  const { session } = await requireActiveSession(req);
  const userId = session.userId;
  const caseId = String(req?.query?.id || '').trim();

  if (req.method === 'GET') {
    if (caseId && !validId(caseId)) return res.status(400).json({ error: 'معرّف القضية غير صالح.' });
    const select = 'select=case_id,case_data,created_at,updated_at';
    const filter = caseId
      ? `&case_id=eq.${encodeURIComponent(caseId)}&limit=1`
      : '&order=updated_at.desc&limit=200';
    const rows = await readRows(`${TABLE}?${select}&owner_user_id=eq.${encodeURIComponent(userId)}${filter}`);
    if (caseId && !rows.length) return res.status(404).json({ error: 'لم يتم العثور على ملف القضية.' });
    return res.status(200).json({ cases: rows.map((row: any) => row.case_data), caseFile: rows[0]?.case_data || null });
  }

  if (req.method === 'POST') {
    const body = parseBody(req);
    const caseFile = body.caseFile;
    const validationError = validateCaseFile(caseFile);
    if (validationError) return res.status(400).json({ error: validationError });
    const now = new Date().toISOString();
    const stored = { ...caseFile, ownerUserId: userId, createdAt: caseFile.createdAt || now, updatedAt: now };
    const response = await supabase(TABLE, {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ case_id: stored.id, owner_user_id: userId, case_data: stored, created_at: now, updated_at: now }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      if (response.status === 409 || /duplicate key|unique constraint/i.test(detail)) return res.status(409).json({ error: 'يوجد ملف قضية بهذا المعرّف بالفعل.' });
      return res.status(503).json({ error: 'تعذر حفظ ملف القضية في التخزين المركزي.' });
    }
    return res.status(201).json({ caseFile: stored });
  }

  if (!validId(caseId)) return res.status(400).json({ error: 'يجب تحديد معرّف صحيح لملف القضية.' });

  if (req.method === 'PUT') {
    const body = parseBody(req);
    const caseFile = body.caseFile;
    if (!caseFile || caseFile.id !== caseId) return res.status(400).json({ error: 'معرّف ملف القضية لا يطابق البيانات المرسلة.' });
    const validationError = validateCaseFile(caseFile);
    if (validationError) return res.status(400).json({ error: validationError });
    const now = new Date().toISOString();
    const stored = { ...caseFile, ownerUserId: userId, updatedAt: now };
    let path = `${TABLE}?case_id=eq.${encodeURIComponent(caseId)}&owner_user_id=eq.${encodeURIComponent(userId)}`;
    if (typeof body.expectedUpdatedAt === 'string' && body.expectedUpdatedAt) {
      path += `&updated_at=eq.${encodeURIComponent(body.expectedUpdatedAt)}`;
    }
    const response = await supabase(path, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ case_data: stored, updated_at: now }),
    });
    if (!response.ok) return res.status(503).json({ error: 'تعذر تحديث ملف القضية في التخزين المركزي.' });
    const rows = await response.json().catch(() => []);
    if (!Array.isArray(rows) || !rows.length) return res.status(409).json({ error: 'تغير ملف القضية في جلسة أخرى أو لم يعد متاحاً. أعد تحميله قبل الحفظ.' });
    return res.status(200).json({ caseFile: stored });
  }

  const response = await supabase(
    `${TABLE}?case_id=eq.${encodeURIComponent(caseId)}&owner_user_id=eq.${encodeURIComponent(userId)}`,
    { method: 'DELETE', headers: { Prefer: 'return=representation' } },
  );
  if (!response.ok) return res.status(503).json({ error: 'تعذر حذف ملف القضية من التخزين المركزي.' });
  const rows = await response.json().catch(() => []);
  if (!Array.isArray(rows) || !rows.length) return res.status(404).json({ error: 'لم يتم العثور على ملف القضية.' });
  return res.status(200).json({ deleted: true, caseId });
}
