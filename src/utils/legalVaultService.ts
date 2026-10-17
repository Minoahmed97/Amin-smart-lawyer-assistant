import { LawModelItem } from '../types.ts';
import { classifyLegalDocument, getLegalDocTemplates } from './legalTemplateService.ts';
import { extractTextFromDocx } from './fileExtractor.ts';

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
  // Keep every useful label. Uploaded-file classification can be broad, but
  // title, original file name, explicit metadata and opening lines together
  // are needed to distinguish (for example) a civil memo from a criminal one.
  const openingText = String(model.content || '')
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 18).join(' ');
  const titleType = inferExplicitDocumentType(`${model.title || ''} ${model.fileName || ''}`);
  const headingType = inferExplicitDocumentType(openingText);
  return [
    titleType,
    headingType,
    model.judicialWorkType,
    model.title,
    model.fileName,
    model.category,
    openingText,
  ].map((value) => String(value || '').trim()).filter((value, index, all) => Boolean(value) && all.indexOf(value) === index);
}

function legalDomains(value: string): string[] {
  const text = normalizeVaultText(value || '').replace(/ة/g, 'ه');
  const found: string[] = [];
  const explicitGroups: Array<[string, string[]]> = [
    ['personal-status', ['احوال شخصيه', 'نفقه', 'حضانة', 'طلاق', 'رؤيه', 'ميراث', 'مواريث', 'اسره']],
    ['administrative', ['اداري', 'مجلس الدوله', 'قضاء اداري', 'قرار اداري', 'الغاء قرار']],
    ['criminal', ['جنائي', 'جنايه', 'جنحه', 'قضيه جنائيه', 'عقوبه']],
    ['labor', ['عمالي', 'عمال', 'علاقه العمل', 'فصل تعسفي', 'مستحقات عماليه']],
    ['commercial', ['تجاري', 'شركات', 'افلاس', 'اوراق تجاريه']],
    ['civil', ['مدني', 'مدنيه', 'تعويض مدني', 'مسؤوليه مدنيه']],
  ];
  for (const [domain, needles] of explicitGroups) {
    if (needles.some((needle) => text.includes(normalizeVaultText(needle).replace(/ة/g, 'ه')))) found.push(domain);
  }

  // Infer a domain from several independent legal signals only when the text
  // does not name it explicitly. One incidental word (such as "متهم") must
  // not misclassify a civil memorandum as criminal.
  const signalGroups: Array<[string, string[]]> = [
    ['civil', ['عقد', 'ايجار', 'اجره', 'فسخ', 'بطلان', 'ملكيه', 'حيازه', 'طرد', 'مديونيه', 'دين', 'التزام', 'مقاوله', 'بيع', 'تعويض', 'مسؤوليه', 'مطالبه ماليه', 'تسليم', 'اجور', 'مستحقات']],
    ['criminal', ['المتهم', 'النيابه العامه', 'محضر شرطه', 'حبس', 'ضبط واحضار', 'اتهام', 'جريمه', 'تحريات', 'عقوبه', 'جنحه', 'جنايه']],
    ['administrative', ['قرار وزاري', 'قرار محافظ', 'جهة اداريه', 'موظف عام', 'الغاء قرار', 'ترقيه وظيفيه']],
    ['labor', ['عقد عمل', 'فصل تعسفي', 'اجر العامل', 'مستحقات العامل', 'علاقه عمل']],
    ['commercial', ['شركه', 'تاجر', 'شيك', 'كمبياله', 'سجل تجاري', 'افلاس']],
  ];
  for (const [domain, needles] of signalGroups) {
    if (found.includes(domain)) continue;
    const matches = needles.filter((needle) => text.includes(normalizeVaultText(needle).replace(/ة/g, 'ه')));
    const required = domain === 'administrative' || domain === 'labor' || domain === 'commercial' ? 2 : 2;
    if (matches.length >= required) found.push(domain);
  }
  return found;
}

