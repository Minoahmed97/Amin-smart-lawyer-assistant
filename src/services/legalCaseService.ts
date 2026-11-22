import { LegalCaseContext } from '../types.ts';
import { getSessionToken } from './authService.ts';
import { persistentStorage } from '../utils/persistentStorage.ts';

export interface LegalCaseRecord {
  case_id: string;
  case_data: LegalCaseContext;
  created_at?: string;
  updated_at?: string;
}

const safeUserKey = (userId: string) => String(userId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
const localKey = (userId: string) => `amin_legal_case_files_${safeUserKey(userId)}`;

function readLocalCases(userId: string): LegalCaseRecord[] {
  const rows = persistentStorage.getJSON<LegalCaseRecord[]>(localKey(userId), []);
  return Array.isArray(rows) ? rows.filter((row) => row?.case_id && row?.case_data?.caseId === row.case_id) : [];
}

function writeLocalCase(userId: string, context: LegalCaseContext): LegalCaseRecord[] {
  const rows = readLocalCases(userId);
  const now = new Date().toISOString();
  const next: LegalCaseRecord = {
    case_id: context.caseId,
    case_data: context,
    created_at: rows.find((row) => row.case_id === context.caseId)?.created_at || now,
    updated_at: now,
  };
  const updated = [next, ...rows.filter((row) => row.case_id !== context.caseId)].slice(0, 100);
  persistentStorage.setJSON(localKey(userId), updated);
  return updated;
}

async function request(path: string, init: RequestInit = {}) {
  const token = getSessionToken();
  if (!token) throw new Error('جلسة الحساب غير متاحة؛ يرجى تسجيل الدخول من جديد.');
  const headers = new Headers(init.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...init, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || 'تعذر الاتصال بتخزين ملفات القضايا.');
  return data;
}

export async function listLegalCases(userId: string): Promise<{ cases: LegalCaseRecord[]; cloudAvailable: boolean }> {
  const localCases = readLocalCases(userId);
  try {
    const data = await request('/api/cases');
    const cloudCases = Array.isArray(data?.cases) ? data.cases as LegalCaseRecord[] : [];
    const merged = new Map<string, LegalCaseRecord>();
    for (const row of localCases) merged.set(row.case_id, row);
    for (const row of cloudCases) {
      const local = merged.get(row.case_id);
      if (!local || Date.parse(row.updated_at || '') >= Date.parse(local.updated_at || '')) merged.set(row.case_id, row);
    }
    const cases = [...merged.values()].sort((a, b) => Date.parse(b.updated_at || '') - Date.parse(a.updated_at || ''));
    return { cases, cloudAvailable: true };
  } catch {
    return { cases: localCases, cloudAvailable: false };
  }
}

export async function saveLegalCase(userId: string, context: LegalCaseContext): Promise<{ cases: LegalCaseRecord[]; cloudSaved: boolean }> {
  const localCases = writeLocalCase(userId, context);
  try {
    await request('/api/cases', {
      method: 'POST',
      body: JSON.stringify({ caseId: context.caseId, caseData: context }),
    });
    return { cases: readLocalCases(userId), cloudSaved: true };
  } catch {
    return { cases: localCases, cloudSaved: false };
  }
}

export function getLocalLegalCases(userId: string): LegalCaseRecord[] {
  return readLocalCases(userId);
}
