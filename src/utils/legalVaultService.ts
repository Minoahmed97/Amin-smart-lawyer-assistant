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

type LawVaultSearchCriteria = {
  courtType?: string;
  briefType?: string;
  judicialWorkType?: string;
  factsOrSubject?: string;
};

const VAULT_TOPIC_STOP_WORDS = new Set([
  'من', 'في', 'على', 'الى', 'عن', 'مع', 'بين', 'لدى', 'امام', 'ان', 'كان', 'كانت', 'يكون', 'تكون',
  'التي', 'الذي', 'الذين', 'هذا', 'هذه', 'ذلك', 'تلك', 'هناك', 'حيث', 'لما', 'بما', 'مما', 'وقد',
  'كما', 'ثم', 'او', 'ولا', 'لا', 'لم', 'لن', 'ما', 'هو', 'هي', 'هم', 'نحن', 'انا', 'كل', 'بعض',
  'اي', 'حال', 'بشان', 'بموجب', 'طبقا', 'وفقا', 'بناء', 'عليه', 'عليها', 'اليه', 'منها', 'عنه',
  'لها', 'له', 'حتى', 'منذ', 'خلال', 'بعد', 'قبل', 'عند', 'دون', 'غير', 'كانوا', 'محكمه',
  'المحكمه', 'دعوي', 'الدعوي', 'قضيه', 'القضيه', 'نزاع', 'النزاع', 'قانون', 'قانوني', 'قانونيه',
  'قضائي', 'قضائيه', 'مستند', 'المستند', 'مذكره', 'دفاع', 'طلب', 'الطلب', 'المدعي', 'المدعى',
  'الخصم', 'الموكل', 'محامي', 'المحامي', 'طرف', 'اطراف', 'الاطراف', 'الاوراق', 'اوراق', 'وقائع',
  'الوقائع', 'موضوع', 'الموضوع', 'المطلوب', 'المهمة', 'مهمه', 'العمل', 'صياغه', 'صيغه', 'مستندات',
]);

function topicTokens(value: string): Set<string> {
  const tokens = normalizeVaultText(value)
    .split(' ')
    .filter((token) => token.length >= 3 && !VAULT_TOPIC_STOP_WORDS.has(token));
  // Use the whole bounded text sample; an early-token cutoff can miss the
  // decisive subject matter that appears later in a long pleading.
  return new Set(tokens);
}

