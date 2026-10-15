export interface LegalVaultOriginalFile {
  id: string;
  userId: string;
  fileName: string;
  mimeType: string;
  size: number;
  createdAt: string;
  category: string;
  courtType: string;
  workType: string;
  blob: Blob;
}

const DB_NAME = 'amin-legal-vault-original-files';
const DB_VERSION = 1;
const STORE = 'originalFiles';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('تخزين الملفات الأصلية غير مدعوم في هذا المتصفح.'));
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('userId', 'userId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('تعذر فتح مخزن الملفات الأصلية.'));
  });
}

function classify(fileName: string, text: string) {
  const value = `${fileName} ${text.slice(0, 12000)}`.toLowerCase();
  const has = (...terms: string[]) => terms.some((term) => value.includes(term.toLowerCase()));
  let courtType = 'غير مصنف';
  if (has('مجلس الدولة', 'محكمة القضاء الإداري', 'المحكمة الإدارية العليا', 'هيئة مفوضي الدولة', 'قضاء إداري')) courtType = 'مجلس الدولة';
  else if (has('محكمة النقض', 'محكمة الاستئناف', 'محكمة الأسرة', 'المحكمة الابتدائية', 'المحكمة الجزئية', 'القضاء العادي')) courtType = 'القضاء العادي';
  let workType = 'مستند عام';
  if (has('طعن بالنقض', 'أسباب الطعن بالنقض')) workType = 'طعن بالنقض';
  else if (has('استئناف', 'محكمة الاستئناف')) workType = 'استئناف';
  else if (has('انضباط', 'مجلس تأديب', 'جزاء تأديبي')) workType = 'انضباط / تأديب';
  else if (has('إعلان على يد محضر', 'إعلان رسمي', 'إنذار رسمي')) workType = 'إعلان / إنذار';
  else if (has('صحيفة دعوى', 'المدعي', 'المدعى عليه')) workType = 'صحيفة دعوى';
  else if (has('مذكرة بدفاع', 'مذكرة دفاع', 'الطلبات الختامية')) workType = 'مذكرة بدفاع';
  let category = courtType;
  if (workType.includes('طعن') || workType === 'استئناف') category = workType;
  else if (workType.includes('انضباط')) category = 'انضباط';
  else if (workType.includes('إعلان')) category = 'إعلانات';
  return { category, courtType, workType };
}

export async function saveLegalVaultOriginalFile(file: File, userId: string, extractedText = ''): Promise<LegalVaultOriginalFile> {
  const classified = classify(file.name, extractedText);
  const record: LegalVaultOriginalFile = {
    id: `original_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`,
    userId,
    fileName: file.name,
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
    createdAt: new Date().toISOString(),
    ...classified,
    blob: file.slice(0, file.size, file.type || 'application/octet-stream'),
  };
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('تعذر حفظ الملف الأصلي.'));
      tx.onabort = () => reject(tx.error || new Error('تم إلغاء حفظ الملف الأصلي.'));
    });
  } finally { db.close(); }
  return record;
}

export async function getLegalVaultOriginalFiles(userId: string): Promise<LegalVaultOriginalFile[]> {
  const db = await openDb();
  try {
    const records = await new Promise<LegalVaultOriginalFile[]>((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).index('userId').getAll(userId);
      req.onsuccess = () => resolve((req.result || []) as LegalVaultOriginalFile[]);
      req.onerror = () => reject(req.error || new Error('تعذر قراءة الملفات الأصلية.'));
    });
    return records.sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  } finally { db.close(); }
}

export async function downloadLegalVaultOriginalFile(id: string, userId: string): Promise<void> {
  const db = await openDb();
  let record: LegalVaultOriginalFile | undefined;
  try {
    record = await new Promise<LegalVaultOriginalFile | undefined>((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result as LegalVaultOriginalFile | undefined);
      req.onerror = () => reject(req.error || new Error('تعذر قراءة الملف.'));
    });
  } finally { db.close(); }
  if (!record || record.userId !== userId) throw new Error('الملف غير موجود في حسابك.');
  const url = URL.createObjectURL(record.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = record.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function deleteLegalVaultOriginalFile(id: string, userId: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const req = store.get(id);
      req.onsuccess = () => {
        const record = req.result as LegalVaultOriginalFile | undefined;
        if (record && record.userId === userId) store.delete(id);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('تعذر حذف الملف الأصلي.'));
    });
  } finally { db.close(); }
}
