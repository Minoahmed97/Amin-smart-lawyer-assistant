/**
 * settings.ts
 * Unified helper for key validation and settings.
 */
export function isValidGeminiApiKey(key: any): boolean {
  if (!key || typeof key !== 'string') return false;
  const trimmed = key.trim();
  if (
    !trimmed ||
    trimmed === 'MY_GEMINI_API_KEY' ||
    trimmed.includes('MY_GEMINI') ||
    trimmed.includes('...') ||
    trimmed === 'undefined' ||
    trimmed === 'null' ||
    trimmed.length < 10
  ) {
    return false;
  }
  return true;
}
