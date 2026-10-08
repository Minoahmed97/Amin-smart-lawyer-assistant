export const EMBEDDED_GEMINI_KEYS: string[] = [
  // Optional embedded keys
];

export function sanitizeGeminiKey(rawKey: any): string {
  if (!rawKey || typeof rawKey !== 'string') return '';
  // Keys copied from AI Studio may arrive wrapped in quotes/backticks or with
  // invisible BOM/zero-width characters. Remove only transport/copy artifacts;
  // never rewrite the actual credential (for example, never turn `A...` into
  // an invented `AQ...` value).
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

  // AI Studio currently issues AQ. authorization keys; legacy AIza keys can
  // still exist. Keep the validator compatible with both formats.
  return clean;
}

export function isValidKeyFormat(rawKey: any): boolean {
  const clean = sanitizeGeminiKey(rawKey);
  if (!clean || clean.length < 10) return false;
  if (!clean.startsWith('AQ.') && !clean.startsWith('AIza')) return false;
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

export default function handler(req: any, res: any) {
  return res.status(200).json({ ok: true });
}

