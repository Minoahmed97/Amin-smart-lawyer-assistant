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

type CachedVaultModelAnalysis = {
  id: string;
  searchableText: string;
  styleProfile: string;
};

type CachedVaultAnalysis = {
  version: 2;
  vaultSignature: string;
  models: CachedVaultModelAnalysis[];
};

function getVaultAnalysisStorageKey(userId?: string): string {
  return getScopedStorageKey(userId) + '_analysis_v2';
}

function invalidateVaultAnalysis(userId?: string): void {
  try { localStorage.removeItem(getVaultAnalysisStorageKey(userId)); } catch {}
}

function hashVaultContent(value: string): string {
  // FNV-1a over the complete content: same-length edits must invalidate the
  // cached profile just as reliably as additions and deletions.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function getVaultSignature(models: LawModelItem[]): string {
  return models.map((model) => [
    model.id, model.title || '', model.category || '',
    model.judicialWorkType || '', model.notes || '',
    hashVaultContent(String(model.content || '')), model.createdAt || '',
  ].join(':')).join('|');
}

function getCachedVaultAnalysis(models: LawModelItem[], userId?: string): CachedVaultAnalysis {
  const vaultSignature = getVaultSignature(models);
  const cacheKey = getVaultAnalysisStorageKey(userId);
  try {
    const raw = localStorage.getItem(cacheKey);
    const cached = raw ? JSON.parse(raw) as CachedVaultAnalysis : null;
    if (cached?.version === 2 && cached.vaultSignature === vaultSignature &&
        Array.isArray(cached.models) && cached.models.length === models.length) {
      return cached;
    }
  } catch {}

  // This is the one-time local extraction for the current vault version.
  // Only compact descriptors are cached; source pleadings remain in the vault.
  const analysis: CachedVaultAnalysis = {
    version: 2,
    vaultSignature,
    models: models.map((model) => ({
      id: model.id,
      searchableText: [...topicTokens(
        `${model.title || ''} ${model.category || ''} ${model.judicialWorkType || ''} ${model.notes || ''} ${String(model.content || '').slice(0, 24000)}`,
      )].join(' '),
      styleProfile: deriveStyleProfile(String(model.content || ''), true),
    })),
  };
  try { localStorage.setItem(cacheKey, JSON.stringify(analysis)); } catch (error) {
    console.warn('Could not persist the compact lawyer-vault profile:', error);
  }
  return analysis;
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
    invalidateVaultAnalysis(userId);
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
    invalidateVaultAnalysis(userId);
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
    invalidateVaultAnalysis(userId);
  } catch (e) {
    console.warn('LocalStorage delete error:', e);
  }
}

