/**
 * Keeps the original files for unfinished OCR batches in IndexedDB.
 * localStorage is intentionally limited to small job metadata; image bytes live here.
 */
export interface PendingOcrFileRecord {
  id: string;
  scope: string;
  userId: string;
  fileName: string;
  mimeType: string;
  size: number;
  lastModified: number;
  blob: Blob;
  jobId?: string;
  createdAt: number;
}

const DB_NAME = 'amin-pending-ocr-files-v1';
const STORE_NAME = 'pending-files';

function cleanPart(value: string | undefined): string {
  return String(value || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('التخزين المحلي للملفات غير مدعوم في هذا المتصفح.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('تعذر فتح التخزين المحلي للملفات.'));
    request.onblocked = () => reject(new Error('تحديث تخزين الملفات محجوب بواسطة تبويب آخر مفتوح.'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const request = run(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('تعذر الوصول إلى التخزين المحلي للملفات.'));
      transaction.onabort = () => reject(transaction.error || new Error('تم إلغاء عملية حفظ الملف.'));
    });
  } finally {
    db.close();
  }
}

function makeId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {}
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export async function savePendingOcrFile(file: File, scope: string, userId?: string): Promise<string> {
  const id = makeId();
  const record: PendingOcrFileRecord = {
    id,
    scope: cleanPart(scope),
    userId: cleanPart(userId),
    fileName: file.name,
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
    lastModified: file.lastModified || 0,
    blob: file.slice(0, file.size, file.type || 'application/octet-stream'),
    createdAt: Date.now(),
  };
  await withStore('readwrite', (store) => store.put(record));
  return id;
}

export async function listPendingOcrFiles(scope: string, userId?: string): Promise<Array<PendingOcrFileRecord & { file: File }>> {
  const rows = await withStore('readonly', (store) => store.getAll());
  return (Array.isArray(rows) ? rows : [])
    .filter((row: PendingOcrFileRecord) => row.scope === cleanPart(scope) && row.userId === cleanPart(userId))
    .sort((a: PendingOcrFileRecord, b: PendingOcrFileRecord) => a.createdAt - b.createdAt)
    .map((row: PendingOcrFileRecord) => ({
      ...row,
      file: new File([row.blob], row.fileName, { type: row.mimeType, lastModified: row.lastModified || row.createdAt }),
    }));
}

export async function setPendingOcrFileJob(id: string, jobId?: string): Promise<void> {
  const existing = await withStore('readonly', (store) => store.get(id)) as PendingOcrFileRecord | undefined;
  if (!existing) return;
  const next = { ...existing };
  if (jobId) next.jobId = jobId;
  else delete next.jobId;
  await withStore('readwrite', (store) => store.put(next));
}

export async function clearPendingOcrFileJobByJobId(jobId: string): Promise<void> {
  if (!jobId) return;
  const rows = await withStore('readonly', (store) => store.getAll()) as PendingOcrFileRecord[];
  const matches = rows.filter((row) => row.jobId === jobId);
  for (const row of matches) {
    const next = { ...row };
    delete next.jobId;
    await withStore('readwrite', (store) => store.put(next));
  }
}

export async function deletePendingOcrFile(id: string): Promise<void> {
  if (!id) return;
  await withStore('readwrite', (store) => store.delete(id));
}

export async function deletePendingOcrFileByJobId(jobId: string): Promise<void> {
  if (!jobId) return;
  const rows = await withStore('readonly', (store) => store.getAll()) as PendingOcrFileRecord[];
  const matches = rows.filter((row) => row.jobId === jobId);
  for (const row of matches) await deletePendingOcrFile(row.id);
}
