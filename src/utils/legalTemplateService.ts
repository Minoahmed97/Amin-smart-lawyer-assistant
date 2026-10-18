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
  const sample = `${fileName} ${text.slice(0, 16000)}`.toLowerCase().replace(/[ًٌٍَُِّْـ]/g, '');
  const has = (...terms: string[]) => terms.some((term) => sample.includes(term.toLowerCase()));

  let courtType = 'غير مصنف';
  if (has('المحكمة الإدارية العليا', 'الإدارية العليا', 'محكمة القضاء الإداري', 'مجلس الدولة', 'هيئة مفوضي الدولة', 'قضاء إداري', 'محكمة تأديبية')) {
    courtType = 'مجلس الدولة';
  } else if (has('محكمة النقض', 'محكمة الاستئناف', 'محكمة الأسرة', 'المحكمة الابتدائية', 'المحكمة الجزئية', 'القضاء العادي', 'مدني', 'جنائي', 'تجاري')) {
    courtType = 'القضاء العادي';
  }

  let workType = 'مستند قضائي عام';
  if (has('طعن أمام المحكمة الإدارية العليا', 'الطعن بالإدارية العليا', 'الإدارية العليا')) workType = 'طعن بالإدارية العليا';
  else if (has('طعن بالنقض', 'أسباب الطعن بالنقض', 'محكمة النقض')) workType = 'طعن بالنقض';
  else if (has('استئناف', 'المستأنف', 'محكمة الاستئناف')) workType = 'استئناف';
  else if (has('انضباط', 'مجلس تأديب', 'جزاء تأديبي', 'دعوى تأديبية')) workType = 'انضباط / تأديب';
  else if (has('مذكرة بدفاع', 'مذكرة دفاع', 'مذكرة شارحة')) workType = 'مذكرة بدفاع';
  else if (has('صحيفة دعوى', 'إقامة الدعوى', 'المدعي', 'المدعى عليه')) workType = 'صحيفة دعوى';
  else if (has('إعلان على يد محضر', 'إعلان رسمي', 'إنذار رسمي', 'إنذار على يد محضر')) workType = 'إعلان / إنذار';
  else if (has('طلب عارض', 'طلبات عارضة')) workType = 'طلب عارض';
  else if (has('حافظة مستندات', 'بيان مستندات')) workType = 'حافظة مستندات';

  let category = courtType;
  if (workType.includes('الإدارية العليا')) category = 'طعن بالإدارية العليا';
  else if (workType.includes('طعن بالنقض') || workType === 'استئناف') category = workType;
  else if (workType.includes('انضباط')) category = 'انضباط';
  else if (workType.includes('إعلان')) category = 'إعلانات';
  else if (workType === 'صحيفة دعوى') category = 'صحف الدعاوى';
  else if (workType.includes('مذكرة')) category = 'مذكرات';
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
  const facts = normalize((criteria.facts || '').slice(0, 7000));
  const tokens = new Set(facts.split(/\s+/).filter((x) => x.length > 3).slice(0, 180));
  const groups: Array<{ keys: string[]; terms: string[] }> = [
    { keys: ['طعن بالإدارية العليا', 'الإدارية العليا', 'الطعن بالإدارية العليا'], terms: ['طعن بالإدارية العليا', 'المحكمة الإدارية العليا', 'الإدارية العليا'] },
    { keys: ['طعن بالنقض', 'النقض', 'أسباب الطعن بالنقض'], terms: ['طعن بالنقض', 'أسباب الطعن بالنقض', 'محكمة النقض'] },
    { keys: ['استئناف', 'طعن أو استئناف'], terms: ['استئناف', 'المستأنف', 'المستأنف ضده'] },
    { keys: ['انضباط', 'تأديب', 'انضباط / تأديب'], terms: ['انضباط', 'تأديب', 'مجلس تأديب', 'دعوى تأديبية'] },
    { keys: ['صحيفة دعوى', 'دعوى', 'كتابة دعوى / صحيفة دعوى'], terms: ['صحيفة دعوى', 'دعوى', 'المدعي', 'المدعى عليه'] },
    { keys: ['مذكرة', 'مذكرة بدفاع', 'مذكرة دفاع'], terms: ['مذكرة بدفاع', 'مذكرة دفاع', 'مذكرة شارحة'] },
    { keys: ['تفنيد مستند أو مذكرة', 'الرد على مستند أو مذكرة', 'تفنيد', 'رد على مستند'], terms: ['تفنيد', 'الرد على المستند', 'الرد على مذكرة'] },
    { keys: ['طلب قانوني', 'طلب عارض'], terms: ['طلب قانوني', 'طلب عارض', 'طلبات عارضة'] },
    { keys: ['إنذار أو مكاتبة قانونية', 'إنذار', 'إعلان'], terms: ['إنذار رسمي', 'إعلان على يد محضر', 'إنذار على يد محضر'] },
    { keys: ['حافظة مستندات'], terms: ['حافظة مستندات', 'بيان مستندات'] },
    { keys: ['عقد أو اتفاقية', 'عقد'], terms: ['عقد', 'اتفاقية'] },
  ];
  const normalizedTemplate = (template: LegalDocTemplate) => normalize(`${template.title} ${template.fileName} ${template.category} ${template.courtType} ${template.workType}`);
  const normalizedWork = work.replace(/^(?:إنشاء صيغة قانونية|صيغة قانونية|مستند قضائي عام|مهمة قانونية أخرى)$/, '').trim();
  const activeGroup = groups.find((group) => group.keys.some((key) => normalizedWork === normalize(key) || normalizedWork.includes(normalize(key)) || normalize(key).includes(normalizedWork)));
  const scored = templates.map((template) => {
    const text = normalizedTemplate(template);
    let score = 0;
    const courtValue = normalize(template.courtType);
    if (court && courtValue !== 'غير مصنف') {
      if (courtValue === court || courtValue.includes(court) || court.includes(courtValue)) score += 100;
      else if ((court.includes('الإدارية') || court.includes('الإداري') || court.includes('القضاء الإداري') || court.includes('مجلس الدولة') || court.includes('محكمة تأديبية')) && courtValue.includes('مجلس الدولة')) score += 80;
      else if ((court.includes('العادي') || court.includes('مدني') || court.includes('جنائي') || court.includes('تجاري') || court.includes('استئناف') || court.includes('محكمة النقض') || court.includes('ابتدائية') || court.includes('جزئية') || court.includes('الأسرة')) && courtValue.includes('القضاء العادي')) score += 80;
      else score -= 200;
    }
    if (activeGroup) {
      const matched = activeGroup.terms.some((term) => text.includes(normalize(term)));
      score += matched ? 140 : -100;
    } else if (normalizedWork) {
      if (text.includes(normalizedWork)) score += 100;
      else {
        const workTokens = normalizedWork.split(/\s+/).filter((x) => x.length > 2);
        score += workTokens.filter((token) => text.includes(token)).length * 12;
      }
    }
    if (tokens.size) {
      let hits = 0;
      for (const token of tokens) if (normalize(template.title).includes(token)) hits++;
      score += Math.min(hits, 12) * 1.5;
    }
    // Avoid selecting a template that has no meaningful relation to the requested work.
    return { template, score };
  }).sort((a, b) => b.score - a.score || b.template.createdAt.localeCompare(a.template.createdAt));
  return scored[0] && scored[0].score > 0 ? scored[0].template : null;
}
