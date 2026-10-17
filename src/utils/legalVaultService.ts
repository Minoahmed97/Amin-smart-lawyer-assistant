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
  if ((text.includes('صحيفة') || text.includes('عريضة')) && (text.includes('دعوى') || text.includes('افتتاح'))) return 'صحيفة دعوى';
  if (text.includes('تفنيد') || (!text.includes('مذكرة') && text.includes('رد') && text.includes('مستند'))) return 'تفنيد مستندات';
  if (text.includes('اعلان') && (text.includes('قضائي') || text.includes('رسمي'))) return 'اعلان قضائي';
  if (text.includes('اعلان')) return 'اعلان';
  if (text.includes('مذكرة')) return 'مذكرة';
  return text;
}

function modelTypeText(model: LawModelItem): string {
  return `${model.judicialWorkType || ''} ${model.category || ''} ${model.title || ''}`;
}

function modelMatchesRequestedType(model: LawModelItem, requestedType: string): boolean {
  const requested = canonicalDocumentType(requestedType);
  if (!requested) return false;

  // Match each metadata field independently. Do not inspect model.content or
  // case facts to choose a reference, because that can pull in another case's
  // document simply because its facts happen to be similar.
  const metadata = [model.judicialWorkType, model.title, model.category]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (metadata.some((value) => canonicalDocumentType(value) === requested)) return true;

  const normalizedRequested = normalizeVaultText(requestedType);
  const requestedTokens = new Set(normalizedRequested.split(/\s+/).filter((token) => token.length >= 3));
  if (!requestedTokens.size) return false;

  // For custom document names, use metadata-token overlap only. The body of
  // the old legal document is deliberately excluded from type matching.
  const bestOverlap = metadata.reduce((best, value) => {
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
    const sectionLabels: Array<[RegExp, string]> = [
      [/^(?:محكمة|لدى محكمة|السيد الأستاذ|إلى السيد|الى السيد|السيد رئيس)/, 'ترويسة أو مخاطبة رسمية'],
      [/^(?:الموضوع|بشأن موضوع|موضوع الطلب)/, 'عرض موضوع المستند'],
      [/^(?:الوقائع|وقائع الدعوى|موجز الوقائع|تتحصل الوقائع)/, 'عرض الوقائع'],
      [/^(?:الدفاع|أوجه الدفاع|الدفوع|الأسباب|أسباب الطلب|من حيث)/, 'عرض الأسباب أو الدفوع'],
      [/^(?:الطلبات|الطلب الختامي|بناء عليه|لهذه الأسباب|لذلك|لما تقدم)/, 'الطلبات أو الخاتمة'],
      [/^(?:وتفضلوا|مقدمه لسيادتكم|وكيل|مع حفظ)/, 'خاتمة أو توقيع']
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
  }

  // Preserve the lawyer's recognizable drafting fingerprint without sending
  // the source document or case-specific material to the generation server.
  const hasArabicIndicDigits = /[٠-٩]/.test(text);
  const hasWesternDigits = /[0-9]/.test(text);
  const usesSemicolons = /[؛;]/.test(text);
  const usesArabicComma = /،/.test(text);
  const usesParentheses = /[()（）]/.test(text);
  styleNotes.push(`نمط الأرقام: ${hasArabicIndicDigits && hasWesternDigits ? 'يمزج الأرقام العربية والهندية والغربية بحسب السياق' : hasArabicIndicDigits ? 'يميل إلى الأرقام الهندية (٠١٢٣)' : hasWesternDigits ? 'يميل إلى الأرقام الغربية (0123)' : 'لا توجد أرقام كافية للرصد'}`);
  styleNotes.push(`علامات الترقيم: ${[usesArabicComma ? 'الفاصلة العربية' : '', usesSemicolons ? 'الفاصلة المنقوطة' : '', usesParentheses ? 'الأقواس التفسيرية' : ''].filter(Boolean).join('، ') || 'ترقيم محدود أو غير كافٍ للرصد'}`);
  const formalPhrases = [
    'وحيث إن', 'وحيث أن', 'ولما كان', 'ولما كان الثابت', 'وحيث إنه',
    'ومن جماع ما تقدم', 'وهدياً بما تقدم', 'الأمر الذي', 'مما مؤداه',
    'وإذ كان ذلك', 'ولا ينال من ذلك', 'فضلاً عن', 'تأسيساً على ما تقدم',
    'بناءً عليه', 'لذلك', 'لهذه الأسباب'
  ];
  const observedPhrases = formalPhrases
    .map((phrase) => ({ phrase, count: countPhrase(text, phrase) }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
    .map((item) => item.phrase);
  if (observedPhrases.length) styleNotes.push(`تعبيرات قانونية مفضلة مرصودة في النماذج: ${observedPhrases.join('، ')}`);

  return styleNotes.join('\n- ');
}

function deriveOfficeIdentity(models: LawModelItem[]): string[] {
  const excludedOfficeLabels = /(?:مكتب العمل|مكتب التوثيق|مكتب الشهر العقاري|مكتب الخبراء|مكتب التنفيذ|مكتب المحضرين|مكتب السجل التجاري|مكتب الضرائب|مكتب محكمة|مكتب النيابة|مكتب قلم|مكتب إدارة|مكتب اداره)/u;
  const identities: string[] = [];
  // Include only explicit office-name lines, never surrounding lines that may
  // contain a client's name, court, case number, date, or case-specific facts.
  for (const model of models) {
    const lines = String(model.content || '').replace(/\r/g, '').split('\n');
    for (const rawLine of lines) {
      const line = rawLine.trim().replace(/^[•*ـ\-]+\s*/, '');
      if (line.length < 8 || line.length > 100 || !/^مكتب\s+/u.test(line)) continue;
      if (excludedOfficeLabels.test(line.replace(/[：:]$/, '').trim())) continue;
      // A clearly named office line can be as simple as "مكتب فلان الفلاني";
      // do not require the line to literally contain the word "محاماة".
      const officeWords = line.split(/\s+/).filter(Boolean);
      if (officeWords.length < 3) continue;
      if (!identities.includes(line)) identities.push(line);
      if (identities.length >= 2) return identities;
    }
  }
  return identities;
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

  // Send only a locally extracted style profile plus an explicit office-name
  // line, if the lawyer has actually saved one in this account's own vault.
  // Full templates and case-specific text are never included in this context.
  const allAccountModels = getAllLawModels(userId);
  const officeIdentity = deriveOfficeIdentity(allAccountModels);
  if (!selectedModels.length && !officeIdentity.length) {
    return `[خزانة المحامي والقوالب الأسلوبية — سياق إلزامي للمهمة الحالية]\n[لا توجد نماذج شخصية محفوظة في خزنة هذا الحساب. لا تنشئ بصمة أو هوية مكتبية وهمية؛ استخدم فقط بيانات المستند الحالي.]`;
  }

  const typeLine = requestedType
    ? `نوع المستند المطلوب حاليًا: ${requestedType}.`
    : 'نوع المستند المطلوب يحدده طلب المستخدم الحالي.';
  const identityBlock = officeIdentity.length
    ? `[هوية المكتب المعتمدة — مسموح بإدراجها كما هي عند الحاجة إلى ترويسة أو توقيع]\n${officeIdentity.join('\n')}`
    : '[هوية المكتب المعتمدة: لم يُعثر على سطر واضح لاسم المكتب في نماذج هذا الحساب؛ لا تخترع اسماً أو ترويسة.]';
  return `[خزانة المحامي والقوالب الأسلوبية — سياق إلزامي للمهمة الحالية]\n${typeLine}\n[بصمة أسلوب المحامي]\nاستُخلصت السمات التالية محلياً من نماذج هذا الحساب؛ لم يُرسل نص النماذج الأصلية. طبّق السمات فعلياً في الصياغة، ولا تكتفِ بكتابة قانونية عامة.\n${profileBlocks.join('\n\n')}\n\n${identityBlock}\n\n[حدود إلزامية]\n1) اكتب المستند الحالي كاملاً اعتماداً على وقائع الطلب الحالي ومستنداته وبياناته فقط.\n2) لا تنقل من النماذج القديمة أي وقائع أو أسماء أطراف أو تواريخ أو أرقام قضايا أو مستندات أو طلبات أو دفوع أو مواد أو أحكام قانونية.\n3) لا تُرسل أو تقتبس نصوص النماذج الأصلية؛ سطر هوية المكتب المميز أعلاه هو الاستثناء الوحيد المسموح بنقله حرفياً، لأنه مخصص لهوية المكتب وليس لوقائع قضية.\n4) استخدم بنية نموذج من النوع نفسه فقط إذا كان النوع موجوداً في خزنة هذا الحساب؛ وإلا طبّق السمات العامة دون فرض هيكل مستند مختلف.\n5) نوع المستند الحالي ووقائعه وتعليمات المستخدم الحالية لها الأولوية، ولا تغيّر نوعه.\n6) إذا وُجدت هوية المكتب المعتمدة أعلاه وكانت مناسبة للمستند، فأدرجها في موضعها الطبيعي كترويسة أو توقيع بحسب نماذج المكتب؛ لا تكررها بلا داعٍ ولا تخترع بيانات تواصل أو عناوين.\n7) اجعل بصمة المحامي واضحة في ترتيب الأفكار، وتدرج الحجج، وطول الجمل، والروابط التعبيرية، وعناوين الأقسام، وعلامات الترقيم، ونمط الخاتمة، مع بقاء مضمون القضية الحالية مستقلاً تماماً عن القضايا السابقة.`;
}
