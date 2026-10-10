/** * Browser-safe Gemini key input validation only. * * This module must never contain API credentials or call Google/Gemini. * Actual Gemini requests and secret-key management are handled by /api on * the server. The browser may send an administrator-entered key only to the * authenticated platform API for storage/testing. */
export function sanitizeGeminiKey(rawKey: unknown): string {
  if (typeof rawKey !== 'string') return '';

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

export function isValidKeyFormat(rawKey: unknown): boolean {
  const clean = sanitizeGeminiKey(rawKey);
  if (!clean || clean.length < 10) return false;
  if (!clean.startsWith('AQ.') && !clean.startsWith('AIza')) return false;
  return !(
    clean === 'MY_GEMINI_API_KEY' ||
    clean.includes('MY_GEMINI') ||
    clean.includes('...') ||
    clean === 'undefined' ||
    clean === 'null'
  );
}
