import { PlatformPackage } from '../types.ts';
import {
  consumeTrialAction,
  addDeviceCredits,
  setDeviceCreditsAbsolute,
} from './deviceFingerprint.ts';
import { persistentStorage } from './persistentStorage.ts';
import { consumeOperation, getAdminSessionToken } from '../services/authService.ts';

const PACKAGES_STORAGE_KEY = 'judicial_managed_packages_v3';
const RECHARGE_HISTORY_KEY = 'judicial_recharge_history_v3';

export const DEFAULT_PACKAGES: PlatformPackage[] = [
  {
    id: 'pkg_15',
    name: 'باقة 15 عملية قضائية',
    credits: 15,
    price: '225 جنيه',
    numericPrice: 225,
    badge: 'أساسية',
    description: '15 عملية قضائية — 15 جنيه للعملية الواحدة.',
    features: ['15 عملية قضائية', 'رفع وتحليل المستندات', 'البث المباشر للإجابة'],
    enabled: true,
  },
  {
    id: 'pkg_30',
    name: 'باقة 30 عملية قضائية',
    credits: 30,
    price: '450 جنيه',
    numericPrice: 450,
    badge: 'الأكثر طلباً',
    popular: true,
    description: '30 عملية قضائية — 15 جنيه للعملية الواحدة.',
    features: ['30 عملية قضائية', 'رفع وتحليل المستندات', 'البث المباشر للإجابة'],
    enabled: true,
  },
  {
    id: 'pkg_60',
    name: 'باقة 60 عملية قضائية',
    credits: 60,
    price: '900 جنيه',
    numericPrice: 900,
    badge: 'مكاتب',
    description: '60 عملية قضائية — 15 جنيه للعملية الواحدة.',
    features: ['60 عملية قضائية', 'رفع وتحليل المستندات', 'البث المباشر للإجابة'],
    enabled: true,
  },
];

/**
 * Loads current packages from multi-tier storage with default fallback.
 */
export function getManagedPackages(): PlatformPackage[] {
  try {
    const parsed = persistentStorage.getJSON<PlatformPackage[]>(PACKAGES_STORAGE_KEY);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed;
    }
  } catch (e) {
    console.warn('Failed to parse managed packages from storage:', e);
  }
  return DEFAULT_PACKAGES;
}

/**
 * Synchronizes packages from the centralized server database/file.
 * Updates local cache and notifies all application components.
 */
export async function fetchRemotePackages(): Promise<PlatformPackage[]> {
  try {
    const res = await fetch('/api/admin/packages', { headers: { 'x-admin-session': getAdminSessionToken() } });
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.packages) && data.packages.length > 0) {
        persistentStorage.setJSON(PACKAGES_STORAGE_KEY, data.packages);
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent('judicial_packages_updated', { detail: { packages: data.packages } })
          );
        }
        return data.packages;
      }
    }
  } catch (err) {
    console.warn('Could not fetch packages from server, using local copy:', err);
  }
  return getManagedPackages();
}

/**
 * Saves packages globally on the server and synchronizes all local clients.
 */
export async function saveManagedPackages(packages: PlatformPackage[]): Promise<PlatformPackage[]> {
  try {
    const res = await fetch('/api/admin/packages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-session': getAdminSessionToken() },
      body: JSON.stringify({ packages }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.packages) {
      throw new Error(data?.error || 'تعذر حفظ الباقات على الخادم المركزي.');
    }
    persistentStorage.setJSON(PACKAGES_STORAGE_KEY, data.packages);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('judicial_packages_updated', { detail: { packages: data.packages } }));
    }
    return data.packages;
  } catch (err: any) {
    console.warn('Could not sync packages to server:', err);
    throw err;
  }
}

/**
 * Resets packages to factory defaults globally across the entire platform.
 */
export async function resetPlatformPackagesToDefaults(): Promise<PlatformPackage[]> {
  try {
    const res = await fetch('/api/admin/packages/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-session': getAdminSessionToken() },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.packages) {
      throw new Error(data?.error || 'تعذر استعادة الباقات على الخادم المركزي.');
    }
    persistentStorage.setJSON(PACKAGES_STORAGE_KEY, data.packages);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('judicial_packages_updated', { detail: { packages: data.packages } }));
    }
    return data.packages;
  } catch (err: any) {
    console.warn('Server reset failed:', err);
    throw err;
  }
}

export async function deductServiceOperation(serviceName: string): Promise<{
  success: boolean;
  remainingCredits: number;
  message: string;
}> {
  try {
    const result = await consumeOperation(serviceName);
    const remaining = Number(result.remainingCredits || 0);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('judicial_credits_change', { detail: { credits: remaining } }));
    }
    return {
      success: true,
      remainingCredits: remaining,
      message: result.message || `تم خصم عملية لخدمة [${serviceName}]. المتبقي: ${remaining}.`,
    };
  } catch (e: any) {
    return {
      success: false,
      remainingCredits: 0,
      message: e?.message || 'تعذر خصم العملية من الخادم.',
    };
  }
}

export function rechargeUserBalance(amount: number, reason: string = 'شحن يدوي'): {
  newTotal: number;
  added: number;
} {
  const newTotal = addDeviceCredits(amount);
  try {
    const history = JSON.parse(localStorage.getItem(RECHARGE_HISTORY_KEY) || '[]');
    history.unshift({
      date: new Date().toISOString(),
      amount,
      reason,
      balanceAfter: newTotal,
    });
    localStorage.setItem(RECHARGE_HISTORY_KEY, JSON.stringify(history.slice(0, 50)));
  } catch {}
  return { newTotal, added: amount };
}

export function setExactUserBalance(amount: number): number {
  return setDeviceCreditsAbsolute(amount);
}

export function getRechargeHistory(): Array<{
  date: string;
  amount: number;
  reason: string;
  balanceAfter: number;
}> {
  try {
    const raw = localStorage.getItem(RECHARGE_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
