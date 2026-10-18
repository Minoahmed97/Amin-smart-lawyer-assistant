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

  return styleNotes.join('\n- ');
}

function legalFamily(value: string): string {
  const text = normalizeVaultText(value);
  if (!text) return '';
  if (/(مجلس الدوله|محكمه القضاء الاداري|المحكمه الاداريه العليا|القضاء الاداري|دعوي الغاء|دعوى الغاء|قرار اداري|موظف عام|تاديبي|تأديبي)/.test(text)) return 'مجلس الدولة والقضاء الإداري';
  if (/(جنائي|جنايه|جنحه|نيابه عامه|عقوبه|حبس|متهم|مخدرات|سرقه|تزوير)/.test(text)) return 'جنائي';
  if (/(اسره|احوال شخصيه|طلاق|خلع|نفقه|حضانة|حضانة|رؤيه|رؤية|ميراث)/.test(text)) return 'أحوال شخصية';
  if (/(عمالي|عامل|عمال|فصل تعسفي|اجور|أجور|تأمينات اجتماعيه)/.test(text)) return 'عمالي';
  if (/(تجاري|شركات|افلاس|إفلاس|شيك|تاجر)/.test(text)) return 'تجاري';
  if (/(مدني|تعويض|مسؤوليه مدنيه|مسئوليه مدنيه|ملكيه|ملكية|صحه توقيع|صحة توقيع|فسخ عقد|مطالبه)/.test(text)) return 'مدني';
  return '';
}

function documentFamily(value: string): string {
  const text = canonicalDocumentType(value);
  if (!text) return '';
  if (text.includes('صحيفة دعوى') || text.includes('عريضة')) return 'عريضة أو صحيفة افتتاحية';
  if (text.includes('مذكرة')) return 'مذكرة';
  if (text.includes('تفنيد')) return 'رد أو تفنيد';
  if (text.includes('انذار')) return 'إنذار';
  if (text.includes('اعلان')) return 'إعلان';
  return text;
}

