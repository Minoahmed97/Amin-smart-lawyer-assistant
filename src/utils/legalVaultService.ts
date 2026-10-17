import { LawModelItem } from '../types.ts';

export type { LawModelItem };

export function getActiveLawyerUserId(): string {
  try {
    const saved = localStorage.getItem('judicial_active_user_id');
    if (saved && saved.trim()) return saved.trim();
    const newId = 'lawyer_' + Math.random().toString(36).substring(2, 9);
    localStorage.setItem('judicial_active_user_id', newId);
    return newId;
  } catch {
    return 'lawyer_default';
  }
}

export function getScopedStorageKey(userId?: string): string {
  const activeId = userId || getActiveLawyerUserId();
  return `_egyptian_legal_models_vault_v5_${activeId}`;
}

export function getAllLawModels(userId?: string): LawModelItem[] {
  const scopedKey = getScopedStorageKey(userId);

  const removeSystemModels = (models: LawModelItem[]): LawModelItem[] => {
    const customModels = models.filter((model) => model.source !== 'system');
    if (customModels.length !== models.length) {
      try {
        localStorage.setItem(scopedKey, JSON.stringify(customModels));
      } catch {}
    }
    return customModels;
  };

  try {
    const raw = localStorage.getItem(scopedKey);
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      // An existing empty array is a valid, intentionally empty vault.
      if (Array.isArray(parsed)) {
        return removeSystemModels(parsed);
      }
    }

    // Do not automatically import the legacy unscoped vault into an account.
    // That old key has no owner ID, so assigning it to whichever account logs in
    // first can expose another lawyer's models. Keep the legacy data untouched
    // for recovery; only read models stored under this account's scoped key.

    // Start with a genuinely empty user vault. The AI must learn style only
    // from models explicitly saved in this account's own vault.
    localStorage.setItem(scopedKey, JSON.stringify([]));
    return [];
  } catch (e) {
    console.warn('Error reading legal models vault:', e);
    return [];
  }
}

export function saveLawModel( model: Omit<LawModelItem, 'id' | 'createdAt'>, userId?: string ): LawModelItem {
  const current = getAllLawModels(userId);
  const newModel: LawModelItem = {
    ...model,
    id: 'model_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now().toString(36),
    createdAt: new Date().toISOString(),
    weight: model.weight || 5,
  };
  const updated = [newModel, ...current];
  try {
    localStorage.setItem(getScopedStorageKey(userId), JSON.stringify(updated));
  } catch (e) {
    console.warn('LocalStorage save error:', e);
  }
  return newModel;
}

export function updateLawModel( id: string, updates: Partial<LawModelItem>, userId?: string ): LawModelItem | null {
  const current = getAllLawModels(userId);
  const index = current.findIndex((m) => m.id === id);
  if (index === -1) return null;

  const updatedItem = { ...current[index], ...updates };
  current[index] = updatedItem;
  try {
    localStorage.setItem(getScopedStorageKey(userId), JSON.stringify(current));
  } catch (e) {
    console.warn('LocalStorage update error:', e);
  }
  return updatedItem;
}

export function deleteLawModel(id: string, userId?: string): void {
  const current = getAllLawModels(userId);
  const updated = current.filter((m) => m.id !== id);
  try {
    localStorage.setItem(getScopedStorageKey(userId), JSON.stringify(updated));
  } catch (e) {
    console.warn('LocalStorage delete error:', e);
  }
}

export function clearAllLawModels(userId?: string): void {
  try {
    localStorage.setItem(getScopedStorageKey(userId), JSON.stringify([]));
  } catch (e) {
    console.warn('LocalStorage clear error:', e);
  }
}

