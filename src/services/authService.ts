const SESSION_KEY = 'amin_platform_session';
const ADMIN_SESSION_KEY = 'amin_admin_session';

export interface PlatformUser {
  id: string;
  username: string;
  name: string;
  role: 'lawyer';
  credits: number;
  trialOperationsRemaining: number;
  trialExpiresAt: string;
  status: 'active' | 'suspended';
}

export function getAdminSessionToken(): string { try { return sessionStorage.getItem(ADMIN_SESSION_KEY) || ''; } catch { return ''; } }

function getApiErrorMessage(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) return value;
  if (value && typeof value === 'object') {
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.message === 'string' && candidate.message.trim()) return candidate.message;
    if (typeof candidate.error === 'string' && candidate.error.trim()) return candidate.error;
    try {
      const serialized = JSON.stringify(value);
      if (serialized && serialized !== '{}') return serialized;
    } catch {}
  }
  return fallback;
}

export async function loginAdmin(pin: string): Promise<string> {
  const res = await fetch('/api/auth/admin-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(getApiErrorMessage(data?.error, 'رمز المرور الإداري غير صحيح.'));
  if (!data?.token || typeof data.token !== 'string') {
    throw new Error(getApiErrorMessage(data?.error, 'استجابة تسجيل دخول الإدارة غير صالحة.'));
  }
  sessionStorage.setItem(ADMIN_SESSION_KEY, data.token);
  return data.token;
}

export function getSessionToken(): string {
  try { return localStorage.getItem(SESSION_KEY) || ''; } catch { return ''; }
}


export function getSessionExpiry(): number {
  const token = getSessionToken();
  if (!token) return 0;
  try {
    const payload = token.split('.')[0];
    const parsed = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=')));
    return Number(parsed?.exp || 0);
  } catch {
    return 0;
  }
}

export function saveSession(token: string) {
  localStorage.setItem(SESSION_KEY, token);
  try {
    const payload = token.split('.')[0];
    const parsed = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=')));
    if (parsed?.userId) localStorage.setItem('judicial_active_user_id', String(parsed.userId));
  } catch {}
}

function cacheUser(user: PlatformUser) {
  try {
    localStorage.setItem('amin_account_snapshot', JSON.stringify(user));
    localStorage.setItem('judicial_open_credits_v6', String(user.credits > 0 ? user.credits : user.trialOperationsRemaining));
  } catch {}
}

export function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem('amin_account_snapshot');
    localStorage.removeItem('judicial_open_credits_v6');
    localStorage.removeItem('judicial_active_user_id');
    // Do not delete another user's scoped vault blindly; the vault resolver
    // must switch to the authenticated user ID on the next login.
  } catch {}
}

async function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'application/json');
  const token = getSessionToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(path, { ...init, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error: any = new Error(getApiErrorMessage(data?.error, 'تعذر تنفيذ الطلب.'));
    error.statusCode = res.status;
    throw error;
  }
  return data;
}

export async function registerAccount(username: string, password: string, displayName: string, deviceFingerprint: string) {
  const data = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password, displayName, deviceFingerprint }),
  });
  saveSession(data.token);
  const user = data.user as PlatformUser; cacheUser(user); return user;
}

export async function loginAccount(username: string, password: string, deviceFingerprint: string) {
  const data = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password, deviceFingerprint }),
  });
  saveSession(data.token);
  const user = data.user as PlatformUser; cacheUser(user); return user;
}

export async function getCurrentAccount(): Promise<PlatformUser> {
  const data = await request('/api/auth/me');
  const user = data.user as PlatformUser; cacheUser(user); return user;
}

export async function consumeOperation(serviceName: string) {
  const data = await request('/api/auth/consume', {
    method: 'POST',
    body: JSON.stringify({ serviceName }),
  });
  try {
    const raw = localStorage.getItem('amin_account_snapshot');
    const current = raw ? JSON.parse(raw) : {};
    current.credits = Number(data.remainingCredits || 0);
    current.trialOperationsRemaining = Number(data.trialRemaining || 0);
    localStorage.setItem('amin_account_snapshot', JSON.stringify(current));
    localStorage.setItem('judicial_open_credits_v6', String(current.credits > 0 ? current.credits : current.trialOperationsRemaining));
  } catch {}
  return data;
}

export async function redeemRechargeCode(code: string) {
  const data = await request('/api/auth/redeem', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
  try {
    const raw = localStorage.getItem('amin_account_snapshot');
    const current = raw ? JSON.parse(raw) : {};
    current.credits = Number(data.newTotal || 0);
    current.status = 'active';
    localStorage.setItem('amin_account_snapshot', JSON.stringify(current));
    localStorage.setItem('judicial_open_credits_v6', String(current.credits));
  } catch {}
  return data;
}
