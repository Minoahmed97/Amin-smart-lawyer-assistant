import { requestJson } from './httpClient.ts';

const SESSION_KEY = 'amin_platform_session';
const ADMIN_SESSION_KEY = 'amin_admin_session';

export interface PlatformUser {
  id: string;
  username: string;
  name: string;
  role: 'lawyer';
  status: 'active' | 'suspended';
}

export function getAdminSessionToken(): string {
  try { return sessionStorage.getItem(ADMIN_SESSION_KEY) || ''; } catch { return ''; }
}

export async function loginAdmin(pin: string): Promise<string> {
  const data = await requestJson<{ token?: unknown }>('/api/auth/admin-login', {
    method: 'POST',
    body: JSON.stringify({ pin }),
  }, {
    fallbackErrorMessage: 'رمز المرور الإداري غير صحيح.',
  });

  if (typeof data?.token !== 'string' || !data.token) {
    throw new Error('استجابة تسجيل دخول الإدارة غير صالحة.');
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
  } catch {}
}

export function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem('amin_account_snapshot');
    localStorage.removeItem('judicial_open_credits_v6');
    localStorage.removeItem('judicial_active_user_id');
    // Preserve user-scoped vault data; the next login resolves its own user ID.
  } catch {}
}

async function request<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<T> {
  return requestJson<T>(path, init, {
    token: getSessionToken(),
    fallbackErrorMessage: 'تعذر تنفيذ الطلب.',
  });
}

export async function registerAccount(username: string, password: string, displayName: string, deviceFingerprint: string) {
  const data = await request<{ token: string; user: PlatformUser }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password, displayName, deviceFingerprint }),
  });
  saveSession(data.token);
  const user = data.user as PlatformUser;
  cacheUser(user);
  return user;
}

export async function loginAccount(username: string, password: string, deviceFingerprint: string) {
  const data = await request<{ token: string; user: PlatformUser }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password, deviceFingerprint }),
  });
  saveSession(data.token);
  const user = data.user as PlatformUser;
  cacheUser(user);
  return user;
}

export async function getCurrentAccount(): Promise<PlatformUser> {
  const data = await request<{ user: PlatformUser }>('/api/auth/me');
  const user = data.user as PlatformUser;
  cacheUser(user);
  return user;
}

export async function consumeOperation(serviceName: string) {
  return await request('/api/auth/consume', {
    method: 'POST',
    body: JSON.stringify({ serviceName }),
  });
}

export async function redeemRechargeCode(code: string) {
  return await request('/api/auth/redeem', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}