export function getLawyerStyleContext( searchCriteria?: { courtType?: string; briefType?: string; judicialWorkType?: string; factsOrSubject?: string; } | string, userId?: string ): string {
  let criteria: { courtType?: string; briefType?: string; judicialWorkType?: string; factsOrSubject?: string } = {};
  if (typeof searchCriteria === 'string') criteria = { courtType: searchCriteria };
  else if (searchCriteria) criteria = searchCriteria;

  const models = getAllLawModels(userId);
  const requestedType = criteria.judicialWorkType || criteria.briefType || '';
  const requestedDocFamily = documentFamily(requestedType);
  const requestedLegalFamily = legalFamily(`${criteria.courtType || ''} ${requestedType} ${criteria.factsOrSubject || ''}`);
  if (!models.length) {
    return `[بصمة أسلوب المحامي — سياق للمهمة الحالية]\n[لا توجد نماذج شخصية محفوظة في خزنة هذا الحساب. لا تدّعِ استخدام أسلوب مرجعي؛ اكتب وفق المعلومات الحالية فقط.]`;
  }

  // Rank references in the order the lawyer requested: document type first,
  // legal/court family second, then related metadata. Never choose a model just
  // because it exists; unrelated legal families receive a strong penalty.
  const ranked = models.map((model, index) => {
    const meta = `${model.judicialWorkType || ''} ${model.title || ''} ${model.category || ''} ${model.notes || ''}`;
    const modelDocFamily = documentFamily(`${model.judicialWorkType || ''} ${model.title || ''} ${model.category || ''}`);
    const modelLegalFamily = legalFamily(`${meta} ${model.content || ''}`.slice(0, 5000));
    let score = (model.weight || 3) * 2;
    if (requestedDocFamily && modelDocFamily === requestedDocFamily) score += 100;
    else if (requestedDocFamily && modelDocFamily && modelDocFamily !== requestedDocFamily) score -= 8;
    if (requestedLegalFamily && modelLegalFamily === requestedLegalFamily) score += 75;
    else if (requestedLegalFamily && modelLegalFamily && modelLegalFamily !== requestedLegalFamily) score -= 55;
    const normalizedCourt = normalizeVaultText(criteria.courtType || '');
    const normalizedMeta = normalizeVaultText(meta);
    if (normalizedCourt && normalizedMeta.includes(normalizedCourt)) score += 45;
    const requestedTokens = normalizeVaultText(`${criteria.courtType || ''} ${requestedType}`).split(/\s+/).filter(t => t.length >= 3);
    const modelTokens = new Set(normalizedMeta.split(/\s+/).filter(t => t.length >= 3));
    if (requestedTokens.length) {
      const overlap = requestedTokens.filter(t => modelTokens.has(t)).length / requestedTokens.length;
      score += Math.round(overlap * 25);
    }
    return { model, score, index, modelDocFamily, modelLegalFamily };
  }).sort((a, b) => b.score - a.score || a.index - b.index);

  const best = ranked[0];
  if (!best || !String(best.model.content || '').trim()) {
    return `[بصمة أسلوب المحامي — سياق للمهمة الحالية]\n[لا يوجد نموذج يحتوي على نص قابل للاستخدام في خزنة هذا الحساب. اكتب وفق المعلومات الحالية فقط.]`;
  }

  // Include the actual reference, not merely a statistical description of it.
  // Keep the reference bounded so it does not overwhelm the case materials.
  const selected = ranked.slice(0, 2).filter((item, index) => {
    if (index === 0) return true;
    const sameLegalFamily = !requestedLegalFamily || item.modelLegalFamily === requestedLegalFamily;
    const sameDocFamily = !requestedDocFamily || item.modelDocFamily === requestedDocFamily;
    return sameLegalFamily || sameDocFamily;
  });
  const remainingBudget = 21000;
  let used = 0;
  const referenceBlocks = selected.map((item, index) => {
    const content = String(item.model.content || '').trim();
    const allowance = Math.max(0, Math.min(index === 0 ? 12000 : 8000, remainingBudget - used));
    const excerpt = content.slice(0, allowance);
    used += excerpt.length;
    const metadata = [item.model.title, item.model.judicialWorkType, item.model.category].filter(Boolean).join(' — ');
    return `[النموذج المرجعي ${index + 1}${metadata ? `: ${metadata}` : ''}]\n${excerpt}${content.length > excerpt.length ? '\n[اقتُصر النص على جزء من النموذج بسبب حد السياق.]' : ''}`;
  }).filter(Boolean);

  const typeLine = requestedType ? `نوع المستند المطلوب: ${requestedType}.` : 'يُحدد نوع المستند من طلب المستخدم الحالي.';
  const familyLine = requestedLegalFamily ? `الفرع القانوني الأقرب: ${requestedLegalFamily}.` : 'حدّد الفرع القانوني من وقائع وطلبات القضية الحالية.';
  return `[بصمة أسلوب المحامي — مرجع فعلي من خزنة هذا الحساب]\n${typeLine}\n${familyLine}\nتم اختيار النموذج وفق أقرب نوع مستند وفرع قانوني وجهة قضاء متاحة. النصوص التالية مراجع أسلوب وبناء فعلية وليست وقائع للقضية الحالية.\n\n${referenceBlocks.join('\n\n')}\n\n[تعليمات استخدام المرجع]\n1) اقرأ النموذج المرجعي نفسه واستخلص منه طريقة المحامي الفعلية في الديباجة، والترويسة، وترتيب الأقسام، وعرض الوقائع، والانتقال إلى الدفوع، وطول الفقرات، والعبارات الانتقالية، وصياغة الطلبات والخاتمة. لا تكتفِ بوصف عام مثل طول الجمل.\n2) أنت مسؤول عن التحليل القانوني المستقل للقضية الجديدة: استخرج الدفوع والطلبات المناسبة من وقائعها ومستنداتها الحالية، ولا تستورد دفوع النموذج القديم لمجرد وجودها فيه.\n3) انقل عناصر هوية المكتب الثابتة والترويسة والتوقيع من المرجع عند وضوحها، مع تحديث أي بيانات مرتبطة بالقضية الحالية فقط إذا كانت معروفة. لا تخترع اسم مكتب أو محامٍ أو رقمًا أو تاريخًا.\n4) لا تنقل من المرجع أسماء أطراف القضية القديمة، أو وقائعها، أو تواريخها، أو أرقامها، أو مستنداتها، أو طلباتها الخاصة بها. إذا احتجت معلومة للقضية الجديدة ولم تكن موجودة في مدخلاتها، فلا تخترعها.\n5) إذا كان المرجع من النوع نفسه فاقتدِ ببنائه بدرجة قوية. وإذا كان من فرع قانوني قريب أو نوع غير مطابق، فاستفد من طريقة الكتابة والترويسة والبناء العام فقط، وعدّل هيكل المستند ليناسب نوع العمل القضائي المطلوب حاليًا.\n6) الأولوية: صحة التحليل القانوني للقضية الحالية، ثم محاكاة أسلوب المحامي وبنائه، دون نسخ مضمون القضية القديمة.\n7) إذا لم يوجد نموذج مطابق، لا ترفض الصياغة؛ استخدم أفضل نموذج قريب تم اختياره وفق نوع المستند والفرع القانوني وجهة القضاء.`;
}
