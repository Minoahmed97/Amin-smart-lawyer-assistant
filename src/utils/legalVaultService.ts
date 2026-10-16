import { LawModelItem } from '../types.ts';

export type { LawModelItem };

export const LAWYER_VAULT_REQUIRED_MESSAGE = 'لم يتم العثور على نموذج مناسب في خزينة حسابك. أضف نموذجًا إلى الخزينة ثم أعد المحاولة';

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

export function findSimilarModels( criteria: { courtType?: string; briefType?: string; judicialWorkType?: string; factsOrSubject?: string; }, userId?: string ): LawModelItem[] {
  const models = getAllLawModels(userId);
  if (!models || models.length === 0) return [];

  const { courtType = '', briefType = '', judicialWorkType = '', factsOrSubject = '' } = criteria;

  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[ًٌٍَُِّْـ]/g, '')
      .replace(/[^\u0600-\u06FFa-z0-9\s]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const tokenize = (value: string) =>
    normalize(value)
      .split(/\s+/)
      .filter((token) => token.length >= 3);

  const normalizedFacts = normalize(factsOrSubject);
  const normalizedCourt = normalize(courtType);
  const normalizedBrief = normalize(briefType);
  const normalizedWorkType = normalize(judicialWorkType);
  const factTokens = new Set(tokenize(factsOrSubject));

  const scored = models.map((m) => {
    let score = (m.weight || 3) * 2;
    const titleLower = normalize(m.title);
    const catLower = normalize(m.category);
    const notesLower = normalize(m.notes || '');
    const contentLower = normalize(m.content);
    const workTypeLower = normalize(m.judicialWorkType || '');

    // 1. Prefer the same judicial work type.
    if (normalizedWorkType) {
      if (workTypeLower.includes(normalizedWorkType) || normalizedWorkType.includes(workTypeLower)) {
        score += 45;
      }
      if (catLower.includes(normalizedWorkType) || titleLower.includes(normalizedWorkType)) score += 25;
    }

    // 2. Prefer the same court / brief type.
    if (normalizedCourt) {
      if (catLower.includes(normalizedCourt) || normalizedCourt.includes(catLower)) score += 20;
      if (contentLower.includes(normalizedCourt)) score += 5;
    }

    if (normalizedBrief) {
      if (titleLower.includes(normalizedBrief) || catLower.includes(normalizedBrief)) score += 15;
      if (notesLower.includes(normalizedBrief)) score += 8;
    }

    // 3. Use the actual case text to rank the closest lawyer-owned models,
    // instead of relying only on a fixed list of legal keywords.
    if (factTokens.size > 0) {
      const modelTokens = new Set(tokenize(`${m.title} ${m.category} ${m.judicialWorkType || ''} ${m.notes || ''} ${m.content}`));
      let overlap = 0;
      factTokens.forEach((token) => {
        if (modelTokens.has(token)) overlap += 1;
      });
      score += Math.min(40, overlap * 2);
    }

    // Keep exact high-value legal phrases as a small additional signal.
    const keywords = [
      'طرد', 'غصب', 'تعويض', 'إيجار', 'فسخ', 'بطلان',
      'صحة توقيع', 'صحة ونفاذ', 'قسمة', 'فرز وتجنيب', 'نفقة', 'طلاق', 'خلع', 'رؤية',
      'إيصال أمانة', 'شيك', 'نصب', 'تبديد'
    ];

    for (const kw of keywords) {
      const normalizedKw = normalize(kw);
      if (normalizedFacts.includes(normalizedKw) || normalizedBrief.includes(normalizedKw)) {
        if (titleLower.includes(normalizedKw) || catLower.includes(normalizedKw) || workTypeLower.includes(normalizedKw)) score += 10;
        if (contentLower.includes(normalizedKw)) score += 4;
      }
    }

    return { model: m, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.model);
}

export function getLawyerStyleContext( searchCriteria?: { courtType?: string; briefType?: string; judicialWorkType?: string; factsOrSubject?: string; } | string, userId?: string ): string {
  let criteria: { courtType?: string; briefType?: string; judicialWorkType?: string; factsOrSubject?: string } = {};
  if (typeof searchCriteria === 'string') {
    criteria = { courtType: searchCriteria };
  } else if (searchCriteria) {
    criteria = searchCriteria;
  }

  const similarModels = findSimilarModels(criteria, userId).filter(
    (model) => typeof model.content === 'string' && model.content.trim().length > 0,
  );
  if (similarModels.length === 0) {
    throw new Error(LAWYER_VAULT_REQUIRED_MESSAGE);
  }

  // Never send the saved pleading text to the generation model: even with
  // instructions not to copy it, its case facts can leak into a new matter.
  // Derive a compact, non-content-bearing style profile from document structure.
  const selectedModels = similarModels.slice(0, 1);
  const modelBlocks = selectedModels.map((model) => {
    const content = String(model.content || '');
    const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const paragraphs = content.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
    const headings = new Set<string>();
    const allowedHeadings = [
      'الوقائع', 'الطلبات', 'الطلبات الختامية', 'الدفاع', 'أوجه الدفاع', 'الدفوع',
      'الدفع', 'أولاً', 'ثانياً', 'ثالثاً', 'رابعاً', 'خامساً', 'بناء عليه',
      'لذلك', 'الموضوع', 'مقدمة', 'ختاماً', 'حافظة مستندات'
    ];
    for (const line of lines) {
      const normalized = line.replace(/[：:،,؛;\s]+$/g, '').replace(/^[-*#\d.\s]+/, '').trim();
      if (allowedHeadings.some((heading) => normalized === heading || normalized.startsWith(`${heading} `))) {
        headings.add(allowedHeadings.find((heading) => normalized === heading || normalized.startsWith(`${heading} `))!);
      }
    }
    const avgParagraphLength = paragraphs.length
      ? Math.round(paragraphs.reduce((sum, part) => sum + part.length, 0) / paragraphs.length)
      : 0;
    const numberedSections = lines.filter((line) => /^(?:\d+[.)、]|[٠-٩]+[.)、]|(?:أولاً|ثانياً|ثالثاً|رابعاً|خامساً)\s*[-:：]?)/.test(line)).length;
    const usesFormalAddress = /السيد\s*\//.test(content);
    const usesPrayerClosing = /وتفضلوا بقبول|ولسيادتكم وافر الاحترام/.test(content);
    const profile = [
      'مرجع أسلوبي مستخلص من بنية النموذج فقط؛ نص القضية الأصلية محجوب بالكامل.',
      `تنظيم المستند: ${headings.size ? [...headings].join('، ') : 'عناوين قانونية واضحة بحسب الحاجة'}.`,
      `متوسط طول الفقرة التقريبي: ${avgParagraphLength > 500 ? 'طويلة ومفصلة' : avgParagraphLength > 220 ? 'متوسطة إلى مفصلة' : 'موجزة إلى متوسطة'}.`,
      `استخدام الترقيم المنظم للأقسام: ${numberedSections >= 2 ? 'واضح ومتكرر' : 'محدود أو غير ظاهر'}.`,
      `صيغة مخاطبة رسمية: ${usesFormalAddress ? 'تظهر في النموذج' : 'غير مثبتة'}.`,
      `خاتمة احترام رسمية: ${usesPrayerClosing ? 'تظهر في النموذج' : 'غير مثبتة'}.`,
      'اكتب الوقائع والأسماء والتواريخ والأرقام والطلبات والدفوع الخاصة بالمهمة الجديدة من مدخلاتها ومستنداتها فقط. لا تنقل أي نص حرفي أو بيانات تعريفية من النموذج.'
    ].join('\n');
    return `[أقرب نموذج شخصي للمحامي: مرجع أسلوبي خاص بالحساب]\n${profile}`;
  });

  // Drafting must be grounded in this account's own saved vault models only.
  // Built-in sample templates are not lawyer-owned models and can mislead the
  // user into thinking another person's/sample pleading came from their vault.

  return `[خزانة المحامي الشخصية — سياق أسلوبي إلزامي للمهمة الحالية]: استخدم النموذج الشخصي المحفوظ في خزنة هذا الحساب لاستخلاص بصمة المحامي في الديباجة وترتيب الفقرات وعناوين الدفوع والانتقال بين الوقائع والدفاع والطلبات والمصطلحات ونمط الجمل. ${modelBlocks.join('\n\n')} لا تستخدم أي نموذج أو قالب أو اقتباس من خارج خزينة هذا الحساب. طبّق أسلوب النموذج دون نسخ وقائعه أو أسماء أطرافه أو أرقام قضاياه أو تواريخه أو مستنداته أو طلباته الخاصة. لا تستورد مادة قانونية أو حكماً أو رقم طعن من النموذج لمجرد وروده فيه؛ تحقق من السند أو نبّه إلى حاجته للتحقق. وقائع القضية الحالية ومدخلات المستخدم ومستنداته لها الأولوية. لا تذكر للمستخدم عملية الاختيار؛ أخرج العمل القانوني المطلوب مباشرة بأسلوب طبيعي.`;
}