function rankVaultModels(models: LawModelItem[], criteria: LawVaultSearchCriteria): Array<{ model: LawModelItem; score: number; index: number; modelDocFamily: string; modelLegalFamily: string }> {
  const requestedType = criteria.judicialWorkType || criteria.briefType || '';
  const requestedDocFamily = documentFamily(requestedType);
  const requestedLegalFamily = legalFamily(`${criteria.courtType || ''} ${requestedType} ${criteria.factsOrSubject || ''}`);
  const normalizedCourt = normalizeVaultText(criteria.courtType || '');
  const courtTokens = topicTokens(criteria.courtType || '');
  const requestedTokens = topicTokens(String(criteria.factsOrSubject || '').slice(0, 16000));

  // Compare every saved model against the current matter. Topic overlap is
  // deliberately the strongest signal; court, legal branch, and work type are
  // secondary signals, while saved weight is only a final tie-breaker.
  const modelTokens = models.map((model) => topicTokens(
    `${model.title || ''} ${model.category || ''} ${model.judicialWorkType || ''} ${model.notes || ''} ${String(model.content || '').slice(0, 24000)}`,
  ));
  const documentFrequency = new Map<string, number>();
  modelTokens.forEach((tokens) => tokens.forEach((token) => documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1)));
  const tokenWeight = (token: string) => 1 + Math.log((models.length + 1) / ((documentFrequency.get(token) || 0) + 1));
  const totalTopicWeight = [...requestedTokens].reduce((sum, token) => sum + tokenWeight(token), 0);

  return models.map((model, index) => {
    const meta = `${model.judicialWorkType || ''} ${model.title || ''} ${model.category || ''} ${model.notes || ''}`;
    const normalizedMeta = normalizeVaultText(meta);
    const normalizedContent = normalizeVaultText(String(model.content || '').slice(0, 12000));
    const modelMetaTokens = topicTokens(meta);
    const modelLegalFamily = legalFamily(`${meta} ${String(model.content || '').slice(0, 5000)}`);
    const modelDocFamily = documentFamily(`${model.judicialWorkType || ''} ${model.title || ''} ${model.category || ''}`);
    let score = 0;

    if (totalTopicWeight > 0) {
      const matchedTopicWeight = [...requestedTokens]
        .filter((token) => modelTokens[index].has(token))
        .reduce((sum, token) => sum + tokenWeight(token), 0);
      score += Math.round((matchedTopicWeight / totalTopicWeight) * 260);

      const matchedMetadataWeight = [...requestedTokens]
        .filter((token) => modelMetaTokens.has(token))
        .reduce((sum, token) => sum + tokenWeight(token), 0);
      score += Math.round((matchedMetadataWeight / totalTopicWeight) * 18);
    }

    if (normalizedCourt) {
      if (normalizedMeta.includes(normalizedCourt) || normalizedContent.includes(normalizedCourt)) {
        score += 30;
      } else if (courtTokens.size) {
        const courtOverlap = [...courtTokens].filter((token) => modelTokens[index].has(token)).length / courtTokens.size;
        if (courtOverlap >= 0.6) score += 21;
        else if (courtOverlap >= 0.35) score += 9;
      }
    }

    if (requestedLegalFamily) {
      if (modelLegalFamily === requestedLegalFamily) score += 22;
      else if (modelLegalFamily && modelLegalFamily !== requestedLegalFamily) score -= 18;
    }

    if (requestedDocFamily) {
      if (modelDocFamily === requestedDocFamily) score += 18;
      else if (modelDocFamily && modelDocFamily !== requestedDocFamily) score -= 4;
      if (modelMatchesRequestedType(model, requestedType)) score += 16;
    } else if (requestedType) {
      const requestedTypeTokens = topicTokens(requestedType);
      if ([...requestedTypeTokens].some((token) => modelMetaTokens.has(token))) score += 16;
    }

    // Weight is a small tie-breaker only. It must never override a much closer
    // case subject, court, or judicial-work type.
    score += Math.max(1, Math.min(5, Number(model.weight) || 3));
    return { model, score, index, modelDocFamily, modelLegalFamily };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
}

export function findSimilarModels(criteria: LawVaultSearchCriteria, userId?: string): LawModelItem[] {
  const models = getAllLawModels(userId).filter((model) => String(model.content || '').trim());
  return rankVaultModels(models, criteria).map((item) => item.model);
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

export function getLawyerStyleContext(searchCriteria?: LawVaultSearchCriteria | string, userId?: string): string {
  let criteria: LawVaultSearchCriteria = {};
  if (typeof searchCriteria === 'string') criteria = { courtType: searchCriteria };
  else if (searchCriteria) criteria = searchCriteria;

  const models = getAllLawModels(userId).filter((model) => String(model.content || '').trim());
  const requestedType = criteria.judicialWorkType || criteria.briefType || '';
  const requestedDocFamily = documentFamily(requestedType);
  const requestedLegalFamily = legalFamily(`${criteria.courtType || ''} ${requestedType} ${criteria.factsOrSubject || ''}`);
  if (!models.length) {
    return `[بصمة أسلوب المحامي — سياق للمهمة الحالية]\n[لا توجد نماذج شخصية محفوظة في خزنة هذا الحساب. لا تدّعِ استخدام أسلوب مرجعي؛ اكتب وفق المعلومات الحالية فقط.]`;
  }

  // All saved models participate in the comparison. The AI receives one best
  // reference, not an arbitrary fixed batch, to keep one coherent lawyer style.
  const best = rankVaultModels(models, criteria)[0];
  if (!best) {
    return `[بصمة أسلوب المحامي — سياق للمهمة الحالية]\n[لا يوجد نموذج يحتوي على نص قابل للاستخدام في خزنة هذا الحساب. اكتب وفق المعلومات الحالية فقط.]`;
  }

  const content = String(best.model.content || '').trim();
  const excerpt = content.slice(0, 18000);
  const metadata = [best.model.title, best.model.judicialWorkType, best.model.category].filter(Boolean).join(' — ');
  const typeLine = requestedType ? `نوع المستند المطلوب: ${requestedType}.` : 'يُحدد نوع المستند من طلب المستخدم الحالي ووقائعه.';
  const familyLine = requestedLegalFamily ? `الفرع القانوني الأقرب: ${requestedLegalFamily}.` : 'حدّد الفرع القانوني من وقائع وطلبات القضية الحالية.';
  const courtLine = criteria.courtType ? `المحكمة أو الجهة: ${criteria.courtType}.` : 'تُراعى جهة القضاء التي تحددها وقائع المهمة.';
  const referenceBlock = `[النموذج المرجعي المختار${metadata ? `: ${metadata}` : ''}]\n${excerpt}${content.length > excerpt.length ? '\n[اقتُصر النص على جزء من النموذج بسبب حد السياق.]' : ''}`;

  return `[بصمة أسلوب المحامي — مرجع فعلي من خزنة هذا الحساب]\n${typeLine}\n${familyLine}\n${courtLine}\nتمت مقارنة جميع النماذج المحفوظة في الحساب واختيار المرجع الأقرب لموضوع المهمة، ثم جهة القضاء ونوع العمل القضائي. النموذج التالي هو المرجع الأساسي لهذه المهمة؛ لا تستخدم نماذج أخرى لمجرد أنها محفوظة. النص مرجع أسلوب وبناء وليس مصدراً لوقائع القضية الحالية.\n\n${referenceBlock}\n\n[تعليمات استخدام المرجع]\n1) اقتدِ بالنموذج المرجعي في بصمة المحامي الفعلية: الديباجة، والترويسة، وترتيب الأقسام، وتسلسل عرض الوقائع والحجج، والعبارات الانتقالية، وطول الفقرات، وصياغة الطلبات والخاتمة، بقدر ما يناسب نوع العمل الحالي.\n2) إذا كان المرجع من الموضوع نفسه أو من موضوع قريب، استفد من بنيته وطريقة معالجة هذا النوع من النزاع، لكن لا تنقل أي تحليل أو دفع أو طلب باعتباره صالحاً للقضية الحالية دون أن تسنده وقائعها ومستنداتها.\n3) استخلص نوع المستند المطلوب من اختيار المحامي أو من وقائع المهمة وتعليماته. لا تفترض أن المطلوب مذكرة دفاع لمجرد أن بعض النماذج المحفوظة مذكرات.\n4) لا تنقل أسماء أطراف القضية المرجعية أو وقائعها أو تواريخها أو أرقامها أو مستنداتها أو طلباتها أو دفوعها الخاصة.\n5) انقل عناصر هوية المكتب الثابتة والترويسة والتوقيع من المرجع فقط إذا كانت واضحة وثابتة، ولا تخترع أي بيانات.\n6) صحة التحليل القانوني للقضية الحالية وطلبات المحامي تتقدم دائماً على التشابه الأسلوبي؛ لا تختلق واقعة أو مادة أو حكماً أو رقم طعن.\n7) إذا كان نوع المستند الحالي مختلفاً عن المرجع، فاحتفظ ببصمة المحامي العامة وعدّل هيكل المستند بالقدر اللازم لطبيعة العمل المطلوب، ولا تحوّله إلى نوع المرجع.`;
}
