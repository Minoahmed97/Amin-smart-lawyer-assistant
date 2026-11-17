import crypto from 'node:crypto';
import { requireActiveSession } from './auth.ts';
import { limitBodyString } from './security.ts';

const CASE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECORD_TYPES = new Set(['fact','document','memorandum','filing','request','hearing','judgment','analysis','defense','note','task','other']);

function getSupabaseConfig() {
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
  const key = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim();
  if (!url || !key) throw new Error('إعدادات Supabase المركزية غير مكتملة على الخادم.');
  return { url, key };
}

async function supabase(path: string, init: RequestInit = {}) {
  const { url, key } = getSupabaseConfig();
  const headers: Record<string, string> = {
    apikey: key,
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  };
  if (!key.startsWith('sb_')) headers.Authorization = `Bearer ${key}`;
  return fetch(`${url}/rest/v1/${path}`, { ...init, headers });
}

const CASE_FILES_BUCKET = 'amin-legal-case-files';

async function storageApi(path: string, init: RequestInit = {}) {
  const { url, key } = getSupabaseConfig();
  const headers: Record<string, string> = {
    apikey: key,
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  };
  if (!key.startsWith('sb_')) headers.Authorization = `Bearer ${key}`;
  return fetch(`${url}/storage/v1/${path}`, { ...init, headers });
}

function encodeStoragePath(path: string) {
  return path.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function absoluteStorageUrl(url: string, baseUrl: string) {
  if (url.startsWith('https://') || url.startsWith('http://')) return url;
  const normalized = url.startsWith('/') ? url : `/${url}`;
  return normalized.startsWith('/storage/v1/')
    ? `${baseUrl}${normalized}`
    : `${baseUrl}/storage/v1${normalized}`;
}

function parseBody(req: any) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body && typeof req.body === 'object' ? req.body : {};
}

function routeParts(req: any): string[] {
  return String(req?.query?.legalCasePath || '').split('/').filter(Boolean).map((part) => decodeURIComponent(part));
}

async function ownedCase(caseId: string, ownerId: string) {
  if (!CASE_ID_PATTERN.test(caseId)) return null;
  const response = await supabase(`legal_cases?select=*&id=eq.${encodeURIComponent(caseId)}&owner_platform_user_id=eq.${encodeURIComponent(ownerId)}&archived_at=is.null&limit=1`);
  if (!response.ok) throw new Error('تعذر قراءة ملف القضية من قاعدة البيانات.');
  return (await response.json())?.[0] || null;
}

export async function loadLegalCaseContext(req: any, caseId: string, maxChars = 36000): Promise<string> {
  const { session } = await requireActiveSession(req);
  const legalCase = await ownedCase(String(caseId || ''), session.userId);
  if (!legalCase) {
    const error: any = new Error('القضية المحددة غير موجودة أو لا تخص هذا الحساب.');
    error.statusCode = 404;
    throw error;
  }
  const recordsResponse = await supabase(
    `legal_case_records?select=record_type,title,content,occurred_at,created_at&case_id=eq.${encodeURIComponent(caseId)}&owner_platform_user_id=eq.${encodeURIComponent(session.userId)}&order=occurred_at.desc.nullslast,created_at.desc&limit=100`,
  );
  if (!recordsResponse.ok) throw new Error('تعذر قراءة سجل القضية.');
  const records = await recordsResponse.json();
  const documentsResponse = await supabase(
    `legal_case_documents?select=file_name,document_type,extracted_text,created_at&case_id=eq.${encodeURIComponent(caseId)}&owner_platform_user_id=eq.${encodeURIComponent(session.userId)}&order=created_at.desc&limit=50`,
  );
  if (!documentsResponse.ok) throw new Error('تعذر قراءة مستندات القضية.');
  const documents = await documentsResponse.json();

  const sections = [
    '[سجل القضية الدائم — مرجع للمقارنة وليس بديلاً عن مستندات المهمة الحالية]',
    `عنوان القضية: ${legalCase.title || ''}`,
    `رقم القضية: ${legalCase.case_number || ''} / ${legalCase.case_year || ''}`,
    `المحكمة والدائرة: ${legalCase.court_name || ''} — ${legalCase.circuit || ''}`,
    `نوع القضية: ${legalCase.case_type || ''}`,
    `الموكل: ${legalCase.client_name || ''}؛ الخصم: ${legalCase.opponent_name || ''}`,
    legalCase.notes ? `ملاحظات الملف: ${legalCase.notes}` : '',
    '[الوقائع والإجراءات والمذكرات والطلبات السابقة]',
    ...(Array.isArray(records) ? records.map((record: any) =>
      `[${record.record_type}] ${record.title || ''} — ${record.occurred_at || record.created_at || ''}\n${record.content || ''}`
    ) : []),
    '[المستندات السابقة والنصوص المستخرجة منها]',
    ...(Array.isArray(documents) ? documents.map((document: any) =>
      `[${document.document_type}] ${document.file_name || ''}\n${document.extracted_text || '[لا يوجد نص مستخرج محفوظ]'}`
    ) : []),
  ].filter(Boolean);
  let context = '';
  for (const section of sections) {
    const addition = `\n\n${section}`;
    if (context.length + addition.length > maxChars) {
      const remaining = maxChars - context.length;
      if (remaining > 120) context += addition.slice(0, remaining) + '\n[تم اختصار بقية سجل القضية لحماية حدود السياق]';
      break;
    }
    context += addition;
  }
  return context;
}