export function clearAllLawModels(userId?: string): void {
  try {
    localStorage.setItem(getScopedStorageKey(userId), JSON.stringify([]));
    invalidateVaultAnalysis(userId);
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

  // Requested document/work type is the primary constraint. Court and legal
  // family follow; topic overlap distinguishes only otherwise suitable models.
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
      score += Math.round((matchedTopicWeight / totalTopicWeight) * 100);

      const matchedMetadataWeight = [...requestedTokens]
        .filter((token) => modelMetaTokens.has(token))
        .reduce((sum, token) => sum + tokenWeight(token), 0);
      score += Math.round((matchedMetadataWeight / totalTopicWeight) * 12);
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
      if (modelLegalFamily === requestedLegalFamily) score += 35;
      else if (modelLegalFamily && modelLegalFamily !== requestedLegalFamily) score -= 28;
    }

    if (requestedDocFamily) {
      if (modelDocFamily === requestedDocFamily) score += 55;
      else if (modelDocFamily && modelDocFamily !== requestedDocFamily) score -= 45;
      if (modelMatchesRequestedType(model, requestedType)) score += 100;
      else score -= 35;
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

export function getCachedLawyerStyleContext(searchCriteria?: LawVaultSearchCriteria | string, userId?: string): string {
  let criteria: LawVaultSearchCriteria = {};
  if (typeof searchCriteria === 'string') criteria = { courtType: searchCriteria };
  else if (searchCriteria) criteria = searchCriteria;

  const sourceModels = getAllLawModels(userId).filter((model) => String(model.content || '').trim());
  if (!sourceModels.length) {
    return `[بصمة أسلوب المحامي — سياق للمهمة الحالية]
[لا توجد نماذج شخصية محفوظة في خزنة هذا الحساب. لا تدّعِ استخدام أسلوب مرجعي؛ اكتب وفق المعلومات الحالية فقط.]`;
  }

  const cachedAnalysis = getCachedVaultAnalysis(sourceModels, userId);
  const analysisById = new Map(cachedAnalysis.models.map((item) => [item.id, item]));
  const rankingModels = sourceModels.map((model) => ({
    ...model,
    content: analysisById.get(model.id)?.searchableText || '',
  }));
  const bestRanked = rankVaultModels(rankingModels, criteria)[0];
  const bestModel = bestRanked
    ? sourceModels.find((model) => model.id === bestRanked.model.id)
    : undefined;
  if (!bestModel) {
    return `[بصمة أسلوب المحامي — سياق للمهمة الحالية]
[لا يوجد نموذج يحتوي على نص قابل للاستخدام في خزنة هذا الحساب. اكتب وفق المعلومات الحالية فقط.]`;
  }

  const requestedType = criteria.judicialWorkType || criteria.briefType || '';
  const requestedLegalFamily = legalFamily(`${criteria.courtType || ''} ${requestedType} ${criteria.factsOrSubject || ''}`);
  const metadata = [bestModel.title, bestModel.judicialWorkType, bestModel.category].filter(Boolean).join(' — ');
  const styleProfile = analysisById.get(bestModel.id)?.styleProfile || 'استخدم صياغة قانونية عربية مصرية متماسكة، مع الحفاظ على تسلسل منطقي واضح.';
  const typeLine = requestedType ? `نوع المستند المطلوب: ${requestedType}.` : 'يُحدد نوع المستند من طلب المستخدم ووقائعه.';
  const familyLine = requestedLegalFamily ? `الفرع القانوني الأقرب: ${requestedLegalFamily}.` : 'يراعى الفرع القانوني الثابت من وقائع المهمة.';
  const courtLine = criteria.courtType ? `المحكمة أو الجهة: ${criteria.courtType}.` : 'تراعى جهة القضاء المحددة في المهمة.';

  return `[بصمة أسلوب المحامي — ملف محلي مستخلص مسبقاً من خزنة هذا الحساب]
${typeLine}
${familyLine}
${courtLine}
النموذج الأقرب المختار من جميع نماذج الخزانة: ${metadata || 'نموذج شخصي محفوظ'}.
تم اختيار النموذج وفق نوع العمل والفرع القضائي والمحكمة وموضوع القضية، مع اعتبار الوزن المحفوظ عامل ترجيح ثانوياً فقط.

[ملامح الأسلوب المستخلصة والمحفوظة محلياً]
- ${styleProfile}

[قواعد تطبيق البصمة]
- طبّق طريقة المحامي في الترويسة وتسلسل الأقسام وطول الفقرات والجمل والروابط التعبيرية والخاتمة بقدر ملاءمتها لنوع المستند الحالي.
- النموذج المختار مرجع أسلوبي فقط؛ لا تنقل منه أي وقائع أو أسماء أو تواريخ أو أرقام أو مستندات أو دفوع أو طلبات تخص قضية أخرى.
- لا تجعل النموذج المرجعي يغيّر نوع المستند الذي طلبه المحامي أو يضيف طلبات لم يحددها.
- صحة القضية الحالية وطلبات المحامي تتقدم على التشابه الأسلوبي؛ لا تختلق واقعة أو سنداً قانونياً.`;
}

export function getLawyerStyleContext(searchCriteria?: LawVaultSearchCriteria | string, userId?: string): string {
  let criteria: LawVaultSearchCriteria = {};
  if (typeof searchCriteria === 'string') criteria = { courtType: searchCriteria };
  else if (searchCriteria) criteria = searchCriteria;

  const models = getAllLawModels(userId).filter((model) => String(model.content || '').trim());
  const requestedType = criteria.judicialWorkType || criteria.briefType || '';
  const requestedLegalFamily = legalFamily(`${criteria.courtType || ''} ${requestedType} ${criteria.factsOrSubject || ''}`);
  if (!models.length) {
    return `[بصمة أسلوب المحامي — سياق للمهمة الحالية]
[لا توجد نماذج شخصية محفوظة في خزنة هذا الحساب. لا تدّعِ استخدام أسلوب مرجعي؛ اكتب وفق المعلومات الحالية فقط.]`;
  }

  const best = rankVaultModels(models, criteria)[0];
  if (!best) {
    return `[بصمة أسلوب المحامي — سياق للمهمة الحالية]
[لا يوجد نموذج يحتوي على نص قابل للاستخدام في خزنة هذا الحساب. اكتب وفق المعلومات الحالية فقط.]`;
  }

  const content = String(best.model.content || '').trim();
  const excerpt = content.length <= 5200
    ? content
    : [
        content.slice(0, 2400),
        '[مقتطف من متن النموذج المرجعي]',
        content.slice(Math.max(2400, Math.floor(content.length / 2) - 500), Math.max(2400, Math.floor(content.length / 2) - 500) + 1000),
        '[الخاتمة والتوقيع من النموذج المرجعي]',
        content.slice(-1200),
      ].join('\n\n');
  const styleProfile = deriveStyleProfile(content, true);
  const metadata = [best.model.title, best.model.judicialWorkType, best.model.category].filter(Boolean).join(' — ');
  const typeLine = requestedType ? `نوع المستند المطلوب: ${requestedType}.` : 'يُحدد نوع المستند من طلب المستخدم ووقائعه.';
  const familyLine = requestedLegalFamily ? `الفرع القانوني الأقرب: ${requestedLegalFamily}.` : 'يراعى الفرع القانوني الثابت من وقائع المهمة.';
  const courtLine = criteria.courtType ? `المحكمة أو الجهة: ${criteria.courtType}.` : 'تراعى جهة القضاء المحددة في المهمة.';
  const referenceBlock = `[النموذج المرجعي المختار${metadata ? `: ${metadata}` : ''}]\n${excerpt}${content.length > excerpt.length ? '\n[عينة منتقاة من بداية النموذج ووسطه وخاتمته.]' : ''}`;

  return `[بصمة أسلوب المحامي — مرجع فعلي من خزنة هذا الحساب]
${typeLine}
${familyLine}
${courtLine}
تمت مقارنة جميع نماذج الحساب واختيار الأقرب للمهمة. النموذج التالي مرجع للأسلوب والبناء فقط، وليس مصدراً لوقائع القضية الحالية.

[ملامح الأسلوب المستخلصة]
${styleProfile}

${referenceBlock}

[قواعد تطبيق المرجع]
- حافظ على الديباجة والترويسة وبصمة المحامي وتسلسل الأقسام والعبارات وطريقة عرض الحجج والطلبات والخاتمة بقدر ملاءمتها لنوع العمل الحالي.
- استفد من بنية النموذج، ولا تنقل منه تحليلاً أو دفعاً أو طلباً إلا إذا سنده ملف القضية الحالية.
- لا تنقل أسماء أو وقائع أو تواريخ أو أرقاماً أو مستندات أو طلبات تخص القضية المرجعية.
- استخدم بيانات المكتب والتوقيع الثابتة إذا كانت واضحة، ولا تخترع بيانات.
- صحة القضية الحالية وطلبات المحامي تتقدم على التشابه الأسلوبي؛ لا تختلق واقعة أو سنداً قانونياً.
- إذا اختلف نوع المستند الحالي عن النموذج، فاحتفظ بالبصمة وعدّل الهيكل بالقدر اللازم دون تحويله إلى نوع آخر.`;
}
