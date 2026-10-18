export type TemplateMode = 'auto' | 'manual';

export interface LegalDocTemplate {
  id: string;
  userId: string;
  title: string;
  fileName: string;
  category: string;
  courtType: string;
  workType: string;
  createdAt: string;
  blob: Blob;
}

const DB_NAME = 'amin-legal-doc-templates';
const DB_VERSION = 1;
const STORE_NAME = 'templates';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('تخزين قوالب وورد غير متاح في هذا المتصفح.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('userId', 'userId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('تعذر فتح مخزن قوالب وورد.'));
  });
}

export function classifyLegalDocument(fileName: string, text: string): Pick<LegalDocTemplate, 'category' | 'courtType' | 'workType'> {
  const sample = `${fileName} ${text.slice(0, 12000)}`.toLowerCase();
  const has = (...terms: string[]) => terms.some((term) => sample.includes(term.toLowerCase()));

  let courtType = 'غير مصنف';
  if (has('مجلس الدولة', 'محكمة القضاء الإداري', 'المحكمة الإدارية العليا', 'الإدارية العليا', 'هيئة مفوضي الدولة', 'قضاء إداري')) {
    courtType = 'مجلس الدولة';
  } else if (has('محكمة النقض', 'محكمة الاستئناف', 'محكمة الأسرة', 'المحكمة الابتدائية', 'المحكمة الجزئية', 'القضاء العادي')) {
    courtType = 'القضاء العادي';
  }

  let workType = 'مذكرة / مستند عام';
  if (has('طعن بالنقض', 'أسباب الطعن بالنقض', 'محكمة النقض')) workType = 'طعن بالنقض';
  else if (has('استئناف', 'محكمة الاستئناف')) workType = 'استئناف';
  else if (has('انضباط', 'مجلس تأديب', 'جزاء تأديبي')) workType = 'انضباط / تأديب';
  else if (has('إعلان على يد محضر', 'إعلان رسمي', 'إنذار رسمي')) workType = 'إعلان / إنذار';
  else if (has('صحيفة دعوى', 'المدعي', 'المدعى عليه')) workType = 'صحيفة دعوى';
  else if (has('مذكرة بدفاع', 'مذكرة دفاع', 'مذكرة مدني', 'مذكرة مدنية', 'مذكرة جنح', 'مذكرة جنائي', 'الطلبات الختامية')) workType = 'مذكرة بدفاع';

  let category = courtType;
  if (workType.includes('طعن') || workType === 'استئناف') category = workType;
  else if (workType.includes('انضباط')) category = 'انضباط';
  else if (workType.includes('إعلان')) category = 'إعلانات';
  return { category, courtType, workType };
}

export async function saveLegalDocTemplate(file: File, userId: string, extractedText = ''): Promise<LegalDocTemplate | null> {
  if (!file.name.toLowerCase().endsWith('.docx')) return null;
  const classification = classifyLegalDocument(file.name, extractedText);
  const record: LegalDocTemplate = {
    id: `template_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`,
    userId,
    title: file.name.replace(/\.docx$/i, ''),
    fileName: file.name,
    ...classification,
    createdAt: new Date().toISOString(),
    blob: file.slice(0, file.size, file.type || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
  };
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('تعذر حفظ قالب وورد.'));
      tx.onabort = () => reject(tx.error || new Error('تم إلغاء حفظ قالب وورد.'));
    });
  } finally {
    db.close();
  }
  return { ...record, blob: record.blob };
}

export async function getLegalDocTemplates(userId: string): Promise<LegalDocTemplate[]> {
  const db = await openDb();
  try {
    const records = await new Promise<LegalDocTemplate[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).index('userId').getAll(userId);
      request.onsuccess = () => resolve((request.result || []) as LegalDocTemplate[]);
      request.onerror = () => reject(request.error || new Error('تعذر قراءة قوالب وورد.'));
    });
    return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } finally {
    db.close();
  }
}

export async function getLegalDocTemplate(id: string, userId: string): Promise<LegalDocTemplate | null> {
  const db = await openDb();
  try {
    return await new Promise<LegalDocTemplate | null>((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id);
      request.onsuccess = () => {
        const value = request.result as LegalDocTemplate | undefined;
        resolve(value && value.userId === userId ? value : null);
      };
      request.onerror = () => reject(request.error || new Error('تعذر قراءة قالب وورد.'));
    });
  } finally {
    db.close();
  }
}

export async function deleteLegalDocTemplate(id: string, userId: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const getRequest = store.get(id);
      getRequest.onsuccess = () => {
        const value = getRequest.result as LegalDocTemplate | undefined;
        if (value && value.userId === userId) store.delete(id);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('تعذر حذف قالب وورد.'));
    });
  } finally {
    db.close();
  }
}

export function chooseBestLegalDocTemplate(
  templates: LegalDocTemplate[],
  criteria: { courtType?: string; workType?: string; facts?: string },
): LegalDocTemplate | null {
  if (!templates.length) return null;
  const normalize = (value: string) => value.toLowerCase().replace(/[ًٌٍَُِّْـ]/g, '').replace(/[^\u0600-\u06FFa-z0-9\s]/gi, ' ').replace(/\s+/g, ' ').trim();
  const court = normalize(criteria.courtType || '');
  const work = normalize(criteria.workType || '');
  const genericWorkTypes = new Set(['مذكرة', 'مذكرة بدفاع', 'مستند عام', 'انشاء صيغة قانونية', 'صيغة قانونية']);
  const useWorkSignal = !!work && !genericWorkTypes.has(work);
  const facts = normalize((criteria.facts || '').slice(0, 5000));
  const tokens = new Set(facts.split(/\s+/).filter((x) => x.length > 3));
  const scored = templates.map((template) => {
    let score = 0;
    const courtValue = normalize(template.courtType);
    const workValue = normalize(template.workType);
    const category = normalize(template.category);
    const title = normalize(template.title);
    if (court && courtValue !== 'غير مصنف' && (courtValue.includes(court) || court.includes(courtValue))) score += 50;
    if (useWorkSignal && (workValue.includes(work) || work.includes(workValue) || category.includes(work) || title.includes(work))) score += 35;
    const memoRequest = /مذكر|دفاع/.test(work);
    if (memoRequest && /مذكر|دفاع/.test(`${workValue} ${category} ${title} ${normalize(template.fileName)}`)) score += 30;
    if (/مدن/.test(work) && /مدن/.test(`${workValue} ${category} ${title} ${normalize(template.fileName)}`)) score += 15;
    if (/تأديب|انضباط/.test(work) && /تأديب|انضباط/.test(`${workValue} ${category} ${title} ${normalize(template.fileName)}`)) score += 25;
    if (/إدارية عليا/.test(work) && /إدارية عليا|مجلس الدولة/.test(`${workValue} ${category} ${title} ${normalize(template.fileName)}`)) score += 25;
    if (tokens.size) {
      for (const token of tokens) if (title.includes(token)) score += 1;
    }
    return { template, score };
  }).sort((a, b) => b.score - a.score || b.template.createdAt.localeCompare(a.template.createdAt));
  return scored[0] && scored[0].score > 0 ? scored[0].template : null;
}
