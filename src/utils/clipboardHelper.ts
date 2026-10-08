/**
 * Safe clipboard copy utility with fallback for iframes and older browsers.
 */
export async function copyTextSafely(text: string): Promise<boolean> {
  if (!text) return false;

  // 1. Try modern navigator.clipboard if available
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Continue to fallback
    }
  }

  // 2. Fallback using temporary textarea
  try {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';
    textArea.setAttribute('readonly', '');
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    const successful = document.execCommand('copy');
    textArea.remove();
    return successful;
  } catch (err) {
    console.error('Safe copy failed:', err);
    return false;
  }
}

/**
 * Shared mobile/desktop document share handler with fallback to safe clipboard copy.
 */
export async function shareLegalDoc(
  text: string,
  title: string = 'صياغة قانونية قضائية',
  onCopiedFallback?: () => void
): Promise<void> {
  if (!text) return;
  if (navigator.share) {
    try {
      await navigator.share({
        title,
        text,
      });
      return;
    } catch {
      // User cancelled or unsupported content, fallback to copy
    }
  }
  const copied = await copyTextSafely(text);
  if (copied && onCopiedFallback) {
    onCopiedFallback();
  }
}
