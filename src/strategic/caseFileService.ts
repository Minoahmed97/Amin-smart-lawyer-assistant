import type {
  CaseContextChange,
  CaseDocument,
  CaseFact,
  CaseMemoryEntry,
  UnifiedCaseFile,
  CaseDataOrigin,
  VerificationStatus,
} from './types.ts';
import { getSessionToken } from '../services/authService.ts';

const API_PATH = '/api/strategic/cases';

function createId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {}
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = Math.random() * 16 | 0;
    return (char === 'x' ? random : (random & 0x3 | 0x8)).toString(16);
  });
}

async function request<T>(path = '', init: RequestInit = {}): Promise<T> {
  const token = getSessionToken();
  if (!token) throw new Error('انتهت جلسة الحساب. سجّل الدخول قبل التعامل مع ملفات القضايا.');
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'application/json');
  headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${API_PATH}${path}`, { ...init, headers, cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error: any = new Error(String(data?.error || 'تعذر تنفيذ عملية ملف القضية.'));
    error.statusCode = response.status;
    throw error;
  }
  return data as T;
}

function now(): string {
  return new Date().toISOString();
}

export function createEmptyCaseFile(ownerUserId: string, title: string): UnifiedCaseFile {
  if (!ownerUserId || !ownerUserId.trim()) throw new Error('معرّف حساب المحامي مطلوب.');
  if (!title || !title.trim()) throw new Error('عنوان ملف القضية مطلوب.');
  const timestamp = now();
  return {
    schemaVersion: 1,
    id: createId(),
    ownerUserId: ownerUserId.trim(),
    title: title.trim(),
    parties: [],
    requests: [],
    decisions: [],
    keyDates: [],
    originalFacts: [],
    documents: [],
    evidence: [],
    legalIssues: [],
    defenses: [],
    opponentPosition: [],
    analysisSnapshots: [],
    memory: [],
    contextChanges: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: {},
  };
}

export async function createCaseFile(caseFile: UnifiedCaseFile): Promise<UnifiedCaseFile> {
  const result = await request<{ caseFile: UnifiedCaseFile }>('', {
    method: 'POST',
    body: JSON.stringify({ caseFile }),
  });
  return result.caseFile;
}

export async function listCaseFiles(): Promise<UnifiedCaseFile[]> {
  const result = await request<{ cases: UnifiedCaseFile[] }>();
  return result.cases || [];
}

export async function getCaseFile(caseId: string): Promise<UnifiedCaseFile> {
  if (!caseId) throw new Error('معرّف القضية مطلوب.');
  const result = await request<{ caseFile: UnifiedCaseFile }>(`?id=${encodeURIComponent(caseId)}`);
  return result.caseFile;
}

export async function saveCaseFile(caseFile: UnifiedCaseFile, expectedUpdatedAt?: string): Promise<UnifiedCaseFile> {
  const result = await request<{ caseFile: UnifiedCaseFile }>(`?id=${encodeURIComponent(caseFile.id)}`, {
    method: 'PUT',
    body: JSON.stringify({ caseFile, expectedUpdatedAt }),
  });
  return result.caseFile;
}

export async function deleteCaseFile(caseId: string): Promise<void> {
  if (!caseId) throw new Error('معرّف القضية مطلوب.');
  await request(`?id=${encodeURIComponent(caseId)}`, { method: 'DELETE' });
}

export function makeCaseFact(
  text: string,
  origin: CaseDataOrigin = 'attorney_input',
  verification: VerificationStatus = 'unverified',
  sourceDocumentIds: string[] = [],
): CaseFact {
  const timestamp = now();
  return {
    id: createId(),
    text: text.trim(),
    origin,
    verification,
    sourceDocumentIds: [...sourceDocumentIds],
    relatedFactIds: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function makeCaseDocument(input: Omit<CaseDocument, 'id' | 'addedAt' | 'updatedAt'>): CaseDocument {
  const timestamp = now();
  return { ...input, id: createId(), addedAt: timestamp, updatedAt: timestamp };
}

export function makeCaseMemoryEntry(
  caseId: string,
  category: CaseMemoryEntry['category'],
  content: string,
  origin: CaseDataOrigin,
  verification: VerificationStatus,
  relatedFactIds: string[] = [],
  sourceDocumentIds: string[] = [],
): CaseMemoryEntry {
  return {
    id: createId(),
    caseId,
    category,
    content: content.trim(),
    origin,
    verification,
    relatedFactIds: [...relatedFactIds],
    sourceDocumentIds: [...sourceDocumentIds],
    createdAt: now(),
  };
}

export function makeContextChange(
  caseId: string,
  changeType: CaseContextChange['changeType'],
  description: string,
  affectedFactIds: string[] = [],
  affectedDocumentIds: string[] = [],
): CaseContextChange {
  return {
    id: createId(),
    caseId,
    changeType,
    description: description.trim(),
    affectedFactIds: [...affectedFactIds],
    affectedDocumentIds: [...affectedDocumentIds],
    createdAt: now(),
    reevaluationStatus: 'pending',
  };
}

export async function addCaseFact(
  caseFile: UnifiedCaseFile,
  fact: CaseFact,
  expectedUpdatedAt?: string,
): Promise<UnifiedCaseFile> {
  if (!fact.text.trim()) throw new Error('لا يمكن حفظ واقعة فارغة.');
  const updated: UnifiedCaseFile = {
    ...caseFile,
    originalFacts: [...caseFile.originalFacts, fact],
    memory: [...caseFile.memory, makeCaseMemoryEntry(caseFile.id, 'attorney_fact', fact.text, fact.origin, fact.verification, [fact.id], fact.sourceDocumentIds)],
    contextChanges: [...caseFile.contextChanges, makeContextChange(caseFile.id, 'fact_added', 'إضافة واقعة جديدة إلى ملف القضية.', [fact.id])],
  };
  return saveCaseFile(updated, expectedUpdatedAt ?? caseFile.updatedAt);
}

export async function addCaseDocument(
  caseFile: UnifiedCaseFile,
  document: CaseDocument,
  expectedUpdatedAt?: string,
): Promise<UnifiedCaseFile> {
  if (!document.name.trim()) throw new Error('اسم المستند مطلوب.');
  const updated: UnifiedCaseFile = {
    ...caseFile,
    documents: [...caseFile.documents, document],
    memory: [...caseFile.memory, makeCaseMemoryEntry(
      caseFile.id,
      'extracted_information',
      `إضافة مستند: ${document.name}`,
      document.origin,
      'unverified',
      [],
      [document.id],
    )],
    contextChanges: [...caseFile.contextChanges, makeContextChange(caseFile.id, 'document_added', `إضافة المستند: ${document.name}`, [], [document.id])],
  };
  return saveCaseFile(updated, expectedUpdatedAt ?? caseFile.updatedAt);
}

export async function appendAttorneyCorrection(
  caseFile: UnifiedCaseFile,
  content: string,
  relatedFactIds: string[] = [],
  expectedUpdatedAt?: string,
): Promise<UnifiedCaseFile> {
  if (!content.trim()) throw new Error('نص تصحيح المحامي مطلوب.');
  const updated: UnifiedCaseFile = {
    ...caseFile,
    memory: [...caseFile.memory, makeCaseMemoryEntry(caseFile.id, 'attorney_edit', content, 'attorney_edit', 'verified', relatedFactIds)],
    contextChanges: [...caseFile.contextChanges, makeContextChange(caseFile.id, 'attorney_correction', 'إضافة تصحيح أو توجيه من المحامي.', relatedFactIds)],
  };
  return saveCaseFile(updated, expectedUpdatedAt ?? caseFile.updatedAt);
}
