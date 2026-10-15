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
      // Empty model fields must never match every requested work type.
      if (workTypeLower && (workTypeLower.includes(normalizedWorkType) || normalizedWorkType.includes(workTypeLower))) {
        score += 45;
      }
      if ((catLower && catLower.includes(normalizedWorkType)) || (titleLower && titleLower.includes(normalizedWorkType))) score += 25;
    }

    // 2. Prefer the same court / brief type. Guard empty fields so an empty
    // category/title cannot receive a match merely because every string includes ''.
    if (normalizedCourt) {
      if ((catLower && catLower.includes(normalizedCourt)) || (catLower && normalizedCourt.includes(catLower))) score += 20;
      if (contentLower && contentLower.includes(normalizedCourt)) score += 5;
    }

    if (normalizedBrief) {
      if ((titleLower && titleLower.includes(normalizedBrief)) || (catLower && catLower.includes(normalizedBrief))) score += 15;
      if (notesLower && notesLower.includes(normalizedBrief)) score += 8;
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

  const similarModels = findSimilarModels(criteria, userId);

  // Pass only the closest ranked lawyer-owned references. Too many full
  // templates increase unrelated factual/style bleed into the current draft.
  const selectedModels = similarModels.slice(0, 2);
  const modelBlocks = selectedModels.map((model, index) => {
    const content = model.content || '';
    const excerpt = content.length > 5000
      ? `${content.slice(0, 3200)}\n\n[...جزء أوسط محذوف للاختصار... ]\n\n${content.slice(-1800)}`
      : content;
    return (
      `[مرشح نموذج المحامي رقم ${index + 1}: "${model.title}" — ${model.judicialWorkType || model.category}]\n` +
      `\`\`\`\n${excerpt}\n\`\`\``
    );
  });

  // Drafting must be grounded in this account's own saved vault models only.
  // Built-in sample templates are not lawyer-owned models and can mislead the
  // user into thinking another person's/sample pleading came from their vault.

  return `[خزانة المحامي الشخصية — سياق إلزامي للمهمة الحالية]: هذا السياق جزء أساسي من طلب الصياغة وليس معلومة اختيارية. استخدم النماذج الشخصية المحفوظة في خزنة هذا الحساب لاستخلاص البصمة الكتابية الفعلية للمحامي: الديباجة، ترتيب الفقرات، عناوين الدفوع، الانتقال بين الوقائع والدفاع والطلبات، المصطلحات، ونمط الجمل. لا تستخدم نماذج افتراضية أو منسوبة إلى حساب آخر. ${modelBlocks.length ? modelBlocks.join('\n\n') : '[لا توجد نماذج شخصية مطابقة في خزنة الحساب الحالي.]'} تعليمات إلزامية لاستخدام السياق: 1) هذه النماذج الشخصية مرشحات أسلوبية وليست نصوصاً يجب نسخها. اختر أنت داخلياً النموذج الشخصي الأقرب إلى نوع المهمة ووقائع القضية والمحكمة وطريقة الدفوع، ولا تفترض أن أول نموذج مرفق هو الأفضل. 2) إذا كان أكثر من نموذج مناسب، قارن بينها واستخلص البصمة المشتركة والأقرب للقضية، ثم اجعل النموذج الأشد صلة هو المرجع الأساسي للتنظيم والأسلوب. 3) طبّق أثر النموذج المختار فعلياً في الصياغة النهائية: الديباجة، ترتيب الأقسام، عناوين الدفوع، تسلسل الحجج، المصطلحات، طول الفقرات، الانتقالات، وصياغة الطلبات، مع الحفاظ على أسلوب قانوني طبيعي غير روبوتي. 4) لا تكتفِ بذكر أن الخزانة موجودة، ولا تنتقل إلى صياغة عامة إذا كان هناك نموذج شخصي مناسب يمكن محاكاة أسلوبه. يجب أن يشعر القارئ أن المستند كُتب بنفس المدرسة والأسلوب والترتيب المعتاد للمحامي، مع اختلاف الوقائع والمضمون بحسب القضية الجديدة. 5) لا تنسخ وقائع أو أسماء أو أرقام قضايا أو تواريخ أو مستندات أو طلبات أو دفوع خاصة بالنماذج المرجعية إلى القضية الحالية. 6) لا تستورد مادة قانونية أو حكماً أو رقم طعن من نموذج مرجعي لمجرد وجوده فيه؛ أي سند قانوني يجب أن يكون متحققاً من السياق الحالي أو يُذكر أنه يحتاج تحققاً. 7) القضية الحالية ومدخلات المستخدم ومستنداته لها الأولوية المطلقة عند التعارض مع أي نموذج. 8) لا تستخدم أي قالب افتراضي أو نموذج غير محفوظ في خزنة هذا الحساب. 9) إذا لم يوجد نموذج شخصي مناسب في خزنة هذا الحساب، أنشئ المحتوى من وقائع القضية الحالية فقط دون اختلاق نموذج منسوب إلى محامٍ آخر. 10) لا تخبر المستخدم بعملية الاختيار الداخلية ولا تضف فقرة تشرح أنك استخدمت نموذجاً مرجعياً؛ أخرج المستند القانوني مباشرة بأسلوبه المستخلص.`;
}
