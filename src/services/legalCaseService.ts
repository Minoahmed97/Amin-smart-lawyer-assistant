import { getSessionToken } from './authService.ts';

export interface LegalCase {
  id: string;
  title: string;
  case_number?: string;
  case_year?: string;
  court_name?: string;
  circuit?: string;
  case_type?: string;
  client_name?: string;
  opponent_name?: string;
  notes?: string;
  status?: string;
  updated_at?: string;
}

export interface LegalCaseRecord {
  id: string;
  case_id: string;
  record_type: string;
  title: string;
  content: string;
  occurred_at?: string | null;
  created_at?: string;
}

async function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'application/json');
  const token = getSessionToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(path, { ...init, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || 'تعذر تنفيذ طلب ذاكرة القضية.');
  return data;
}

export async function listLegalCases(): Promise<LegalCase[]> {
  const data = await request('/api/legal-cases');
  return Array.isArray(data?.cases) ? data.cases : [];
}

export async function createLegalCase(input: Partial<LegalCase>): Promise<LegalCase> {
  const data = await request('/api/legal-cases', { method: 'POST', body: JSON.stringify(input) });
  if (!data?.case?.id) throw new Error('لم يتم حفظ ملف القضية بصورة صحيحة.');
  return data.case;
}

export async function listLegalCaseRecords(caseId: string): Promise<LegalCaseRecord[]> {
  const data = await request(`/api/legal-cases/${encodeURIComponent(caseId)}/records`);
  return Array.isArray(data?.records) ? data.records : [];
}

export async function createLegalCaseRecord(caseId: string, input: { record_type: string; title: string; content: string; occurred_at?: string }): Promise<LegalCaseRecord> {
  const data = await request(`/api/legal-cases/${encodeURIComponent(caseId)}/records`, { method: 'POST', body: JSON.stringify(input) });
  if (!data?.record?.id) throw new Error('لم يتم حفظ سجل القضية بصورة صحيحة.');
  try { window.dispatchEvent(new CustomEvent('amin_legal_case_history_updated', { detail: { caseId } })); } catch {}
  return data.record;
}

export function selectedLegalCaseStorageKey(userId: string): string {
  return `amin_selected_legal_case_${String(userId || '').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

export function getSelectedLegalCaseId(userId: string): string {
  try { return localStorage.getItem(selectedLegalCaseStorageKey(userId)) || ''; } catch { return ''; }
}

export interface LegalCaseDocument {
  id: string;
  file_name: string;
  mime_type: string;
  file_size: number;
  document_type: string;
  extracted_text?: string;
  created_at?: string;
}

export async function listLegalCaseDocuments(caseId: string): Promise<LegalCaseDocument[]> {
  const data = await request(`/api/legal-cases/${encodeURIComponent(caseId)}/documents`);
  return Array.isArray(data?.documents) ? data.documents : [];
}

export async function uploadLegalCaseDocument(caseId: string, file: File, extractedText: string): Promise<LegalCaseDocument> {
  const signed = await request(`/api/legal-cases/${encodeURIComponent(caseId)}/documents/upload-url`, {
    method: 'POST',
    body: JSON.stringify({ file_name: file.name, mime_type: file.type || 'application/octet-stream', file_size: file.size }),
  });
  if (!signed?.uploadUrl || !signed?.storagePath) throw new Error('لم يصل رابط رفع آمن صالح للمستند.');
  const uploadResponse = await fetch(signed.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  if (!uploadResponse.ok) throw new Error('تعذر رفع الملف إلى التخزين الخاص للقضية.');
  const saved = await request(`/api/legal-cases/${encodeURIComponent(caseId)}/documents`, {
    method: 'POST',
    body: JSON.stringify({
      storage_path: signed.storagePath,
      file_name: file.name,
      mime_type: file.type || 'application/octet-stream',
      file_size: file.size,
      document_type: 'case_document',
      extracted_text: extractedText || '',
    }),
  });
  if (!saved?.document?.id) throw new Error('تم رفع الملف لكن لم يتم تسجيله في ذاكرة القضية.');
  return saved.document;
}

export async function getLegalCaseDocumentDownloadUrl(caseId: string, documentId: string): Promise<string> {
  const data = await request(`/api/legal-cases/${encodeURIComponent(caseId)}/documents/${encodeURIComponent(documentId)}`);
  if (!data?.signedUrl) throw new Error('تعذر إنشاء رابط تنزيل المستند.');
  return data.signedUrl;
}

export async function deleteLegalCaseDocument(caseId: string, documentId: string): Promise<void> {
  await request(`/api/legal-cases/${encodeURIComponent(caseId)}/documents/${encodeURIComponent(documentId)}`, { method: 'DELETE' });
}