function requestedLegalDomains(criteria: { briefType?: string; judicialWorkType?: string; courtType?: string; factsOrSubject?: string }): string[] {
  const explicit = [criteria.briefType, criteria.judicialWorkType, criteria.courtType].filter(Boolean).join(' ');
  const explicitDomains = [...new Set(legalDomains(explicit))];
  if (explicitDomains.length) return explicitDomains;
  // Use the current case only to classify its legal domain—not to match old
  // case facts or import their substantive arguments.
  return [...new Set(legalDomains(criteria.factsOrSubject || ''))];
}

function getRequestedDocumentType(criteria: { briefType?: string; judicialWorkType?: string }): string {
  const brief = String(criteria.briefType || '').trim();
  const work = String(criteria.judicialWorkType || '').trim();
  // The form's work selector may remain generic while the brief/title field is
  // the user's specific type (e.g. "مذكرة مدنية"). Prefer that specific value.
  const candidates = [brief, work].filter(Boolean);
  const specific = candidates.find((value) => !isGenericJudicialTask(value));
  return specific || candidates[0] || '';
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

function modelMatchesRequestedType(model: LawModelItem, requestedType: string, courtType = ''): boolean {
  const requested = canonicalDocumentType(requestedType);
  if (!requested) return false;

  // When the request identifies a legal domain, do not treat a criminal or
  // administrative memo as an exact match for a civil memo merely because
  // both labels canonicalize to "مذكرة".
  const requestedDomains = [...new Set([...legalDomains(requestedType), ...legalDomains(courtType)])];
  const modelMeta = [model.title, model.fileName, model.category, model.judicialWorkType, model.notes].filter(Boolean).join(' ');
  const opening = String(model.content || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 18).join(' ');
  const modelDomains = [...new Set(legalDomains(`${modelMeta} ${opening}`))];
  if (requestedDomains.length && modelDomains.length && !requestedDomains.some((domain) => modelDomains.includes(domain))) {
    return false;
  }

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

export function findSimilarModels( criteria: { courtType?: string; briefType?: string; judicialWorkType?: string; factsOrSubject?: string; }, userId?: string, modelsOverride?: LawModelItem[] ): LawModelItem[] {
  const models = modelsOverride || getAllLawModels(userId);
  if (!models.length) return [];

  const requestedType = getRequestedDocumentType(criteria);
  const normalizedCourt = normalizeVaultText(criteria.courtType || '');
  const normalizedBrief = normalizeVaultText(isGenericJudicialTask(criteria.briefType || '') ? '' : (criteria.briefType || ''));
  const normalizedWorkType = normalizeVaultText(isGenericJudicialTask(criteria.judicialWorkType || '') ? '' : (criteria.judicialWorkType || ''));
  const requestedDomains = requestedLegalDomains(criteria);

  // Retrieve style references by document-type metadata, not by case facts or
  // similarity between the current case and the body of an old document.
  const scored = models.map((model, index) => {
    const typeText = normalizeVaultText(modelTypeText(model));
    const categoryText = normalizeVaultText(model.category || '');
    const titleText = normalizeVaultText(model.title || '');
    const notesText = normalizeVaultText(model.notes || '');
    let score = (model.weight || 3) * 2;

    if (requestedType && !isGenericJudicialTask(requestedType)) {
      if (modelMatchesRequestedType(model, requestedType, criteria.courtType || '')) score += 140;
      else if (normalizedWorkType && (typeText.includes(normalizedWorkType) || normalizedWorkType.includes(typeText))) score += 35;
      const normalizedRequested = normalizeVaultText(requestedType);
      if (normalizedRequested && (titleText.includes(normalizedRequested) || categoryText.includes(normalizedRequested))) score += 15;
    }
    // Even when the UI's selector is generic (e.g. "مذكرة"), prefer the
    // same document family over a petition, appeal, or notice. This avoids
    // selecting a high-weight but structurally unrelated vault item.
    if (requestedType) {
      const requestedFamily = documentTypeFamily(requestedType);
      const modelFamilies = modelTypeLabels(model).map(documentTypeFamily).filter(Boolean);
      if (requestedFamily && modelFamilies.includes(requestedFamily)) score += 95;
      else if (requestedFamily === 'memo' && modelFamilies.includes('response')) score += 55;
      else if (requestedFamily === 'response' && modelFamilies.includes('memo')) score += 55;
      else if (requestedFamily && modelFamilies.length) score -= 85;
    }

    if (normalizedBrief) {
      if (typeText.includes(normalizedBrief) || normalizedBrief.includes(typeText)) score += 40;
      if (titleText.includes(normalizedBrief) || categoryText.includes(normalizedBrief)) score += 20;
    }
    if (normalizedCourt) {
      if (categoryText && (categoryText.includes(normalizedCourt) || normalizedCourt.includes(categoryText))) score += 20;
      if (notesText.includes(normalizedCourt)) score += 8;
    }

    if (requestedDomains.length) {
      const modelDomains = [...new Set(legalDomains([
        model.title, model.fileName, model.category, model.judicialWorkType, model.notes,
        String(model.content || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 18).join(' '),
      ].filter(Boolean).join(' ')))];
      if (modelDomains.some((domain) => requestedDomains.includes(domain))) score += 180;
      else if (modelDomains.length) score -= 100;
    }

    // Stable tie-break: preserve the existing vault order. The factsOrSubject
    // field intentionally does not affect retrieval, because doing so favored
    // old documents with similar facts and increased content bleed.
    return { model, score, index };
  });

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((item) => item.model);
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

function isGenericJudicialTask(value: string): boolean {
  // Normalize ta marbuta here as well: the UI sends "صيغة قانونية" while old matching patterns used "صيغه قانونيه".
  const text = normalizeVaultText(value).replace(/ة/g, 'ه');
  if (!text) return true;
  return /^(?:انشاء صيغه قانونيه|صيغه قانونيه|صياغه مستند|مهمه قانونيه اخري|مهمه قانونيه عامه|العمل القضائي|مهمه قانونيه|مذكرة قضائيه|مذكره قضائيه|مذكره عامه|مستند قانوني|نموذج قانوني|مذكره|مذكرة)$/.test(text);
}

function buildPersonalReferenceText(content: string, maxChars = 24000): string {
  const text = String(content || '').replace(/\r\n?/g, '\n').trim();
  if (!text) return '';
  if (text.length <= maxChars) return text;

  // Preserve the actual opening, substantive middle, and closing of the
  // lawyer's own document. A generic description alone cannot reproduce the
  // lawyer's syntax, transitions, cadence, or drafting fingerprint.
  const openingLength = 8000;
  const middleLength = 9000;
  const closingLength = maxChars - openingLength - middleLength - 120;
  const middleStart = Math.max(openingLength, Math.floor((text.length - middleLength) / 2));
  const middleEnd = Math.min(text.length - closingLength, middleStart + middleLength);
  const opening = text.slice(0, openingLength);
  const middle = text.slice(middleStart, middleEnd);
  const closing = text.slice(-closingLength);
  return `${opening}\n[مقتطف محذوف من منتصف النموذج المرجعي للحفاظ على حد السياق]\n${middle}\n[مقتطف محذوف قبل خاتمة النموذج المرجعي]\n${closing}`;
}

function isUsableReferenceContent(content: unknown): content is string {
  const value = String(content || '').trim();
  return value.length >= 80 && (value.match(/[\u0600-\u06FF]/g) || []).length >= 12;
}

function normalizedFileName(value: string): string {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

async function getModelsForStyle(userId?: string): Promise<LawModelItem[]> {
  const models = [...getAllLawModels(userId)];
  // The vault stores extracted model text in localStorage and original DOCX
  // templates separately in IndexedDB. Older uploads can exist only in the
  // latter store. Recover their text locally (DOCX only; never trigger OCR or
  // consume an AI key silently) so a visible personal template is usable.
  try {
    const templates = await getLegalDocTemplates(userId || getActiveLawyerUserId());
    for (const template of templates) {
      if (!/\.docx$/i.test(template.fileName) || typeof File === 'undefined') continue;
      try {
        const file = new File([template.blob], template.fileName, {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        });
        const extracted = (await extractTextFromDocx(file)).trim();
        if (!isUsableReferenceContent(extracted)) continue;
        const classification = classifyLegalDocument(template.fileName, extracted);
        const existingIndex = models.findIndex((model) => normalizedFileName(model.fileName || '') === normalizedFileName(template.fileName));
        const existing = existingIndex >= 0 ? models[existingIndex] : undefined;
        if (existing && isUsableReferenceContent(existing.content)) {
          // Repair stale metadata from older uploads while keeping the existing
          // extracted text and account-owned record intact.
          models[existingIndex] = {
            ...existing,
            category: classification.category || existing.category,
            judicialWorkType: classification.workType || existing.judicialWorkType,
          };
          continue;
        }
        const recovered: LawModelItem = {
          id: existing?.id || `recovered_${template.id}`,
          title: existing?.title || `نموذج: ${template.title}`,
          category: classification.category || existing?.category || 'مستند قضائي',
          judicialWorkType: classification.workType || existing?.judicialWorkType || 'مذكرة',
          content: extracted.slice(0, 80000),
          weight: existing?.weight || 5,
          notes: existing?.notes || 'تم استعادة النص من قالب وورد الأصلي المحفوظ في خزنة هذا الحساب.',
          fileName: template.fileName,
          createdAt: existing?.createdAt || template.createdAt,
          source: 'uploaded',
        };
        if (existingIndex >= 0) models[existingIndex] = recovered;
        else models.push(recovered);
      } catch (error) {
        console.warn('Could not recover text from a saved Word vault template:', template.fileName, error);
      }
    }
  } catch (error) {
    // IndexedDB may be unavailable in some browser contexts; valid text models
    // in the account's scoped localStorage remain usable.
    console.warn('Could not read saved Word templates for style retrieval:', error);
  }
  return models;
}

function extractLawyerLetterhead(content: string): string {
  const lines = String(content || '').replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 24);
  const caseMarker = /^(?:مقدمة\s+من|المقدم\s+من|مقدمه\s+من|عن\s+المدعي|المدعي|المدعى\s+عليه|ضد\b|محكمة|امام\s+محكمه|رقم\s+الدعوى|الوقائع|الموضوع|طلبات|الطلبات)/i;
  const candidates: string[] = [];
  for (const line of lines) {
    if (caseMarker.test(line)) break;
    if (/مكتب|للمحاماة|المحامي|المحاماة|تليفون|هاتف|استشارات قانونية|المستشار القانوني|عنوان المكتب|فاكس/.test(line)) candidates.push(line);
  }
  return candidates.join('\n').slice(0, 1800);
}

export async function getLawyerStyleContext( searchCriteria?: { courtType?: string; briefType?: string; judicialWorkType?: string; factsOrSubject?: string; } | string, userId?: string ): Promise<string> {
  let criteria: { courtType?: string; briefType?: string; judicialWorkType?: string; factsOrSubject?: string } = {};
  if (typeof searchCriteria === 'string') criteria = { courtType: searchCriteria };
  else if (searchCriteria) criteria = searchCriteria;

  const allAccountModels = await getModelsForStyle(userId);
  const models = findSimilarModels(criteria, userId, allAccountModels).filter((model) => isUsableReferenceContent(model.content));
  const requestedType = getRequestedDocumentType(criteria);
  const compatibleModels = requestedType && !isGenericJudicialTask(requestedType)
    ? models.filter((model) => modelMatchesRequestedType(model, requestedType, criteria.courtType || ''))
    : [];

  // Never let a known, different legal domain outrank an unclassified personal
  // model. If civil examples exist, prefer them over criminal/administrative
  // memos; use an unclassified model only when no domain-compatible model exists.
  const requestedDomains = requestedLegalDomains(criteria);
  const sameDomainModels = requestedDomains.length
    ? models.filter((model) => {
        const labels = [model.title, model.fileName, model.category, model.judicialWorkType, model.notes,
          String(model.content || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 18).join(' ')].filter(Boolean).join(' ');
        return legalDomains(labels).some((domain) => requestedDomains.includes(domain));
      })
    : [];
  const unknownDomainModels = requestedDomains.length
    ? models.filter((model) => {
        const labels = [model.title, model.fileName, model.category, model.judicialWorkType, model.notes,
          String(model.content || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 18).join(' ')].filter(Boolean).join(' ');
        return legalDomains(labels).length === 0;
      })
    : models;
  const domainEligibleModels = requestedDomains.length
    ? (sameDomainModels.length ? sameDomainModels : unknownDomainModels)
    : models;
  const domainEligibleIds = new Set(domainEligibleModels.map((model) => model.id));
  // Never let a nominal "memo" type-match override an explicit civil-domain
  // match with a criminal/unknown-domain document.
  const selectedModel = compatibleModels.find((model) => domainEligibleIds.has(model.id))
    || domainEligibleModels[0];
  if (!selectedModel) {
    if (allAccountModels.length === 0) {
      return '[الخزنة التي يقرأ منها التوليد فارغة لهذا الحساب، رغم أن الواجهة قد تعرض ملفات أصلية في قسم منفصل. لا تستخدم قالباً عاماً. تحقق من أن المستند حُفظ كنموذج نصي داخل خزنة هذا الحساب وبنفس معرّف الحساب.]';
    }
    if (models.length === 0) {
      return `[تم العثور على ${allAccountModels.length} نموذجاً في خزنة هذا الحساب، لكن نصوصها المستخرجة لا تحتوي على قدر كافٍ من النص العربي للاقتداء بالأسلوب. أعد استخراج النص أو احفظ نموذجاً نصياً أوضح؛ لن يُستخدم قالب عام.]`;
    }
    if (requestedDomains.length && domainEligibleModels.length === 0) {
      return `[تم العثور على ${models.length} نموذجاً نصياً صالحاً في خزنة الحساب، لكن تصنيفها القانوني لا يتوافق مع المجال المطلوب (${requestedDomains.join('، ')}). لن تُستخدم مذكرة من مجال مختلف بدلاً منها. أضف أو صنّف نموذجاً من المجال الصحيح.]`;
    }
    return `[تم العثور على ${models.length} نموذجاً صالحاً، لكن تعذر اختيار مرجع مناسب لنوع المستند الحالي. حدّد نوع المستند أو أضف نموذجاً من النوع المطلوب؛ لن يُستخدم قالب عام.]`;
  }

  const documentType = inferSafeModelType(selectedModel);
  const exactTypeMatch = compatibleModels.some((model) => model.id === selectedModel.id);
  const referenceText = buildPersonalReferenceText(selectedModel.content);
  const lawyerLetterhead = extractLawyerLetterhead(selectedModel.content);
  if (!referenceText) {
    return '[لا يوجد نص صالح في النموذج الشخصي المختار. لا تستخدم قالباً عاماً؛ اطلب نموذجاً آخر من خزنة الحساب.]';
  }

  const typeLine = requestedType
    ? `نوع المستند المطلوب: ${requestedType}.`
    : 'يُستنتج نوع المستند المطلوب من بيانات المهمة الحالية.';
  const matchLine = exactTypeMatch
    ? 'النموذج المرجعي متوافق مع نوع المستند المطلوب؛ اقتدِ ببنيته وترتيبه ما دام مناسباً للمهمة.'
    : `لم يوجد نموذج من النوع نفسه؛ النموذج الشخصي الأقرب في خزنة الحساب هو «${documentType}». خذ منه بصمة الكتابة والديباجة والانتقالات والإيقاع، واستعر ترتيب الأقسام فقط بقدر ملاءمته لنوع المستند المطلوب، ولا تستبدل نوع المستند الجديد بنوع المرجع.`;

  return `[بصمة أسلوب مستخلصة من خزنة الحساب]
[خزانة المحامي الشخصية — المرجع الأساسي والإلزامي للصياغة]
${typeLine}
${matchLine}
[معلومات المرجع]
- نوع النموذج: ${documentType}
- المصدر: مستند حقيقي محفوظ في خزنة هذا الحساب فقط.
- الأولوية: هذا النص المرجعي الشخصي أعلى من أي قالب عام أو أسلوب افتراضي.

[ترويسة المحامي المستخلصة من النموذج الشخصي — تُحافظ عليها كما هي إذا كانت موجودة]
<LAWYER_LETTERHEAD>
${lawyerLetterhead || 'لم يمكن فصل ترويسة مهنية مستقلة بأمان؛ استخلصها من بداية النموذج دون نقل بيانات القضية القديمة.'}
</LAWYER_LETTERHEAD>

[النص الأصلي للنموذج الشخصي — اقرأه كاملاً بوصفه مرجع أسلوب وبناء]
<LAWYER_VAULT_REFERENCE>
${referenceText}
</LAWYER_VAULT_REFERENCE>

[تعليمات إلزامية لاستخدام المرجع]
1) لا تكتب من قالب قانوني عام ولا تكتفِ بوصف نظري للأسلوب. إذا احتوى <LAWYER_LETTERHEAD> على ترويسة مهنية، ابدأ بها حرفياً دون تغيير اسم المحامي أو المكتب؛ لا تنقل منها أسماء الخصوم أو المحكمة أو رقم الدعوى أو أي بيانات تخص القضية القديمة. اقتدِ فعلياً بطريقة المحامي الظاهرة في النص: الديباجة، صياغة الجمل، تراكيب الربط، ترتيب عرض الوقائع، طريقة بناء الفقرة والحجة، الانتقال من واقعة إلى دليل ثم إلى أثرها، تسلسل الدفوع، العناوين، الخاتمة والطلبات.
2) اجعل الناتج يبدو مكتوباً بالطريقة نفسها التي كُتب بها النموذج المرجعي، مع إعادة بناء المضمون بالكامل على القضية الحالية. لا تنسخ فقرة موضوعية من المرجع لمجرد أنها تبدو مناسبة.
3) ممنوع نقل أي واقعة أو اسم طرف أو صفة أو عنوان أو رقم قضية أو تاريخ أو مبلغ أو مستند أو طلب أو دفع موضوعي أو مادة قانونية أو حكم أو رقم طعن خاص بالقضية القديمة. هذه البيانات لا تُستخدم إطلاقاً في المستند الجديد.
4) استمد بيانات القضية الجديدة حصراً من مدخلات المستخدم ومستنداته الحالية. إذا كانت بيانات الطرف أو المحكمة أو التاريخ غير متاحة، فلا تملأها من النموذج القديم ولا تضع بدلاً منها نجومًا أو حقولاً وهمية.
5) حافظ على الترويسة المهنية الخاصة بالمحامي واسم مكتبه وتوقيعه وبياناته المهنية كما تظهر في المرجع متى كانت واضحة بوصفها هوية المحامي صاحب الخزنة؛ فهذه جزء من بصمته وليست واقعة تخص الدعوى. أما أسماء الخصوم وصفاتهم والمحكمة والدائرة ورقم الدعوى والتواريخ والطلبات والوقائع فتؤخذ من القضية الحالية وحدها، ولا تستبقِ أي قيمة قديمة منها.
6) لا تستخدم قالباً عاماً بديلاً عند وجود نموذج شخصي في الخزنة. إذا لم توجد نماذج صالحة، لا تكتب المستند حتى يُضاف نموذج شخصي؛ أخبر المستخدم بذلك بوضوح.
7) لا تضع علامات Markdown مثل ** أو ## ولا تعليمات تحريرية داخل المستند النهائي. اكتب بالعربية القانونية، ولا تُدرج الإنجليزية إلا إذا كانت اسماً أو مصطلحاً ضرورياً في مستند القضية الحالية.
8) هذا السياق مخصص للصياغة والتفنيد والرد على المستندات وتحسين المسودات. لا يُستخدم في التكييف القانوني المستقل.`;
}
