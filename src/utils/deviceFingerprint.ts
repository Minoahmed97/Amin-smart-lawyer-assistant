const DEVICE_STORAGE_KEY = '_judicial_device_uuid_v6';
const TRIAL_EXHAUSTED_KEY = '_judicial_trial_exhausted_v6';
const TRIAL_USAGE_COUNT_KEY = '_judicial_device_trial_count_v6';
const CREDITS_STORAGE_KEY = 'judicial_open_credits_v6';

export const INITIAL_FREE_CREDITS = 0;
export type UserRole = 'lawyer';
export const USER_ROLE_KEY = '_judicial_user_role';
export const LAWYER_CARD_NUMBER_KEY = '_judicial_lawyer_card_number_v6';
export const LAWYER_DEGREE_KEY = '_judicial_lawyer_degree_v6';

export interface LawyerVerificationData {
  cardNumber: string;
  degree: string;
}

export function getLawyerVerification(): LawyerVerificationData | null {
  try {
    const cardNumber = localStorage.getItem(LAWYER_CARD_NUMBER_KEY);
    if (!cardNumber || cardNumber.trim().length < 4) return null;
    const degree = localStorage.getItem(LAWYER_DEGREE_KEY) || 'نقض';
    return { cardNumber: cardNumber.trim(), degree };
  } catch {
    return null;
  }
}

export function setLawyerVerification(cardNumber: string, degree: string = 'نقض'): void {
  try {
    localStorage.setItem(LAWYER_CARD_NUMBER_KEY, cardNumber.trim());
    localStorage.setItem(LAWYER_DEGREE_KEY, degree);
  } catch (e) {
    console.warn('Error setting lawyer verification:', e);
  }
}

export function clearLawyerVerification(): void {
  try {
    localStorage.removeItem(LAWYER_CARD_NUMBER_KEY);
    localStorage.removeItem(LAWYER_DEGREE_KEY);
  } catch (e) {
    console.warn('Error clearing lawyer verification:', e);
  }
}

export function isLawyerVerified(): boolean {
  const role = getUserRole();
  if (role !== 'lawyer') return false;
  const ver = getLawyerVerification();
  if (!ver || !ver.cardNumber) return false;
  const num = parseInt(ver.cardNumber, 10);
  // Condition: Lawyer bar registration number must be 500,000 or greater
  return !isNaN(num) && num >= 500000;
}

export function getUserRole(): UserRole | null {
  try {
    const role = localStorage.getItem(USER_ROLE_KEY);
    if (role === 'lawyer') return role;
    return null;
  } catch {
    return null;
  }
}

export function setUserRole(role: UserRole): void {
  try {
    localStorage.setItem(USER_ROLE_KEY, role);
    window.dispatchEvent(new CustomEvent('judicial_role_change', { detail: { role } }));
  } catch (e) {
    console.warn('Error setting user role:', e);
  }
}

export async function getDeviceFingerprint(): Promise<string> {
  let persistentId = '';
  try {
    persistentId = localStorage.getItem(DEVICE_STORAGE_KEY) || '';
    if (!persistentId) {
      persistentId = 'dev_' + Math.random().toString(36).substring(2, 10) + '_' + Date.now().toString(36);
      localStorage.setItem(DEVICE_STORAGE_KEY, persistentId);
    }
  } catch {
    persistentId = 'dev_temp_' + Date.now().toString(36);
  }

  const nav = typeof navigator !== 'undefined' ? navigator : ({} as any);
  const scr = typeof screen !== 'undefined' ? screen : ({} as any);
  const userAgent = nav.userAgent || 'unknown';
  const screenResolution = `${scr.width || 0}x${scr.height || 0}x${scr.colorDepth || 0}`;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Africa/Cairo';

  // Server-side account binding intentionally uses stable browser/device traits rather than
  // a random localStorage identifier that can be copied between accounts.
  const rawString = `${screenResolution}|${timeZone}|${userAgent}`;
  let hash = 0;
  for (let i = 0; i < rawString.length; i++) {
    hash = (hash << 5) - hash + rawString.charCodeAt(i);
    hash |= 0;
  }
  return `EGY-${Math.abs(hash).toString(16).toUpperCase()}`;
}