function normalizeVaultText(value: string): string {
  return (value || '')
    .toLowerCase()
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/[^\u0600-\u06FFa-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalDocumentType(value: string): string {
  const text = normalizeVaultText(value);
  if (!text) return '';
  // Check the more specific types first. A vault item may have broad metadata
  // (e.g. "إعلان / إنذار") but a title that identifies it as إعادة إعلان.
  if (text.includes('اعادة') && text.includes('اعلان')) return 'اعادة اعلان';
  if (text.includes('انذار')) return 'انذار';
  if ((text.includes('صحيفة') || text.includes('عريضة')) && (text.includes('دعوي') || text.includes('افتتاح'))) return 'صحيفة دعوى';
  if (text.includes('تفنيد') || (!text.includes('مذكرة') && text.includes('رد') && text.includes('مستند'))) return 'تفنيد مستندات';
  if (text.includes('اعلان') && (text.includes('قضائي') || text.includes('رسمي'))) return 'اعلان قضائي';
  if (text.includes('اعلان')) return 'اعلان';
  if (text.includes('مذكرة')) return 'مذكرة';
  return text;
}

function inferExplicitDocumentType(value: string): string {
  const text = normalizeVaultText(value || '');
  if (!text) return '';
  if (text.includes('اسباب الطعن بالنقض') || text.includes('طعن بالنقض')) return 'طعن بالنقض';
  if (text.includes('صحيفة الاستئناف') || text.includes('صحيفة استئناف') || text.includes('مذكرة باسباب الاستئناف')) return 'استئناف';
  if (text.includes('صحيفة دعوي') || text.includes('عريضة افتتاحية') || text.includes('صحيفة افتتاح دعوي')) return 'صحيفة دعوى';
  if (text.includes('تفنيد') || text.includes('مذكرة رد') || text.includes('مذكرة تعقيب') || text.includes('مذكرة جوابية') || text.includes('الرد علي مذكرة')) return 'تفنيد مستندات';
  if (text.includes('انذار رسمي') || text.includes('انذار علي يد محضر')) return 'إنذار';
  if (text.includes('اعلان رسمي') || text.includes('اعلان علي يد محضر')) return 'إعلان';
  if (text.includes('مذكرة بدفاع') || text.includes('مذكرة دفاع') || text.includes('مذكرة ختامية') || text.includes('مذكرة')) return 'مذكرة';
  return '';
}

function modelTypeLabels(model: LawModelItem): string[] {
  // Uploaded files may have older, broad auto-classification metadata. Prefer
  // an explicit type in the filename/title or the document's opening lines,
  // but never classify by party names alone.
  if (model.source === 'uploaded') {
    const titleType = inferExplicitDocumentType(`${model.title || ''} ${model.fileName || ''}`);
    if (titleType) return [titleType, String(model.title || '')];
    const openingText = String(model.content || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 14).join(' ');
    const headingType = inferExplicitDocumentType(openingText);
    if (headingType) return [headingType, String(model.title || '')];
  }
  return [model.judicialWorkType, model.title, model.category]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function modelTypeText(model: LawModelItem): string {
  return modelTypeLabels(model).join(' ');
}

function documentTypeFamily(value: string): string {
  const text = normalizeVaultText(value);
  if (!text) return '';
  if (text.includes('طعن') || text.includes('استئناف') || text.includes('نقض')) return 'appeal';
  if (text.includes('صحيفة') || text.includes('عريضة')) return 'claim';
  if (text.includes('انذار') || text.includes('اعلان')) return 'service';
  if (text.includes('تفنيد') || text.includes('تعقيب') || text.includes('مذكرة رد') || text.includes('جوابية') || text.includes('دفاع') || text.includes('دفوع')) return 'response';
  if (text.includes('مذكرة')) return 'memo';
  return '';
}

function modelMatchesRequestedType(model: LawModelItem, requestedType: string): boolean {
  const requested = canonicalDocumentType(requestedType);
  if (!requested) return false;

  // Use explicit document headings to repair misclassified uploaded files;
  // do not use similarities between the facts of separate cases.
  const labels = modelTypeLabels(model);
  if (labels.some((value) => canonicalDocumentType(value) === requested)) return true;

  const requestedFamily = documentTypeFamily(requestedType);
  const modelFamilies = labels.map(documentTypeFamily).filter(Boolean);
  if (requestedFamily && modelFamilies.some((family) => family === requestedFamily)) return true;
  // A lawyer's defence memorandum is an appropriate stylistic reference for
  // drafting rebuttals and replies, and vice versa; other document families
  // (claims, appeals, notices) remain distinct.
  if ((requestedFamily === 'response' && modelFamilies.includes('memo')) ||
      (requestedFamily === 'memo' && modelFamilies.includes('response'))) return true;
  // Do not let loose token overlap turn a different standard document type
  // (such as an appeal or claim) into a structural reference for a defence
  // memo. Fuzzy matching remains available for genuinely custom types.
  if (requestedFamily && modelFamilies.length) return false;

  const normalizedRequested = normalizeVaultText(requestedType);
  const requestedTokens = new Set(normalizedRequested.split(/\s+/).filter((token) => token.length >= 3));
  if (!requestedTokens.size) return false;

  const bestOverlap = labels.reduce((best, value) => {
    const normalized = normalizeVaultText(value);
    if (!normalized) return best;
    if (normalized.includes(normalizedRequested)) return 1;
    const modelTokens = new Set(normalized.split(/\s+/).filter((token) => token.length >= 3));
    let overlap = 0;
    requestedTokens.forEach((token) => { if (modelTokens.has(token)) overlap += 1; });
    return Math.max(best, overlap / requestedTokens.size);
  }, 0);
  return bestOverlap >= 0.5;
}

export function findSimilarModels( criteria: { courtType?: string; briefType?: string; judicialWorkType?: string; factsOrSubject?: string; }, userId?: string ): LawModelItem[] {
  const models = getAllLawModels(userId);
  if (!models.length) return [];

  const requestedType = criteria.judicialWorkType || criteria.briefType || '';
  const normalizedCourt = normalizeVaultText(criteria.courtType || '');
  const normalizedBrief = normalizeVaultText(criteria.briefType || '');
  const normalizedWorkType = normalizeVaultText(criteria.judicialWorkType || '');

  // Retrieve style references by document-type metadata, not by case facts or
  // similarity between the current case and the body of an old document.
  const scored = models.map((model, index) => {
    const typeText = normalizeVaultText(modelTypeText(model));
    const categoryText = normalizeVaultText(model.category || '');
    const titleText = normalizeVaultText(model.title || '');
    const notesText = normalizeVaultText(model.notes || '');
    let score = (model.weight || 3) * 2;

    if (normalizedWorkType) {
      if (modelMatchesRequestedType(model, requestedType)) score += 120;
      else if (typeText.includes(normalizedWorkType) || normalizedWorkType.includes(typeText)) score += 35;
      if (titleText.includes(normalizedWorkType) || categoryText.includes(normalizedWorkType)) score += 15;
    }
    if (normalizedBrief) {
      if (typeText.includes(normalizedBrief) || normalizedBrief.includes(typeText)) score += 40;
      if (titleText.includes(normalizedBrief) || categoryText.includes(normalizedBrief)) score += 20;
    }
    if (normalizedCourt) {
      if (categoryText && (categoryText.includes(normalizedCourt) || normalizedCourt.includes(categoryText))) score += 20;
      if (notesText.includes(normalizedCourt)) score += 8;
    }

    // Stable tie-break: preserve the existing vault order. The factsOrSubject
    // field intentionally does not affect retrieval, because doing so favored
    // old documents with similar facts and increased content bleed.
    return { model, score, index };
  });

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((item) => item.model);
}

function countPhrase(text: string, phrase: string): number {
  const normalizedText = normalizeVaultText(text);
  const normalizedPhrase = normalizeVaultText(phrase);
  if (!normalizedText || !normalizedPhrase) return 0;
  return normalizedText.split(normalizedPhrase).length - 1;
}

function deriveStyleProfile(content: string, includeStructure: boolean): string {
  const text = (content || '').replace(/\r/g, '').trim();
  if (!text) return 'العينة النصية غير كافية لاستخلاص خصائص أسلوبية.';

  const words = text.match(/[\u0600-\u06FFa-zA-Z0-9]+/g) || [];
  const nonEmptyLines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const paragraphChunks = text.split(/\n\s*\n+/).map((part) => part.trim()).filter(Boolean);
  const sentences = text.split(/[.!؟؛]+\s*/).map((part) => part.trim()).filter(Boolean);
  const averageSentenceWords = sentences.length
    ? Math.round(sentences.reduce((sum, sentence) => sum + ((sentence.match(/[\u0600-\u06FFa-zA-Z0-9]+/g) || []).length), 0) / sentences.length)
    : 0;
  const averageParagraphWords = paragraphChunks.length
    ? Math.round(paragraphChunks.reduce((sum, paragraph) => sum + ((paragraph.match(/[\u0600-\u06FFa-zA-Z0-9]+/g) || []).length), 0) / paragraphChunks.length)
    : words.length;

  const paragraphStyle = averageParagraphWords < 25
    ? 'فقرات قصيرة ومباشرة في الغالب'
    : averageParagraphWords < 60
      ? 'فقرات متوسطة الطول في الغالب'
      : 'فقرات مطوّلة نسبيًا تتدرج في عرض الفكرة';
  const sentenceStyle = averageSentenceWords < 18
    ? 'جمل قصيرة نسبيًا'
    : averageSentenceWords < 32
      ? 'جمل متوسطة تميل إلى الشرح المتدرج'
      : 'جمل طويلة مترابطة تحتاج الحفاظ على تسلسلها المنطقي';

  const connectors = [
    'وحيث إن', 'ولما كان', 'ولما كان الثابت', 'وإذ كان ذلك',
    'ومن ثم', 'الأمر الذي', 'مما يتعين معه', 'فضلاً عن ذلك',
    'على النحو التالي', 'بناء عليه', 'لهذه الأسباب', 'لذلك',
    'لما تقدم', 'ومؤدى ذلك', 'ولا ينال من ذلك'
  ];
  const commonConnectors = connectors
    .map((phrase) => ({ phrase, count: countPhrase(text, phrase) }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 7)
    .map((item) => item.phrase);

  const hasNumberedHeadings = /(?:^|\n)\s*(?:أولاً|اولا|ثانياً|ثانيا|ثالثاً|ثالثا|رابعاً|رابعا|خامساً|خامسا|سادساً|سادسا|[0-9٠-٩]+\s*[).ـ-])/m.test(text);
  const hasColonHeadings = nonEmptyLines.some((line) => line.length <= 90 && /[:：]$/.test(line));
  const styleNotes = [
    `طول المستند المرجعي: ${words.length < 400 ? 'موجز' : words.length < 1200 ? 'متوسط' : 'مفصل'}`,
    paragraphStyle,
    sentenceStyle,
    hasNumberedHeadings ? 'يميل إلى استخدام عناوين أو نقاط مرقمة' : 'لا يظهر اعتماد غالب على الترقيم المتسلسل للعناوين',
    hasColonHeadings ? 'تظهر عناوين موجزة يتبعها نقطتان في بعض المواضع' : 'العناوين المستقلة المنتهية بنقطتين ليست سمة ظاهرة',
    commonConnectors.length ? `روابط تعبيرية متكررة في أسلوب المحامي: ${commonConnectors.join('، ')}` : 'روابط تعبيرية غير كافية للرصد؛ استخدم انتقالات عربية قانونية طبيعية دون افتعال'
  ];

  if (includeStructure) {
    const preambleLabels: Array<[RegExp, string]> = [
      [/محكمة|لدي محكمة|رئيس المحكمة|المحكمة المختصة/, 'المخاطبة القضائية أو تحديد المحكمة'],
      [/صحيفة دعوي|مذكرة|عريضة|انذار|طعن|استئناف/, 'عنوان نوع المستند'],
      [/المدعي|المدعية|المدعي عليه|المدعي عليها|المستأنف|الطاعن|ضد/, 'بيان الخصوم وصفاتهم'],
      [/رقم الدعوي|رقم القضية|الدائرة|جلسة/, 'بيانات الدعوى أو الجلسة'],
      [/الموضوع|بشان موضوع|موضوع الطلب/, 'تحديد موضوع المستند'],
      [/مقدمة لسيادتكم|مقدم لسيادتكم|يتشرف|تتحصل الوقائع|الوقائع/, 'مدخل تمهيدي قبل عرض الوقائع']
    ];
    const observedPreamble: string[] = [];
    for (const line of nonEmptyLines.slice(0, 12)) {
      const normalizedLine = normalizeVaultText(line);
      if (line.length > 160) continue;
      const found = preambleLabels.find(([pattern]) => pattern.test(normalizedLine));
      if (found && !observedPreamble.includes(found[1])) observedPreamble.push(found[1]);
    }
    if (observedPreamble.length) {
      styleNotes.push(`بنية الديباجة المستخلصة دون أسماء أو بيانات قضية قديمة: ${observedPreamble.join(' ← ')}`);
    }

    const sectionLabels: Array<[RegExp, string]> = [
      [/^(?:محكمة|لدى محكمة|السيد الأستاذ|إلى السيد|الى السيد|السيد رئيس)/, 'ترويسة أو مخاطبة رسمية'],
      [/^(?:الموضوع|بشأن موضوع|موضوع الطلب)/, 'عرض موضوع المستند'],
      [/^(?:الوقائع|وقائع الدعوى|موجز الوقائع|تتحصل الوقائع)/, 'عرض الوقائع'],
      [/^(?:الدفاع|أوجه الدفاع|الدفوع|الأسباب|أسباب الطلب|من حيث)/, 'عرض الأسباب أو الدفوع'],
      [/^(?:الطلبات|الطلب الختامي|بناء عليه|لهذه الأسباب|لذلك|لما تقدم)/, 'الطلبات أو الخاتمة'],
      [/^(?:وتفضلوا|مقدمة لسيادتكم|مقدم لسيادتكم|وكيل|مع حفظ)/, 'خاتمة أو توقيع']
    ];
    const observedSections: string[] = [];
    for (const line of nonEmptyLines) {
      const normalizedLine = normalizeVaultText(line);
      if (line.length > 110) continue;
      const found = sectionLabels.find(([pattern]) => pattern.test(normalizedLine));
      if (found && !observedSections.includes(found[1])) observedSections.push(found[1]);
    }
    if (observedSections.length) {
      styleNotes.push(`التسلسل البنيوي العام المرصود في نموذج من النوع نفسه: ${observedSections.join(' ← ')}`);
    }

    const reasoningMarkers: Array<[RegExp, string]> = [
      [/(?:وقائع الدعوى|تتحصل الوقائع|بموجب|الثابت من الأوراق)/, 'عرض الواقعة أو مضمون المستند'],
      [/(?:المستند|المحرر|الدليل|الإقرار|الثابت بالأوراق)/, 'ربط الواقعة بدليلها'],
      [/(?:ولما كان|وحيث إن|عملاً بنص|مؤدى ذلك|القانون)/, 'بيان القاعدة أو التعليل القانوني'],
      [/(?:وإذ كان ذلك|لما كان الثابت|تأسيساً على|تطبيقاً لذلك)/, 'تطبيق التعليل على الواقعة'],
      [/(?:ومن ثم|مما يتعين معه|الأمر الذي|بناء عليه|لهذه الأسباب)/, 'استخلاص النتيجة أو الطلب']
    ];
    const reasoningOrder = reasoningMarkers
      .map(([pattern, label]) => ({ label, index: text.search(pattern) }))
      .filter((item) => item.index >= 0)
      .sort((a, b) => a.index - b.index)
      .map((item) => item.label);
    if (reasoningOrder.length >= 3) {
      styleNotes.push(`تسلسل الاستدلال المستخلص من ترتيب النموذج: ${[...new Set(reasoningOrder)].join(' ← ')}`);
    }
  }

  return styleNotes.join('\n- ');
}

function inferSafeModelType(model: LawModelItem): string {
  // Mirror modelTypeLabels(): uploaded file title/filename first, then its
  // opening heading. Do not let stale metadata override the actual document.
  if (model.source === 'uploaded') {
    const titleType = inferExplicitDocumentType(`${model.title || ''} ${model.fileName || ''}`);
    if (titleType) return titleType;
    const openingText = String(model.content || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 14).join(' ');
    const headingType = inferExplicitDocumentType(openingText);
    if (headingType) return headingType;
  }
  const explicitWorkType = inferExplicitDocumentType(String(model.judicialWorkType || ''));
  if (explicitWorkType) return explicitWorkType;
  const knownTypes = new Set([
    'مذكرة', 'صحيفة دعوى', 'تفنيد مستندات', 'اعلان', 'اعلان قضائي',
    'اعادة اعلان', 'انذار', 'طعن بالنقض', 'استئناف'
  ]);
  for (const label of [model.judicialWorkType, model.category]) {
    const normalized = canonicalDocumentType(String(label || ''));
    if (knownTypes.has(normalized)) return normalized;
  }
  return 'مستند قضائي محفوظ';
}

/**
 * Create a structural blueprint from a private vault model. The source document
 * itself is never sent to the model: this keeps case facts, party identities,
 * dates, case numbers, legal citations and old requests out of the new prompt.
 */
function buildSanitizedJudicialBlueprint(content: string, documentType: string): string {
  const raw = String(content || '').replace(/\r/g, '\n').trim();
  if (!raw) return 'النموذج المرجعي لا يحتوي نصاً قابلاً لاستخلاص بنية منه.';

  let lines = raw.split(/\n+/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (lines.length < 4) {
    // Extraction from some Word/PDF files can flatten paragraphs into one line.
    lines = raw
      .replace(/\s+(?=(?:محكمة|لدى محكمة|مذكرة|صحيفة|الوقائع|أوجه الدفاع|الطلبات|بناء عليه|لهذه الأسباب|أولاً|ثانياً|ثالثاً|رابعاً)\b)/g, '\n')
      .split(/\n+/).map((line) => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
  }

  const elements: Array<{ index: number; label: string }> = [];
  const add = (index: number, label: string, allowRepeat = false) => {
    if (allowRepeat || !elements.some((item) => item.label === label)) elements.push({ index, label });
  }
  const safeHeadings: Array<[RegExp, string]> = [
    [/^(?:الموضوع|موضوع الطلب|بشأن موضوع)\s*[:：]?$/i, 'عنوان الموضوع'],
    [/^(?:الوقائع|وقائع الدعوى|موجز الوقائع|تتحصل الوقائع)\s*[:：]?$/i, 'قسم عرض الوقائع'],
    [/^(?:الدفاع|أوجه الدفاع|الدفوع|أسباب الدفاع)\s*[:：]?$/i, 'قسم أوجه الدفاع والدفوع'],
    [/^(?:الأسباب|أسباب الطعن|أسباب الاستئناف)\s*[:：]?$/i, 'قسم الأسباب بحسب نوع المستند'],
    [/^(?:الطلبات|الطلبات الختامية|الطلب الختامي)\s*[:：]?$/i, 'قسم الطلبات الختامية'],
    [/^(?:بناء\s*عليه|لهذه\s*الأسباب|لذلك|لما\s*تقدم)\s*[:：]?$/i, 'صيغة الانتقال إلى الطلبات الختامية'],
    [/^(?:الخاتمة|ختاماً|وتفضلوا بقبول|مع حفظ كافة الحقوق)\s*[:：]?$/i, 'الخاتمة أو التوقيع'],
    [/^(?:المرفقات|حافظة المستندات|المستندات المقدمة)\s*[:：]?$/i, 'قسم المرفقات إذا كان من نوع العمل الحالي'],
  ];
  const orderRules: Array<[RegExp, string]> = [
    [/^(?:محكمة|لدى محكمة|أمام محكمة|مجلس الدولة|محكمة النقض|الدائرة)/, 'افتتاح يحدد جهة القضاء أو المحكمة والدائرة'],
    [/^(?:مذكرة|صحيفة|عريضة|إنذار|اعلان|إعلان|طعن|استئناف)/, 'عنوان يوضح نوع المستند المطلوب'],
    [/^(?:مقدم|مقدمة|المقدم|المقدمة|المدعي|المدعية|المستأنف|الطاعن|الخصم|ضد|في الدعوى|رقم الدعوى|جلسة)/, 'بيان أطراف الدعوى وصفاتهم وبياناتها في الموضع نفسه من المرجع'],
    [/^(?:يتشرف|نتشرف|أتشرف|نتقدم|مقدمة لسيادتكم|مقدم لسيادتكم|يعرض الآتي)/, 'مدخل افتتاحي رسمي موجز قبل صلب الموضوع'],
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const normalized = normalizeVaultText(line);
    if (!normalized) continue;
    if (i < 16) {
      for (const [pattern, label] of orderRules) {
        if (pattern.test(normalized)) { add(i, label); break; }
      }
    }

    const exactHeading = safeHeadings.find(([pattern]) => pattern.test(normalized));
    if (exactHeading) {
      add(i, exactHeading[1]);
      continue;
    }

    // Preserve the place/numbering of argument headings but never the old
    // heading text, because it may state a defence that does not fit this case.
    const numberedHeading = line.match(/^(أولاً|اولا|ثانياً|ثانيا|ثالثاً|ثالثا|رابعاً|رابعا|خامساً|خامسا|سادساً|سادسا|سابعاً|سابعا|ثامناً|ثامنا|[0-9٠-٩]+\s*[).ـ-])\s*[:：]?/);
    if (numberedHeading) add(i, `عنوان فرعي مرقم (${numberedHeading[1]})؛ يُنشأ عنوانه من دفوع القضية الحالية`, true);
    else if (/^(?:الدفع|السبب|وجه الدفاع|الوجه الأول|الوجه الثاني)\b/.test(normalized) && line.length <= 120) {
      add(i, 'عنوان دفع أو سبب يُعاد بناؤه حصراً من وقائع القضية الحالية');
    }
  }

  const connectorPhrases = [
    'وحيث إن', 'ولما كان', 'ولما كان الثابت', 'وإذ كان ذلك',
    'تأسيساً على', 'تطبيقاً لذلك', 'ومؤدى ذلك', 'ولا ينال من ذلك',
    'ومن ثم', 'الأمر الذي', 'مما يتعين معه', 'بناء عليه', 'لهذه الأسباب'
  ];
  const orderedConnectors = connectorPhrases
    .map((phrase) => ({ phrase, index: normalizeVaultText(raw).indexOf(normalizeVaultText(phrase)) }))
    .filter((item) => item.index >= 0)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.phrase)
    .filter((phrase, index, list) => list.indexOf(phrase) === index)
    .slice(0, 8);

  const structure = elements.sort((a, b) => a.index - b.index).map((item, index) => `${index + 1}. ${item.label}`);
  const profile = deriveStyleProfile(raw, true);
  // Reconstruct the document's paragraph rhythm as slots. Only safe generic
  // headings and stock transition phrases survive; substantive paragraphs are
  // replaced locally before any context is sent to the generator.
  const blocks = raw.split(/\n\s*\n+/).map((block) => block.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const sourceBlocks = blocks.length >= 3 ? blocks : lines;
  const transitionStarts = [
    'ولما كان الثابت', 'وحيث إن', 'ولما كان', 'وإذ كان ذلك', 'تأسيساً على',
    'تطبيقا لذلك', 'تطبيقاً لذلك', 'ومؤدى ذلك', 'ولا ينال من ذلك',
    'ومن ثم', 'الأمر الذي', 'مما يتعين معه', 'بناء عليه', 'لهذه الأسباب', 'لذلك'
  ];
  const slotRows: string[] = [];
  for (const block of sourceBlocks.slice(0, 24)) {
    const normalizedBlock = normalizeVaultText(block);
    if (!normalizedBlock) continue;
    const safeHeading = safeHeadings.find(([pattern]) => pattern.test(normalizedBlock));
    if (safeHeading) {
      slotRows.push(`عنوان/قسم: ${safeHeading[1]}`);
      continue;
    }
    const numberPrefix = block.match(/^(أولاً|اولا|ثانياً|ثانيا|ثالثاً|ثالثا|رابعاً|رابعا|خامساً|خامسا|سادساً|سادسا|سابعاً|سابعا|ثامناً|ثامنا|[0-9٠-٩]+\s*[).ـ-])/);
    if (numberPrefix) {
      slotRows.push(`عنوان دفع مرقم (${numberPrefix[1]}): [عنوان جديد يُستمد من القضية الحالية]`);
      continue;
    }
    if (/^(?:محكمة|لدى محكمة|أمام محكمة|مجلس الدولة|الدائرة)/.test(normalizedBlock)) {
      slotRows.push('[بيان المحكمة/الدائرة الجديدة في موضع الصدارة نفسه]');
      continue;
    }
    if (/^(?:مذكرة|صحيفة|عريضة|إنذار|اعلان|إعلان|طعن|استئناف)/.test(normalizedBlock) && block.length <= 130) {
      slotRows.push('[عنوان المستند الحالي الملائم للمهمة، في موضع العنوان المرجعي]');
      continue;
    }
    if (/^(?:رقم الدعوى|في الدعوى|جلسة|الدعوى رقم)/.test(normalizedBlock)) {
      slotRows.push('[بيانات رقم الدعوى/الجلسة الحالية فقط، إن وردت في المدخلات]');
      continue;
    }
    if (/^(?:مقدم من|مقدمة من|المقدم من|المقدمة من|المدعي|المدعية|المستأنف|الطاعن)/.test(normalizedBlock)) {
      slotRows.push('مقدم من: [اسم وصفة الموكل الحاليان، من بيانات القضية الحالية فقط]');
      continue;
    }
    if (/^ضد/.test(normalizedBlock)) {
      slotRows.push('ضد: [اسم وصفة الخصم الحاليان، من بيانات القضية الحالية فقط]');
      continue;
    }
    if (/^(?:يتشرف|نتشرف|أتشرف|مقدمة لسيادتكم|مقدم لسيادتكم|يعرض الآتي|أما بعد)/.test(normalizedBlock)) {
      if (/^(?:يتشرف|نتشرف|أتشرف)/.test(normalizedBlock)) slotRows.push('يتشرف [صاحب الصفة الحالية أو وكيله] بعرض الآتي: [مضمون جديد من وقائع القضية الحالية]');
      else if (/^(?:مقدمة لسيادتكم|مقدم لسيادتكم)/.test(normalizedBlock)) slotRows.push('مقدمة لسيادتكم من [صفة الموكل الحالية] بشأن [موضوع القضية الحالية]');
      else if (/^أما بعد/.test(normalizedBlock)) slotRows.push('أما بعد،');
      else slotRows.push('[مدخل افتتاحي رسمي بصيغة المرجع، يُملأ بمعلومات القضية الحالية فقط]');
      continue;
    }
    const transition = transitionStarts.find((phrase) => normalizedBlock.startsWith(normalizeVaultText(phrase)));
    if (transition) {
      slotRows.push(`${transition} [يُبنى التعليل على وقائع وأدلة القضية الحالية فقط]`);
      continue;
    }
    if (/^(?:بناء عليه|لهذه الأسباب|لذلك|لما تقدم)/.test(normalizedBlock)) {
      slotRows.push('[صيغة الانتقال إلى الطلبات الختامية في هذا الموضع]');
      continue;
    }
    if (slotRows.length < 2) slotRows.push('[مدخل/بيان تمهيدي جديد من بيانات القضية الحالية]');
    else slotRows.push('[فقرة جديدة في الموضع المقابل من المرجع؛ يُعاد بناؤها من وقائع ودليل وتعليل القضية الحالية]');
  }
  // Keep a small set of the lawyer's actual rhetorical phrasing. The previous
  // blueprint reduced every substantive paragraph to a generic placeholder,
  // which preserved headings but erased the author's real drafting voice.
  // Select only formulaic/legal-transition paragraphs and exclude paragraphs
  // that appear to contain party details, case identifiers, dates, or amounts.
  const styleExemplars = sourceBlocks
    .map((block) => block.replace(/\s+/g, ' ').trim())
    .filter((block) => block.length >= 55 && block.length <= 700)
    .filter((block) => /(?:وحيث إن|ولما كان|ولما كان الثابت|وإذ كان|ومؤدى ذلك|ولا ينال من ذلك|ومن ثم|الأمر الذي|مما يتعين معه|تأسيساً على|تطبيقاً لذلك|على هدي ما تقدم|ومن المقرر|استقر قضاء|جرى قضاء)/.test(block))
    .filter((block) => !/(?:رقم الدعوى|رقم القضية|جلسة|بتاريخ|المستأنف|الطاعن|المدعي|المدعى عليه|مقدم من|مقدمة من|ضد\s|جنيه|دولار|\b20[0-9]{2}\b|[٠-٩]{2,}|[0-9]{2,})/i.test(block))
    .map((block) => block
      .replace(/(?:السيد|السيدة|الأستاذ|الأستاذة)\s*\/?.{2,45}?(?=،|؛|\s+(?:بصفته|بصفتها|ضد|عن|وحيث|ولما)|$)/g, '[بيانات شخصية محذوفة]')
      .replace(/(?:المدعي|المدعية|المدعى عليه|المدعى عليها|المستأنف|المستأنف ضده|الطاعن|المطعون ضده)\s*\/?.{0,45}?(?=،|؛|\s+(?:وحيث|ولما|وإذ|ومن ثم)|$)/g, '[صفة طرف بالقضية الحالية]')
      .slice(0, 520))
    .filter((block, index, list) => list.indexOf(block) === index)
    .slice(0, 5);

  const skeleton = [
    'قالب العمل المستخلص من النموذج المختار؛ هذه خريطة تعاقب الفقرات بعد استبدال النص الموضوعي القديم بمواضع جديدة:',
    ...(slotRows.length ? slotRows : ['[صدارة جديدة] ← [موضوع ووقائع القضية الحالية] ← [أسباب/دفوع مناسبة] ← [طلبات القضية الحالية]']),
    'اتبع ترتيب المواضع وعدد مجموعات الأقسام الظاهرة بقدر ملاءمتها للمهمة الحالية؛ لا تنسخ الجمل الموضوعية القديمة، ولا تكتفِ بوصف عام من نوع «استخدم عناوين مرقمة».',
    'عند اختلاف نوع العمل الجديد عن النموذج، لا تنقل قسمًا غير مناسب؛ استخدم السمات العامة فقط.'
  ];
  return [
    `نوع النموذج المرجعي المختار: ${documentType}.`,
    'خريطة البنية المستخلصة من ترتيب النموذج الفعلي (وليست نص القضية القديمة):',
    ...(structure.length ? structure : ['لم تُستخرج عناوين صريحة؛ استخدم ترتيب الأقسام الذي تقتضيه طبيعة المهمة الجديدة ولا تخترع بنية خاصة.']),
    ...skeleton,
    styleExemplars.length
      ? `نماذج تعبيرية منقحة من صياغة المحامي (للاقتداء باللغة والتركيب والانتقال فقط، لا لنقل الوقائع أو الحجج الخاصة بالقضية القديمة):\n${styleExemplars.map((sample, index) => `${index + 1}. ${sample}`).join('\n')}`
      : 'لم تتوفر فقرات تعبيرية آمنة كافية من المرجع؛ استخدم الانتقالات المرصودة والبنية دون اختلاق بصمة غير موجودة.',
    orderedConnectors.length ? `انتقالات أسلوبية ظهرت في المرجع: ${orderedConnectors.join('، ')}.` : '',
    `سمات الإيقاع والأسلوب: ${profile}`,
    'النماذج التعبيرية أعلاه مرجع للأسلوب والتركيب فقط؛ لا تنقل منها أسماء أو وقائع أو مستندات أو طلبات أو أرقاماً أو تواريخ أو دفوعاً موضوعية إلى القضية الحالية.'
  ].filter(Boolean).join('\n');
}

function isGenericJudicialTask(value: string): boolean {
  const text = normalizeVaultText(value);
  if (!text) return true;
  return /^(?:انشاء صيغه قانونيه|صيغه قانونيه|صياغه مستند|مهمه قانونيه اخري|مهمه قانونيه عامه|العمل القضائي|مهمه قانونيه)$/.test(text);
}

function buildPersonalReferenceText(content: string, maxChars = 18000): string {
  const text = String(content || '').replace(/\r\n?/g, '\n').trim();
  if (!text) return '';
  if (text.length <= maxChars) return text;

  // Preserve the actual opening, substantive middle, and closing of the
  // lawyer's own document. A generic description alone cannot reproduce the
  // lawyer's syntax, transitions, cadence, or drafting fingerprint.
  const openingLength = 6000;
  const middleLength = 8000;
  const closingLength = maxChars - openingLength - middleLength - 120;
  const middleStart = Math.max(openingLength, Math.floor((text.length - middleLength) / 2));
  const middleEnd = Math.min(text.length - closingLength, middleStart + middleLength);
  const opening = text.slice(0, openingLength);
  const middle = text.slice(middleStart, middleEnd);
  const closing = text.slice(-closingLength);
  return `${opening}\n[مقتطف محذوف من منتصف النموذج المرجعي للحفاظ على حد السياق]\n${middle}\n[مقتطف محذوف قبل خاتمة النموذج المرجعي]\n${closing}`;
}

export function getLawyerStyleContext( searchCriteria?: { courtType?: string; briefType?: string; judicialWorkType?: string; factsOrSubject?: string; } | string, userId?: string ): string {
  let criteria: { courtType?: string; briefType?: string; judicialWorkType?: string; factsOrSubject?: string } = {};
  if (typeof searchCriteria === 'string') criteria = { courtType: searchCriteria };
  else if (searchCriteria) criteria = searchCriteria;

  const models = findSimilarModels(criteria, userId).filter((model) => String(model.content || '').trim().length > 100);
  const requestedType = String(criteria.judicialWorkType || criteria.briefType || '').trim();
  const compatibleModels = requestedType
    ? models.filter((model) => modelMatchesRequestedType(model, requestedType))
    : [];

  // Always use one real model from this account's vault. Prefer a model of the
  // requested document type; if none exists, use the closest personal model as
  // a style exemplar and adapt its structure to the requested task. Never
  // silently fall back to a generic/system template.
  const selectedModel = compatibleModels[0] || models[0];
  if (!selectedModel) {
    return '[لا توجد نماذج شخصية محفوظة وصالحة في خزنة هذا الحساب. لا تُنشئ المستند بقالب عام؛ أوقف الصياغة واطلب من المستخدم حفظ نموذج شخصي أولاً.]';
  }

  const documentType = inferSafeModelType(selectedModel);
  const exactTypeMatch = compatibleModels.length > 0;
  const referenceText = buildPersonalReferenceText(selectedModel.content);
  if (!referenceText) {
    return '[لا يوجد نص صالح في النموذج الشخصي المختار. لا تستخدم قالباً عاماً؛ اطلب نموذجاً آخر من خزنة الحساب.]';
  }

  const typeLine = requestedType
    ? `نوع المستند المطلوب: ${requestedType}.`
    : 'يُستنتج نوع المستند المطلوب من بيانات المهمة الحالية.';
  const matchLine = exactTypeMatch
    ? 'النموذج المرجعي متوافق مع نوع المستند المطلوب؛ اقتدِ ببنيته وترتيبه ما دام مناسباً للمهمة.'
    : `لم يوجد نموذج من النوع نفسه؛ النموذج الشخصي الأقرب في خزنة الحساب هو «${documentType}». خذ منه بصمة الكتابة والديباجة والانتقالات والإيقاع، واستعر ترتيب الأقسام فقط بقدر ملاءمته لنوع المستند المطلوب، ولا تستبدل نوع المستند الجديد بنوع المرجع.`;

  return `[خزانة المحامي الشخصية — المرجع الأساسي والإلزامي للصياغة]
${typeLine}
${matchLine}
[معلومات المرجع]
- نوع النموذج: ${documentType}
- المصدر: مستند حقيقي محفوظ في خزنة هذا الحساب فقط.
- الأولوية: هذا النص المرجعي الشخصي أعلى من أي قالب عام أو أسلوب افتراضي.

[النص الأصلي للنموذج الشخصي — اقرأه كاملاً بوصفه مرجع أسلوب وبناء]
<LAWYER_VAULT_REFERENCE>
${referenceText}
</LAWYER_VAULT_REFERENCE>

[تعليمات إلزامية لاستخدام المرجع]
1) لا تكتب من قالب قانوني عام ولا تكتفِ بوصف نظري للأسلوب. اقتدِ فعلياً بطريقة المحامي الظاهرة في النص: الديباجة، صياغة الجمل، تراكيب الربط، ترتيب عرض الوقائع، طريقة بناء الفقرة والحجة، الانتقال من واقعة إلى دليل ثم إلى أثرها، تسلسل الدفوع، العناوين، الخاتمة والطلبات.
2) اجعل الناتج يبدو مكتوباً بالطريقة نفسها التي كُتب بها النموذج المرجعي، مع إعادة بناء المضمون بالكامل على القضية الحالية. لا تنسخ فقرة موضوعية من المرجع لمجرد أنها تبدو مناسبة.
3) ممنوع نقل أي واقعة أو اسم طرف أو صفة أو عنوان أو رقم قضية أو تاريخ أو مبلغ أو مستند أو طلب أو دفع موضوعي أو مادة قانونية أو حكم أو رقم طعن خاص بالقضية القديمة. هذه البيانات لا تُستخدم إطلاقاً في المستند الجديد.
4) استمد بيانات القضية الجديدة حصراً من مدخلات المستخدم ومستنداته الحالية. إذا كانت بيانات الطرف أو المحكمة أو التاريخ غير متاحة، فلا تملأها من النموذج القديم ولا تضع بدلاً منها نجومًا أو حقولاً وهمية.
5) حافظ على الترويسة والديباجة والتوقيع فقط بالقدر الذي تسمح به بيانات القضية الحالية؛ انقل الصيغة المهنية العامة للمحامي من المرجع، لكن استبدل بيانات الأشخاص والقضية القديمة ببيانات القضية الحالية أو احذف ما لا تتوفر له بيانات.
6) لا تستخدم قالباً عاماً بديلاً عند وجود نموذج شخصي في الخزنة. إذا لم توجد نماذج صالحة، لا تكتب المستند حتى يُضاف نموذج شخصي؛ أخبر المستخدم بذلك بوضوح.
7) لا تضع علامات Markdown مثل ** أو ## ولا تعليمات تحريرية داخل المستند النهائي. اكتب بالعربية القانونية، ولا تُدرج الإنجليزية إلا إذا كانت اسماً أو مصطلحاً ضرورياً في مستند القضية الحالية.
8) هذا السياق مخصص للصياغة والتفنيد والرد على المستندات وتحسين المسودات. لا يُستخدم في التكييف القانوني المستقل.`;
}
