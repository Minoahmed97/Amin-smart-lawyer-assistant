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

export function getLawyerStyleContext( searchCriteria?: { courtType?: string; briefType?: string; judicialWorkType?: string; factsOrSubject?: string; } | string, userId?: string ): string {
  let criteria: { courtType?: string; briefType?: string; judicialWorkType?: string; factsOrSubject?: string } = {};
  if (typeof searchCriteria === 'string') criteria = { courtType: searchCriteria };
  else if (searchCriteria) criteria = searchCriteria;

  const similarModels = findSimilarModels(criteria, userId);
  const requestedType = criteria.judicialWorkType || criteria.briefType || '';
  const sameTypeModels = requestedType
    ? similarModels.filter((model) => modelMatchesRequestedType(model, requestedType))
    : [];

  // Only exact/compatible document types may influence structure. If the vault
  // has no model for this type, use general writing traits only—not another
  // document's section order, argument, wording, or substantive text.
  const selectedModels = (sameTypeModels.length ? sameTypeModels : similarModels).slice(0, 2);
  const hasSameTypeModel = sameTypeModels.length > 0;
  const profileBlocks = selectedModels.map((model, index) => {
    const includeStructure = hasSameTypeModel && modelMatchesRequestedType(model, requestedType);
    const documentType = (model.judicialWorkType || model.category || '').trim();
    return `[مرجع أسلوبي شخصي ${index + 1}${documentType ? ` — النوع: ${documentType}` : ''}]\n- ${deriveStyleProfile(model.content || '', includeStructure)}`;
  });

  // Crucially, never send an old document, excerpt, title, party name, case
  // number, date, request, defense, or legal citation to the drafting model.
  // Only locally derived style attributes are sent.
  if (!selectedModels.length) {
    return `[بصمة أسلوب المحامي — سياق للمهمة الحالية]\n[لا توجد نماذج شخصية محفوظة في خزنة هذا الحساب. لا تنشئ بصمة وهمية؛ استخدم فقط بيانات المستند الحالي.]`;
  }

  const typeLine = requestedType
    ? `نوع المستند المطلوب حاليًا: ${requestedType}.`
    : 'نوع المستند المطلوب يحدده طلب المستخدم الحالي.';
  return `[بصمة أسلوب مستخلصة من خزنة الحساب]\n${typeLine}\nالبيانات التالية وصف أسلوبي مجرد مستخلص محليًا من نماذج المحامي؛ لم يُرفق أي نص من المستندات الأصلية. طبّق الوصف فعلياً في الديباجة المحايدة، وترتيب الفقرات، وتسلسل عرض الواقعة والدليل والتعليل والتطبيق والنتيجة، وطول الجمل والروابط التعبيرية؛ ولا تستنسخ أي واقعة أو بيانات قديمة.\n${profileBlocks.join('\n\n')}\n\n[حدود إلزامية]\n1) اكتب المستند الحالي من بدايته إلى نهايته اعتمادًا على وقائع هذا الطلب ومستنداته وتعليمات المستخدم الحالية فقط.\n2) الخزنة ليست مصدرًا لوقائع أو مستندات أو أسماء أو تواريخ أو أرقام أو طلبات أو دفوع أو نصوص قانونية. لا تنقل منها أي مضمون أو عبارة مميزة مرتبطة بقضية سابقة.\n3) لا تقتبس أو تعيد صياغة أي جزء من مستند محفوظ؛ لا يتم إرسال نصوص النماذج إلى المولد أصلًا.\n4) طبّق بنية نموذج من النوع نفسه فقط إذا كان ذلك النوع موجودًا في خزنة هذا الحساب. إذا لم يوجد، خذ السمات العامة للكتابة ولا تفرض بنية مستند مختلف.\n5) نوع المستند الجديد وتعليمات المستخدم الحالية هما الحاكمان؛ لا تحوّل صحيفة دعوى إلى مذكرة، أو إنذارًا إلى إعادة إعلان، أو أي نوع إلى نوع آخر.\n6) لا تضف اسم المحامي أو مكتبه أو ترويسة أو بيانات تعريفية إلا إذا كانت مقدمة صراحةً ضمن بيانات المستند الحالي أو موجودة بالفعل في المسودة الحالية الجاري تحريرها.\n7) طبّق نمط الديباجة وتسلسل الاستدلال المستخلصين متى كانا متاحين، ثم طابق طول الجمل والروابط التعبيرية وأسلوب الانتقال. استبدل بيانات النموذج كلها ببيانات القضية الحالية، ولا تستنسخ أي واقعة أو مضمون قديم.`;
}
