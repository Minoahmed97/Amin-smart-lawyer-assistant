export type FileBatchStatus = 'waiting' | 'preparing' | 'processing' | 'completed' | 'failed';

export interface StoredFileBatchItem {
  id: string;
  userId: string;
  scope: string;
  batchId: string;
  order: number;
  fileName: string;
  mimeType: string;
  size: number;
  lastModified: number;
  createdAt: string;
  updatedAt: string;
  status: FileBatchStatus;
  stageLabel: string;
  jobId?: string;
  serverJobCreated?: boolean;
  extractedText?: string;
  error?: string;
  retryCount: number;
  deliveredToWorkflow: boolean;
  blob: Blob;
}

const DB_NAME = 'amin-file-batch-storage';
const DB_VERSION = 1;
const STORE_NAME = 'files';

function makeScopeKey(userId: string, scope: string): string {
  return `${userId}::${scope}`;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('تخزين الملفات محليًا غير مدعوم في هذا المتصفح.'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('userScope', 'userScope', { unique: false });
        store.createIndex('batchId', 'batchId', { unique: false });
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error || new Error('تعذر فتح مخزن الملفات المرفوعة.'));
    request.onblocked = () => reject(new Error('مخزن الملفات مشغول بتحديث آخر. أغلق النسخ الأخرى من التطبيق ثم أعد المحاولة.'));
  });
}

export function createFileBatchId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {}
  return `batch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createFileOcrJobId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {}
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.random() * 16 | 0;
    return (character === 'x' ? random : (random & 0x3 | 0x8)).toString(16);
  });
}

export async function saveFileBatchItems(items: StoredFileBatchItem[]): Promise<void> {
  if (!items.length) return;
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      for (const item of items) {
        store.put({ ...item, userScope: makeScopeKey(item.userId, item.scope) });
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('تعذر حفظ الملفات الأصلية في التخزين المحلي.'));
      transaction.onabort = () => reject(transaction.error || new Error('تم إلغاء حفظ الملفات الأصلية.'));
    });
  } finally {
    database.close();
  }
}

export async function getFileBatchItems(userId: string, scope: string): Promise<StoredFileBatchItem[]> {
  if (!userId || !scope) return [];
  const database = await openDatabase();
  try {
    const rows = await new Promise<StoredFileBatchItem[]>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).index('userScope').getAll(makeScopeKey(userId, scope));
      request.onsuccess = () => resolve((request.result || []) as StoredFileBatchItem[]);
      request.onerror = () => reject(request.error || new Error('تعذرت استعادة الملفات المحفوظة.'));
    });
    return rows
      .filter((item) => item.userId === userId && item.scope === scope)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.batchId.localeCompare(b.batchId) || a.order - b.order);
  } finally {
    database.close();
  }
}

export async function updateFileBatchItem(
  id: string,
  userId: string,
  scope: string,
  changes: Partial<Omit<StoredFileBatchItem, 'id' | 'userId' | 'scope' | 'blob'>>,
): Promise<StoredFileBatchItem> {
  const database = await openDatabase();
  try {
    return await new Promise<StoredFileBatchItem>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      let updated: StoredFileBatchItem | null = null;
      const request = store.get(id);
      request.onsuccess = () => {
        const current = request.result as (StoredFileBatchItem & { userScope?: string }) | undefined;
        if (!current || current.userId !== userId || current.scope !== scope) {
          transaction.abort();
          reject(new Error('الملف المطلوب غير موجود في نطاق العمل الحالي.'));
          return;
        }
        updated = {
          ...current,
          ...changes,
          updatedAt: new Date().toISOString(),
        };
        store.put({ ...updated, userScope: makeScopeKey(userId, scope) });
      };
      request.onerror = () => reject(request.error || new Error('تعذر قراءة حالة الملف لتحديثها.'));
      transaction.oncomplete = () => {
        if (updated) resolve(updated);
        else reject(new Error('لم يتم تحديث سجل الملف.'));
      };
      transaction.onerror = () => reject(transaction.error || new Error('تعذر تحديث حالة الملف.'));
      transaction.onabort = () => reject(transaction.error || new Error('تم إلغاء تحديث حالة الملف.'));
    });
  } finally {
    database.close();
  }
}

export async function deleteFileBatchItem(id: string, userId: string, scope: string): Promise<void> {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(id);
      request.onsuccess = () => {
        const record = request.result as StoredFileBatchItem | undefined;
        if (record && record.userId === userId && record.scope === scope) store.delete(id);
      };
      request.onerror = () => reject(request.error || new Error('تعذر التحقق من ملكية الملف.'));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('تعذر حذف الملف المحفوظ.'));
      transaction.onabort = () => reject(transaction.error || new Error('تم إلغاء حذف الملف.'));
    });
  } finally {
    database.close();
  }
}

export function restoreFileFromBatchItem(item: StoredFileBatchItem): File {
  return new File([item.blob], item.fileName, {
    type: item.mimeType || 'application/octet-stream',
    lastModified: item.lastModified || Date.now(),
  });
}
