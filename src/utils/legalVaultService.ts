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

function styleFingerprintCacheKey(userId?: string): string {
  const safeUserId = String(userId || getActiveLawyerUserId()).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `amin_lawyer_style_fingerprint_v1_${safeUserId}`;
}

function styleFingerprintSignature(models: LawModelItem[]): string {
  let hash = 2166136261;
  const source = models.map((model) => [
    model.id || '',
    model.title || '',
    model.category || '',
    model.judicialWorkType || '',
    model.updatedAt || '',
    model.content || '',
  ].join('\u001f')).join('\u001e');

  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${models.length}_${(hash >>> 0).toString(36)}`;
}

function detectOpeningStyle(content: string): string {
  const lines = String(content || '').replace(/\r/g, '').split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 12);
  if (lines.some((line) => /^باسم الشعب/.test(normalizeVaultText(line)))) {
    return 'يفتتح بصيغة «باسم الشعب» عندما تقتضي طبيعة المستند ذلك';
  }
  if (lines.some((line) => /^انه في يوم/.test(normalizeVaultText(line)))) {
    return 'يفتتح ببيان يوم الإجراء وتاريخه ثم صيغة بناءً على طلب';
  }
  if (lines.some((line) => /^(لدي محكمه|محكمه|مجلس الدوله)/.test(normalizeVaultText(line)))) {
    return 'يبدأ بتحديد جهة القضاء والمحكمة قبل عرض موضوع المستند';
  }
  if (lines.some((line) => /^(السيد الاستاذ|الي السيد|الى السيد)/.test(normalizeVaultText(line)))) {
    return 'يبدأ بمخاطبة الجهة أو المسؤول المختص بصيغة رسمية مباشرة';
  }
  return 'يعتمد افتتاحاً قانونياً مباشراً مناسباً لطبيعة الإجراء دون تمهيد إنشائي';
}

function detectClosingStyle(content: string): string {
  const lines = String(content || '').replace(/\r/g, '').split('\n').map((line) => line.trim()).filter(Boolean).slice(-14);
  const ending = lines.map(normalizeVaultText).join(' ');
  const notes: string[] = [];
  if (/لهذه الاسباب|بناء عليه|لذلك|لما تقدم/.test(ending)) {
    notes.push('يختم بالانتقال من الأسباب إلى الطلبات بصيغة قضائية مباشرة');
  }
  if (/مقدمه لسيادتكم|وكيل الطالب|وكيل المدعي|وكيل المدعى/.test(ending)) {
    notes.push('يثبت صفة مقدم المستند أو الوكيل في موضع الخاتمة عند لزومها');
  }
  if (/وتفضلوا|وتفضلوا بقبول/.test(ending)) {
    notes.push('تظهر خاتمة احترام رسمية في المكاتبات التي تقتضيها');
  }
  return notes.length ? notes.join('؛ ') : 'ينهي العمل بطلباته أو خاتمته الإجرائية دون عبارات محادثية';
}

function buildLawyerStyleFingerprint(models: LawModelItem[], bestContent: string): string {
  const combinedSamples = models
    .map((model) => String(model.content || '').trim().slice(0, 10000))
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 80000);
  const generalStyle = deriveStyleProfile(combinedSamples, false);
  const workTypeStyle = deriveStyleProfile(bestContent, true);
  return [
    'بصمة المحامي الثابتة المستخلصة من نماذجه المحفوظة:',
    generalStyle,
    'الافتتاح المرصود: ' + detectOpeningStyle(bestContent),
    'بناء المستند المرجعي الأقرب: ' + workTypeStyle,
    'الخاتمة المرصودة: ' + detectClosingStyle(bestContent),
    'طبّق هذه السمات على نوع العمل المطلوب فقط؛ غيّر ترتيب الأقسام بالقدر الذي تفرضه طبيعة الصحيفة أو المذكرة أو الإعلان أو الإنذار أو غيرها.',
    'حافظ على نبرة المحامي ومفرداته وانتقالاته وطول فقراته، ولا تنقل من النماذج أي وقائع أو أسماء أو أرقام أو تواريخ أو مستندات أو طلبات أو دفوع أو نصوص قانونية خاصة بقضية أخرى.',
  ].filter(Boolean).join('\n');
}

export function getLawyerStyleContext(searchCriteria?: LawVaultSearchCriteria | string, userId?: string): string {
  let criteria: LawVaultSearchCriteria = {};
  if (typeof searchCriteria === 'string') criteria = { courtType: searchCriteria };
  else if (searchCriteria) criteria = searchCriteria;

  const models = getAllLawModels(userId).filter((model) => String(model.content || '').trim());
  const requestedType = criteria.judicialWorkType || criteria.briefType || '';
  const requestedLegalFamily = legalFamily(`${criteria.courtType || ''} ${requestedType} ${criteria.factsOrSubject || ''}`);

  if (!models.length) {
    return '[بصمة أسلوب المحامي — لا توجد نماذج شخصية محفوظة في خزنة هذا الحساب؛ لا تدّعِ استخدام بصمة غير متاحة.]';
  }

  const best = rankVaultModels(models, criteria)[0];
  if (!best) {
    return '[بصمة أسلوب المحامي — لا يوجد نص مرجعي صالح؛ اكتب وفق بيانات القضية الحالية فقط.]';
  }

  const signature = styleFingerprintSignature(models);
  const cacheKey = styleFingerprintCacheKey(userId);
  let cachedProfile = '';
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey) || 'null');
    if (cached?.signature === signature && typeof cached?.profile === 'string') {
      cachedProfile = cached.profile;
    }
  } catch {}

  if (!cachedProfile) {
    cachedProfile = buildLawyerStyleFingerprint(models, String(best.model.content || ''));
    try {
      localStorage.setItem(cacheKey, JSON.stringify({ signature, profile: cachedProfile }));
    } catch (error) {
      console.warn('Lawyer style fingerprint could not be cached:', error);
    }
  } else {
    // The shared profile is cached; refresh only the short structure notes
    // when a different judicial-work type selects a different reference.
    const referenceStyle = deriveStyleProfile(String(best.model.content || ''), true);
    cachedProfile = cachedProfile.replace(
      /الافتتاح المرصود:[^\n]*/,
      'الافتتاح المرصود: ' + detectOpeningStyle(String(best.model.content || '')),
    ).replace(
      /بناء المستند المرجعي الأقرب:[^\n]*/,
      'بناء المستند المرجعي الأقرب: ' + referenceStyle,
    ).replace(
      /الخاتمة المرصودة:[^\n]*/,
      'الخاتمة المرصودة: ' + detectClosingStyle(String(best.model.content || '')),
    );
  }

  const workLine = requestedType
    ? `نوع العمل الحالي: ${requestedType}.`
    : 'يُحدد نوع العمل من طلب المحامي ووقائع المهمة، ولا يُفترض نوع مستند بعينه.';
  const courtLine = criteria.courtType ? `جهة القضاء: ${criteria.courtType}.` : '';
  const familyLine = requestedLegalFamily ? `الفرع القانوني: ${requestedLegalFamily}.` : '';

  return [
    '[بصمة أسلوب المحامي — ملف أسلوبي مختصر محفوظ لهذا الحساب]',
    workLine,
    courtLine,
    familyLine,
    cachedProfile,
    'الخزانة مرجع للأسلوب والبناء فقط؛ وقائع القضية الحالية ومستنداتها وتعليمات المحامي هي المصدر الوحيد لمضمون المستند.',
  ].filter(Boolean).join('\n');
}