export function setCachedAccountCredits(credits: number): void {
  try {
    const safe = Math.max(0, Number(credits) || 0);
    localStorage.setItem(CREDITS_STORAGE_KEY, String(safe));
    window.dispatchEvent(new CustomEvent('judicial_credits_change', { detail: { credits: safe } }));
  } catch {}
}

export function getCurrentStoredCredits(): number {
  try {
    const saved = localStorage.getItem(CREDITS_STORAGE_KEY);
    if (saved !== null) {
      const val = parseInt(saved, 10);
      return isNaN(val) ? 0 : Math.max(0, val);
    }
    localStorage.setItem(CREDITS_STORAGE_KEY, String(INITIAL_FREE_CREDITS));
    return INITIAL_FREE_CREDITS;
  } catch {
    return INITIAL_FREE_CREDITS;
  }
}

export function isDeviceTrialExhausted(): boolean {
  try {
    const credits = getCurrentStoredCredits();
    if (credits > 0) return false;
    return localStorage.getItem(TRIAL_EXHAUSTED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function markDeviceTrialExhausted(): void {
  try {
    localStorage.setItem(TRIAL_EXHAUSTED_KEY, 'true');
    localStorage.setItem(CREDITS_STORAGE_KEY, '0');
    window.dispatchEvent(new CustomEvent('judicial_credits_change', { detail: { credits: 0 } }));
  } catch (e) {
    console.warn('LocalStorage error:', e);
  }
}

export async function consumeTrialAction(): Promise<{
  allowed: boolean;
  remaining: number;
  fingerprint: string;
}> {
  const fingerprint = await getDeviceFingerprint();
  const currentCredits = getCurrentStoredCredits();

  if (currentCredits <= 0) {
    markDeviceTrialExhausted();
    return { allowed: false, remaining: 0, fingerprint };
  }

  const nextCredits = Math.max(0, currentCredits - 1);
  try {
    localStorage.setItem(CREDITS_STORAGE_KEY, String(nextCredits));
    const usedCount = parseInt(localStorage.getItem(TRIAL_USAGE_COUNT_KEY) || '0', 10) + 1;
    localStorage.setItem(TRIAL_USAGE_COUNT_KEY, String(usedCount));

    if (nextCredits === 0) {
      localStorage.setItem(TRIAL_EXHAUSTED_KEY, 'true');
    }

    window.dispatchEvent(
      new CustomEvent('judicial_credits_change', { detail: { credits: nextCredits } })
    );

    return {
      allowed: true,
      remaining: nextCredits,
      fingerprint,
    };
  } catch {
    return {
      allowed: true,
      remaining: nextCredits,
      fingerprint,
    };
  }
}

export function addDeviceCredits(amount: number): number {
  try {
    const current = getCurrentStoredCredits();
    const updated = current + amount;
    localStorage.setItem(CREDITS_STORAGE_KEY, String(updated));
    localStorage.removeItem(TRIAL_EXHAUSTED_KEY);
    window.dispatchEvent(
      new CustomEvent('judicial_credits_change', { detail: { credits: updated } })
    );
    return updated;
  } catch {
    return amount;
  }
}

export function setDeviceCreditsAbsolute(amount: number): number {
  try {
    const safeAmount = Math.max(0, amount);
    localStorage.setItem(CREDITS_STORAGE_KEY, String(safeAmount));
    if (safeAmount > 0) {
      localStorage.removeItem(TRIAL_EXHAUSTED_KEY);
    } else {
      localStorage.setItem(TRIAL_EXHAUSTED_KEY, 'true');
    }
    window.dispatchEvent(
      new CustomEvent('judicial_credits_change', { detail: { credits: safeAmount } })
    );
    return safeAmount;
  } catch {
    return amount;
  }
}
