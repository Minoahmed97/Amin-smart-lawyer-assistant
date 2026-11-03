import { EGYPTIAN_LEGAL_DEFENSES } from '../data/egyptianDefenses.ts';

export interface SavedOnlineDefense {
  id: string;
  name: string;
  category: string;
  summary: string;
  legalBasis: string;
  draftingSnippet: string;
  sourceTitle: string;
  sourceUrl: string;
  savedAt: string;
}

function storageKey(userId?: string): string {
  const safeUserId = String(userId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `amin_legal_defenses_online_${safeUserId}`;
}

export function getSavedOnlineDefenses(userId?: string): SavedOnlineDefense[] {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item) =>
      item && typeof item.id === 'string' && typeof item.draftingSnippet === 'string'
    ) : [];
  } catch {
    return [];
  }
}

export function saveOnlineDefense(defense: Omit<SavedOnlineDefense, 'id' | 'savedAt'> & { id?: string }, userId?: string): SavedOnlineDefense[] {
  const current = getSavedOnlineDefenses(userId);
  const sourceUrl = String(defense.sourceUrl || '').trim();
  const duplicate = current.some((item) =>
    (sourceUrl && item.sourceUrl === sourceUrl && item.name === defense.name) ||
    item.draftingSnippet === defense.draftingSnippet
  );
  if (duplicate) return current;
  const next: SavedOnlineDefense[] = [{
    ...defense,
    id: defense.id || `online-defense-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    savedAt: new Date().toISOString(),
  }, ...current];
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(next));
    return next;
  } catch {
    throw new Error('تعذر حفظ الدفع على هذا الجهاز؛ قد تكون مساحة التخزين ممتلئة.');
  }
}

export function getLegalDefenseLibraryContext(userId?: string): string {
  const saved = getSavedOnlineDefenses(userId);
  const builtIn = EGYPTIAN_LEGAL_DEFENSES.map((item) => ({
    name: item.name,
    category: item.category,
    legalBasis: item.legalBasis,
    cassationRule: item.cassationRule,
    draftingSnippet: item.draftingSnippet,
    source: 'الموسوعة الأصلية المدمجة بالتطبيق',
  }));
  const custom = saved.map((item) => ({
    name: item.name,
    category: item.category,
    legalBasis: item.legalBasis,
    cassationRule: '',
    draftingSnippet: item.draftingSnippet,
    source: item.sourceTitle,
    sourceUrl: item.sourceUrl,
  }));
  const entries = [...builtIn, ...custom];
  return entries.slice(0, 80).map((item, index) =>
    `${index + 1}) ${item.name} [${item.category}]\nالسند/الملخص: ${item.legalBasis}\nالمبدأ: ${item.cassationRule || 'غير متاح'}\nصيغة الاسترشاد: ${item.draftingSnippet}\nالمصدر: ${item.source}${item.sourceUrl ? ` — ${item.sourceUrl}` : ''}`
  ).join('\n\n').slice(0, 24000);
}
