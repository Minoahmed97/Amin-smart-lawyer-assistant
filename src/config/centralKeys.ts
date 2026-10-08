/**
 * Central Keys Configuration
 */
export const EMBEDDED_GEMINI_KEYS: string[] = [
  // Embedded fallback keys if any
];

export function sanitizeGeminiKey(rawKey: any): string {
  if (!rawKey || typeof rawKey !== 'string') return '';
  let clean = rawKey
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B-\u200D\u2060]/g, '')
    .trim();

  if (
    (clean.startsWith('"') && clean.endsWith('"')) ||
    (clean.startsWith("'") && clean.endsWith("'")) ||
    (clean.startsWith('`') && clean.endsWith('`'))
  ) {
    clean = clean.slice(1, -1).trim();
  }

  return clean;
}

export function isValidKeyFormat(rawKey: any): boolean {
  const clean = sanitizeGeminiKey(rawKey);
  if (!clean || clean.length < 10) return false;
  if (
    clean === 'MY_GEMINI_API_KEY' ||
    clean.includes('MY_GEMINI') ||
    clean.includes('...') ||
    clean === 'undefined' ||
    clean === 'null'
  ) {
    return false;
  }
  return true;
}

export function getEmbeddedGeminiKeys(): string[] {
  return EMBEDDED_GEMINI_KEYS.map((k) => sanitizeGeminiKey(k)).filter((k) => isValidKeyFormat(k));
}