export default async function handler(req: any, res: any) {
  if (!['GET','POST','PATCH','DELETE'].includes(String(req.method || '').toUpperCase())) {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  try {
    const { session } = await requireActiveSession(req);
    const parts = routeParts(req);
    const caseId = parts[0] || '';
    const subresource = parts[1] || '';
    const recordId = parts[2] || '';
    const body = parseBody(req);

    if (!caseId) {
      if (req.method === 'GET') {
        const response = await supabase(`legal_cases?select=*&owner_platform_user_id=eq.${encodeURIComponent(session.userId)}&archived_at=is.null&order=updated_at.desc&limit=200`);
        if (!response.ok) return res.status(503).json({ error: 'تعذر استرجاع ملفات القضايا.' });
        return res.json({ cases: await response.json() });
      }
      if (req.method === 'POST') {
        const title = String(body.title || '').trim();
        if (!title) return res.status(400).json({ error: 'يرجى إدخال اسم أو عنوان القضية.' });
        limitBodyString(title, 300, 'عنوان القضية');
        for (const key of ['case_number','case_year','court_name','circuit','case_type','client_name','opponent_name','notes']) {
          if (body[key] !== undefined) limitBodyString(String(body[key] || ''), key === 'notes' ? 10000 : 500, key);
        }
        const row = {
          owner_platform_user_id: session.userId,
          title,
          case_number: String(body.case_number || ''),
          case_year: String(body.case_year || ''),
          court_name: String(body.court_name || ''),
          circuit: String(body.circuit || ''),
          case_type: String(body.case_type || ''),
          client_name: String(body.client_name || ''),
          opponent_name: String(body.opponent_name || ''),
          notes: String(body.notes || ''),
        };
        const response = await supabase('legal_cases', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
        if (!response.ok) return res.status(503).json({ error: 'تعذر حفظ القضية.' });
        return res.status(201).json({ case: (await response.json())?.[0] || null });
      }
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    if (!CASE_ID_PATTERN.test(caseId)) return res.status(400).json({ error: 'معرّف القضية غير صالح.' });
    const legalCase = await ownedCase(caseId, session.userId);
    if (!legalCase) return res.status(404).json({ error: 'القضية غير موجودة.' });

    if (subresource === 'context' && req.method === 'GET') {
      return res.json({ context: await loadLegalCaseContext(req, caseId) });
    }

    if (subresource === 'documents') {
      if (!recordId && req.method === 'GET') {
        const response = await supabase(`legal_case_documents?select=id,file_name,mime_type,file_size,document_type,created_at&case_id=eq.${encodeURIComponent(caseId)}&owner_platform_user_id=eq.${encodeURIComponent(session.userId)}&order=created_at.desc&limit=200`);
        if (!response.ok) return res.status(503).json({ error: 'تعذر استرجاع مستندات القضية.' });
        return res.json({ documents: await response.json() });
      }

      if (recordId === 'upload-url' && req.method === 'POST') {
        const fileName = String(body.file_name || '').trim().replace(/[\\/\\\\]/g, '_').slice(0, 180);
        const mimeType = String(body.mime_type || 'application/octet-stream').slice(0, 160);
        const fileSize = Math.floor(Number(body.file_size || 0));
        if (!fileName || !Number.isFinite(fileSize) || fileSize <= 0 || fileSize > 50 * 1024 * 1024) {
          return res.status(400).json({ error: 'بيانات الملف غير صالحة أو يتجاوز الحد الأقصى 50 ميجابايت.' });
        }
        const storagePath = `${session.userId}/${caseId}/${crypto.randomUUID()}-${fileName}`;
        const encodedPath = encodeStoragePath(storagePath);
        const signResponse = await storageApi(`object/upload/sign/${CASE_FILES_BUCKET}/${encodedPath}`, {
          method: 'POST',
          body: JSON.stringify({ upsert: false }),
        });
        const signData = await signResponse.json().catch(() => ({}));
        if (!signResponse.ok || !signData?.token) return res.status(503).json({ error: 'تعذر إنشاء رابط رفع آمن للمستند.' });
        const { url } = getSupabaseConfig();
        const uploadUrl = `${url}/storage/v1/object/upload/sign/${CASE_FILES_BUCKET}/${encodedPath}?token=${encodeURIComponent(signData.token)}`;
        return res.json({ uploadUrl, storagePath, tokenExpiresIn: 7200 });
      }

      if (!recordId && req.method === 'POST') {
        const storagePath = String(body.storage_path || '');
        const expectedPrefix = `${session.userId}/${caseId}/`;
        if (!storagePath.startsWith(expectedPrefix) || storagePath.includes('..')) {
          return res.status(400).json({ error: 'مسار تخزين المستند غير صالح.' });
        }
        const fileName = String(body.file_name || '').trim().slice(0, 180);
        const mimeType = String(body.mime_type || 'application/octet-stream').slice(0, 160);
        const fileSize = Math.floor(Number(body.file_size || 0));
        const extractedText = String(body.extracted_text || '');
        if (!fileName || !Number.isFinite(fileSize) || fileSize <= 0 || fileSize > 50 * 1024 * 1024) return res.status(400).json({ error: 'بيانات المستند غير صالحة.' });
        limitBodyString(extractedText, 180000, 'النص المستخرج من المستند');
        const row = {
          case_id: caseId,
          owner_platform_user_id: session.userId,
          record_id: body.record_id && CASE_ID_PATTERN.test(String(body.record_id)) ? String(body.record_id) : null,
          file_name: fileName,
          mime_type: mimeType,
          file_size: fileSize,
          storage_path: storagePath,
          document_type: String(body.document_type || 'other').slice(0, 80),
          extracted_text: extractedText,
        };
        const response = await supabase('legal_case_documents', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
        if (!response.ok) return res.status(503).json({ error: 'تم رفع الملف لكن تعذر تسجيله في ملف القضية. أعد المحاولة أو احتفظ بالملف الأصلي.' });
        await supabase(`legal_cases?id=eq.${encodeURIComponent(caseId)}&owner_platform_user_id=eq.${encodeURIComponent(session.userId)}`, { method: 'PATCH', body: JSON.stringify({ updated_at: new Date().toISOString() }) });
        return res.status(201).json({ document: (await response.json())?.[0] || null });
      }

      if (recordId && !CASE_ID_PATTERN.test(recordId)) return res.status(400).json({ error: 'معرّف المستند غير صالح.' });
      if (recordId && req.method === 'GET') {
        const response = await supabase(`legal_case_documents?select=id,file_name,storage_path,mime_type,file_size,document_type&id=eq.${encodeURIComponent(recordId)}&case_id=eq.${encodeURIComponent(caseId)}&owner_platform_user_id=eq.${encodeURIComponent(session.userId)}&limit=1`);
        if (!response.ok) return res.status(503).json({ error: 'تعذر قراءة بيانات المستند.' });
        const document = (await response.json())?.[0];
        if (!document) return res.status(404).json({ error: 'المستند غير موجود.' });
        const signResponse = await storageApi(`object/sign/${CASE_FILES_BUCKET}/${encodeStoragePath(document.storage_path)}`, {
          method: 'POST',
          body: JSON.stringify({ expiresIn: 300 }),
        });
        const signData = await signResponse.json().catch(() => ({}));
        const signedUrl = signData?.signedURL || signData?.signedUrl || signData?.url;
        if (!signResponse.ok || !signedUrl) return res.status(503).json({ error: 'تعذر إنشاء رابط تنزيل آمن للمستند.' });
        const { url } = getSupabaseConfig();
        return res.json({ signedUrl: absoluteStorageUrl(String(signedUrl), url) });
      }

      if (recordId && req.method === 'DELETE') {
        const lookup = await supabase(`legal_case_documents?select=id,storage_path&id=eq.${encodeURIComponent(recordId)}&case_id=eq.${encodeURIComponent(caseId)}&owner_platform_user_id=eq.${encodeURIComponent(session.userId)}&limit=1`);
        if (!lookup.ok) return res.status(503).json({ error: 'تعذر قراءة المستند قبل حذفه.' });
        const document = (await lookup.json())?.[0];
        if (!document) return res.status(404).json({ error: 'المستند غير موجود.' });
        const deleteStorage = await storageApi(`object/${CASE_FILES_BUCKET}`, {
          method: 'DELETE',
          body: JSON.stringify({ prefixes: [document.storage_path] }),
        });
        if (!deleteStorage.ok) return res.status(503).json({ error: 'تعذر حذف الملف من التخزين الآمن.' });
        const deleteRow = await supabase(`legal_case_documents?id=eq.${encodeURIComponent(recordId)}&case_id=eq.${encodeURIComponent(caseId)}&owner_platform_user_id=eq.${encodeURIComponent(session.userId)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
        if (!deleteRow.ok) return res.status(503).json({ error: 'تعذر حذف سجل المستند.' });
        return res.json({ success: true });
      }
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    if (subresource === 'records') {
      if (!recordId && req.method === 'GET') {
        const response = await supabase(`legal_case_records?select=*&case_id=eq.${encodeURIComponent(caseId)}&owner_platform_user_id=eq.${encodeURIComponent(session.userId)}&order=occurred_at.desc.nullslast,created_at.desc&limit=300`);
        if (!response.ok) return res.status(503).json({ error: 'تعذر استرجاع سجل القضية.' });
        return res.json({ records: await response.json() });
      }
      if (!recordId && req.method === 'POST') {
        const title = String(body.title || '').trim();
        const content = String(body.content || '');
        const recordType = String(body.record_type || 'note');
        if (!title) return res.status(400).json({ error: 'عنوان السجل مطلوب.' });
        if (!RECORD_TYPES.has(recordType)) return res.status(400).json({ error: 'نوع سجل القضية غير صالح.' });
        limitBodyString(title, 300, 'عنوان السجل');
        limitBodyString(content, 150000, 'محتوى السجل');
        const row = {
          case_id: caseId,
          owner_platform_user_id: session.userId,
          record_type: recordType,
          title,
          content,
          occurred_at: body.occurred_at || null,
          metadata: body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? body.metadata : {},
        };
        const response = await supabase('legal_case_records', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) });
        if (!response.ok) return res.status(503).json({ error: 'تعذر حفظ سجل القضية.' });
        await supabase(`legal_cases?id=eq.${encodeURIComponent(caseId)}&owner_platform_user_id=eq.${encodeURIComponent(session.userId)}`, { method: 'PATCH', body: JSON.stringify({ updated_at: new Date().toISOString() }) });
        return res.status(201).json({ record: (await response.json())?.[0] || null });
      }
      if (recordId && !CASE_ID_PATTERN.test(recordId)) return res.status(400).json({ error: 'معرّف السجل غير صالح.' });
      if (recordId && ['PATCH','DELETE'].includes(req.method)) {
        const filter = `id=eq.${encodeURIComponent(recordId)}&case_id=eq.${encodeURIComponent(caseId)}&owner_platform_user_id=eq.${encodeURIComponent(session.userId)}`;
        if (req.method === 'DELETE') {
          const response = await supabase(`legal_case_records?${filter}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
          if (!response.ok) return res.status(503).json({ error: 'تعذر حذف السجل.' });
          return res.json({ success: true });
        }
        const patch: any = { updated_at: new Date().toISOString() };
        if (body.title !== undefined) { patch.title = String(body.title || '').trim(); limitBodyString(patch.title, 300, 'عنوان السجل'); }
        if (body.content !== undefined) { patch.content = String(body.content || ''); limitBodyString(patch.content, 150000, 'محتوى السجل'); }
        if (body.record_type !== undefined) {
          if (!RECORD_TYPES.has(String(body.record_type))) return res.status(400).json({ error: 'نوع سجل القضية غير صالح.' });
          patch.record_type = String(body.record_type);
        }
        if (body.occurred_at !== undefined) patch.occurred_at = body.occurred_at || null;
        const response = await supabase(`legal_case_records?${filter}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) });
        if (!response.ok) return res.status(503).json({ error: 'تعذر تحديث سجل القضية.' });
        return res.json({ record: (await response.json())?.[0] || null });
      }
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    if (req.method === 'GET') return res.json({ case: legalCase });
    if (req.method === 'PATCH') {
      const patch: any = { updated_at: new Date().toISOString() };
      const allowed = ['title','case_number','case_year','court_name','circuit','case_type','client_name','opponent_name','notes','status'];
      for (const key of allowed) {
        if (body[key] !== undefined) {
          patch[key] = String(body[key] || '');
          limitBodyString(patch[key], key === 'notes' ? 10000 : 500, key);
        }
      }
      const response = await supabase(`legal_cases?id=eq.${encodeURIComponent(caseId)}&owner_platform_user_id=eq.${encodeURIComponent(session.userId)}&archived_at=is.null`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) });
      if (!response.ok) return res.status(503).json({ error: 'تعذر تحديث ملف القضية.' });
      return res.json({ case: (await response.json())?.[0] || null });
    }
    if (req.method === 'DELETE') {
      const response = await supabase(`legal_cases?id=eq.${encodeURIComponent(caseId)}&owner_platform_user_id=eq.${encodeURIComponent(session.userId)}&archived_at=is.null`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ status: 'archived', archived_at: new Date().toISOString(), updated_at: new Date().toISOString() }) });
      if (!response.ok) return res.status(503).json({ error: 'تعذر أرشفة القضية.' });
      return res.json({ success: true });
    }
    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (error: any) {
    return res.status(Number(error?.statusCode) || 500).json({ error: error?.message || 'تعذر تنفيذ عملية ملف القضية.' });
  }
}
