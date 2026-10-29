import crypto from 'node:crypto';
import { rateLimit, getClientIp, getRegistrationGuardKey } from './security.ts';

type Json = Record<string, any>;

function getSupabaseConfig() {
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
  const key = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim();
  if (!url || !key) throw new Error('إعدادات Supabase المركزية غير مكتملة على الخادم.');
  return { url, key };
}

function hashPassword(password: string, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string) {
  const [salt, expected] = String(stored || '').split(':');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64).toString('hex');
  return expected.length === actual.length && crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function sessionSecret() {
  const secret = (process.env.APP_ENCRYPTION_KEY || '').trim();
  if (secret.length < 32) throw new Error('APP_ENCRYPTION_KEY غير مضبوط أو قصير على الخادم.');
  return secret;
}

// User sessions last 30 minutes by default; the heartbeat refreshes them while active.
export function createSession(userId: string, username: string, ttlMs = 1000 * 60 * 30) {
  const payload = Buffer.from(JSON.stringify({
    userId,
    username,
    exp: Date.now() + ttlMs,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function readSession(token: string | undefined) {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!parsed.userId || !parsed.exp || Date.now() > parsed.exp) return null;
    return parsed as { userId: string; username: string; exp: number };
  } catch {
    return null;
  }
}

function getBearer(req: any) {
  const auth = String(req?.headers?.authorization || '');
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
}

export function requireSession(req: any) {
  const session = readSession(getBearer(req));
  if (!session) { const err: any = new Error('انتهت جلسة الحساب. يرجى تسجيل الدخول من جديد.'); err.statusCode = 401; throw err; }
  return session;
}

export async function requireActiveSession(req: any) {
  const session = requireSession(req);
  const res = await supabase(`platform_users?select=id,account_status,trial_expires_at,credits,trial_operations_total,trial_operations_used&id=eq.${encodeURIComponent(session.userId)}&limit=1`);
  if (!res.ok) throw new Error('تعذر التحقق من حالة الحساب.');
  const user = (await res.json())?.[0];
  if (!user || user.account_status !== 'active') { const err: any = new Error('الحساب غير نشط أو موقوف.'); err.statusCode = 403; throw err; }
  const trialRemaining = Math.max(0, Number(user.trial_operations_total || 0) - Number(user.trial_operations_used || 0));
  const trialValid = user.trial_expires_at && Date.now() < Date.parse(user.trial_expires_at) && trialRemaining > 0;
  if (Number(user.credits || 0) <= 0 && !trialValid) {
    const err: any = new Error('انتهى رصيد/تجربة الحساب.');
    err.statusCode = 402;
    throw err;
  }
  return { session, user };
}

/**
 * Additive persistent protection against switching between AI endpoints to
 * evade aggregate usage limits. Existing per-endpoint rateLimit calls,
 * session checks, credit checks and operation accounting remain in place.
 * The configured account bypasses these NEW aggregate limits only.
 */
async function consumePersistentRateLimit(scope: string, identity: string, limit: number, windowMs: number, req?: any) {
  const safeScope = String(scope || '').slice(0, 120);
  const windowSeconds = Math.max(1, Math.ceil(windowMs / 1000));
  const subjectHash = crypto.createHmac('sha256', sessionSecret()).update(`${safeScope}|${identity}`).digest('hex');
  const response = await supabase('rpc/consume_platform_rate_limit', {
    method: 'POST',
    body: JSON.stringify({
      p_scope: safeScope,
      p_subject_hash: subjectHash,
      p_limit: Math.max(1, Math.floor(limit)),
      p_window_seconds: windowSeconds,
    }),
  });

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    // If the migration has not been installed, keep the existing local limiter
    // rather than blocking all existing service calls during rollout.
    if (/PGRST202|Could not find the function|schema cache|consume_platform_rate_limit/i.test(details)) {
      // Existing endpoint/admin rate limits remain active at their original call sites.
      return;
    }
    const error: any = new Error('تعذر التحقق من حدود الاستخدام الآمنة. حاول مرة أخرى لاحقاً.');
    error.statusCode = 503;
    throw error;
  }

  const decision = await response.json();
  if (decision?.allowed === false) {
    const retryAfter = Math.max(1, Number(decision?.retryAfter || 1));
    const error: any = new Error('وصل الحساب إلى حد الاستخدام المؤقت لخدمات الذكاء الاصطناعي. يرجى الانتظار ثم المحاولة مجدداً.');
    error.statusCode = 429;
    error.retryAfter = retryAfter;
    throw error;
  }
}

function isAiRateLimitExempt(session: { userId: string }): boolean {
  const exemptId = (process.env.AI_RATE_LIMIT_EXEMPT_USER_ID || '').trim();
  return Boolean(exemptId && session.userId === exemptId);
}

/**
 * The old 30-second cooldown stays disabled. Existing per-endpoint limits and
 * all original account/credit checks remain intact; only aggregate limits are added.
 */
export async function enforceAiCooldown(req: any, validatedSession?: { userId: string }) {
  const session = validatedSession || (await requireActiveSession(req)).session;
  if (!isAiRateLimitExempt(session)) {
    await consumePersistentRateLimit('ai-global-10m', session.userId, 5, 10 * 60 * 1000, req);
    await consumePersistentRateLimit('ai-global-24h', session.userId, 50, 24 * 60 * 60 * 1000, req);
  }
  return { session };
}

export function createAdminSession() {
  const configured = (process.env.PLATFORM_ADMIN_PIN || '').trim();
  if (!configured) throw new Error('PLATFORM_ADMIN_PIN غير مضبوط على الخادم.');
  // Admin sessions are intentionally shorter-lived than user sessions.
  return createSession('admin', 'admin', 1000 * 60 * 30);
}

export function requireAdmin(req: any) {
  const configured = (process.env.PLATFORM_ADMIN_PIN || '').trim();
  if (!configured) throw new Error('PLATFORM_ADMIN_PIN غير مضبوط على الخادم.');
  const token = String(req?.headers?.['x-admin-session'] || '');
  const session = readSession(token);
  if (!session || session.userId !== 'admin') { const err: any = new Error('غير مصرح بإجراء الإدارة.'); err.statusCode = 403; throw err; }
}


function constantTimeStringEqual(candidate: string, expected: string): boolean {
  const candidateBytes = Buffer.from(candidate, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  // timingSafeEqual throws for different lengths; compare fixed-size hashes instead.
  const candidateHash = crypto.createHash('sha256').update(candidateBytes).digest();
  const expectedHash = crypto.createHash('sha256').update(expectedBytes).digest();
  const sameHash = crypto.timingSafeEqual(candidateHash, expectedHash);
  return sameHash && candidateBytes.length === expectedBytes.length;
}

export async function loginAdmin(pin: string, req?: any) {
  const configured = (process.env.PLATFORM_ADMIN_PIN || '').trim();
  const candidate = typeof pin === 'string' ? pin.trim() : '';
  const valid = Boolean(configured) && constantTimeStringEqual(candidate, configured);
  if (req) {
    await consumePersistentRateLimit('admin-login', getClientIp(req), 8, 15 * 60 * 1000, req);
    rateLimit(req, 'admin-login', 8, 15 * 60 * 1000, { failure: !valid });
  }
  if (!valid) { const err: any = new Error('رمز المرور الإداري غير صحيح.'); err.statusCode = 401; throw err; }
  return { token: createAdminSession() };
}

async function supabase(path: string, init: RequestInit = {}) {
  const { url, key } = getSupabaseConfig();
  // Supabase's new `sb_secret_*` API keys are not JWTs and must not be
  // sent as `Authorization: Bearer ...`. Legacy service_role keys are JWTs,
  // so keep the Authorization header for those.
  const headers: Record<string, string> = {
    apikey: key,
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  };
  if (!key.startsWith('sb_')) {
    headers.Authorization = `Bearer ${key}`;
  }
  return fetch(`${url}/rest/v1/${path}`, { ...init, headers });
}

async function findUser(username: string) {
  const res = await supabase(`platform_users?select=*&username=eq.${encodeURIComponent(username)}&limit=1`);
  if (!res.ok) {
    const details = (await res.text()).replace(/\b(?:sb_(?:secret|publishable)|eyJ)[A-Za-z0-9._-]+/g, '[REDACTED]').slice(0, 220);
    throw new Error(`تعذر قراءة الحسابات (${res.status})${details ? `: ${details}` : '.'}`);
  }
  const rows = await res.json();
  return Array.isArray(rows) ? rows[0] : null;
}

async function findDevice(deviceFingerprint: string) {
  const res = await supabase(`platform_users?select=id,username&device_fingerprint=eq.${encodeURIComponent(deviceFingerprint)}&limit=1`);
  if (!res.ok) throw new Error(`تعذر فحص الجهاز (${res.status}).`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows[0] : null;
}

async function claimRegistrationGuard(guardKey: string): Promise<boolean> {
  const res = await supabase('registration_guards', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ guard_key: guardKey }),
  });

  if (res.status === 409) return false;
  if (!res.ok) throw new Error(`تعذر تفعيل حماية التسجيل (${res.status}).`);
  return true;
}

async function releaseRegistrationGuard(guardKey: string): Promise<void> {
  try {
    await supabase(`registration_guards?guard_key=eq.${encodeURIComponent(guardKey)}`, {
      method: 'DELETE',
    });
  } catch {}
}

export async function registerAccount(username: string, password: string, displayName: string, deviceFingerprint: string, req?: any) {
  const cleanUsername = username.trim().toLowerCase();
  const cleanName = displayName.trim() || cleanUsername;
  if (!/^[a-zA-Z0-9_.-]{4,32}$/.test(cleanUsername)) {
    throw new Error('اسم المستخدم يجب أن يكون من 4 إلى 32 حرفاً أو رقماً.');
  }
  if (password.length < 8) throw new Error('كلمة المرور يجب ألا تقل عن 8 أحرف.');
  if (!/^EGY-[A-F0-9]+$/i.test(deviceFingerprint)) throw new Error('تعذر التحقق من الجهاز.');

  if (await findUser(cleanUsername)) throw new Error('اسم المستخدم مستخدم بالفعل.');
  const existingDevice = await findDevice(deviceFingerprint);
  if (existingDevice) throw new Error('هذا الجهاز مرتبط بحساب بالفعل. لا يمكن إنشاء حساب ثانٍ من نفس الجهاز.');

  // Persistent server-side guard: clearing localStorage or changing the
  // username must not grant another free trial from the same browser/device.
  const guardKey = req ? getRegistrationGuardKey(req, deviceFingerprint) : '';
  if (guardKey && !(await claimRegistrationGuard(guardKey))) {
    throw new Error('تم استخدام العرض المجاني من هذا الجهاز بالفعل. لا يمكن إنشاء حساب مجاني ثانٍ.');
  }

  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const row = {
    username: cleanUsername,
    display_name: cleanName,
    password_hash: hashPassword(password),
    device_fingerprint: deviceFingerprint,
    role: 'lawyer',
    credits: 0,
    trial_operations_total: 20,
    trial_operations_used: 0,
    trial_started_at: now,
    trial_expires_at: expires,
    account_status: 'active',
    created_at: now,
    updated_at: now,
  };

  const res = await supabase('platform_users', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    if (guardKey) await releaseRegistrationGuard(guardKey);
    const err = await res.text();
    throw new Error(`تعذر إنشاء الحساب (${res.status}): ${err.slice(0, 180)}`);
  }
  const created = (await res.json())?.[0];
  if (!created?.id) throw new Error('لم يتم إنشاء الحساب بشكل صحيح.');
  return {
    token: createSession(created.id, cleanUsername),
    user: {
      id: created.id,
      username: created.username,
      name: created.display_name,
      role: 'lawyer',
      credits: Number(created.credits || 0),
      trialOperationsRemaining: Math.max(0, Number(created.trial_operations_total || 20) - Number(created.trial_operations_used || 0)),
      trialExpiresAt: created.trial_expires_at,
      status: created.account_status,
    },
  };
}

export async function loginAccount(username: string, password: string, deviceFingerprint: string) {
  const user = await findUser(username.trim().toLowerCase());
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw new Error('اسم المستخدم أو كلمة المرور غير صحيح.');
  }
  if (user.account_status === 'deleted') {
    throw new Error('هذا الحساب محذوف ولا يمكن تسجيل الدخول إليه. إذا كان الحذف بالخطأ، يُرجى مراجعة الإدارة لاستعادته.');
  }
  if (user.account_status !== 'active') {
    throw new Error('هذا الحساب موقوف حاليًا. إذا كان السبب انتهاء التجربة أو الرصيد، يُرجى مراجعة الإدارة لإعادة تفعيله أو شحنه.');
  }
  if (user.device_fingerprint !== deviceFingerprint) {
    throw new Error('هذا الحساب مرتبط بجهاز آخر. لا يمكن الدخول به من جهاز مختلف.');
  }
  return {
    token: createSession(user.id, user.username),
    user: {
      id: user.id,
      username: user.username,
      name: user.display_name,
      role: 'lawyer',
      credits: Number(user.credits || 0),
      trialOperationsRemaining: Math.max(0, Number(user.trial_operations_total || 20) - Number(user.trial_operations_used || 0)),
      trialExpiresAt: user.trial_expires_at,
      status: user.account_status,
    },
  };
}

export async function getCurrentAccount(req: any) {
  const session = requireSession(req);
  const res = await supabase(`platform_users?select=id,username,display_name,role,credits,trial_operations_total,trial_operations_used,trial_expires_at,account_status,operations_used,last_seen_at,created_at&id=eq.${encodeURIComponent(session.userId)}&limit=1`);
  if (!res.ok) throw new Error('تعذر قراءة بيانات الحساب.');
  const user = (await res.json())?.[0];
  if (!user) throw new Error('الحساب غير موجود.');
  return {
    id: user.id,
    username: user.username,
    name: user.display_name,
    role: user.role,
    credits: Number(user.credits || 0),
    trialOperationsRemaining: Math.max(0, Number(user.trial_operations_total || 20) - Number(user.trial_operations_used || 0)),
    trialExpiresAt: user.trial_expires_at,
    status: user.account_status,
  };
}

export async function consumeOperation(req: any, serviceName: string) {
  const session = requireSession(req);
  if (!serviceName || String(serviceName).length > 120) throw new Error('اسم الخدمة غير صالح.');
  const res = await supabase('rpc/consume_platform_operation', {
    method: 'POST',
    body: JSON.stringify({ p_user_id: session.userId }),
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg.replace(/^.*?message[":\s]+/i, '').slice(0, 220) || `تعذر خصم العملية لخدمة ${serviceName}.`);
  }
  const result = await res.json();
  return {
    success: true,
    remainingCredits: Number(result?.remainingCredits || 0),
    trialRemaining: Number(result?.trialRemaining || 0),
    message: `تم خصم عملية لخدمة ${serviceName}.`,
  };
}

export async function redeemCode(req: any, code: string) {
  const session = requireSession(req);
  const clean = code.trim().toUpperCase();
  if (!clean) throw new Error('يرجى إدخال كود الشحن.');
  const res = await supabase('rpc/redeem_recharge_code', {
    method: 'POST',
    body: JSON.stringify({ p_user_id: session.userId, p_code: clean }),
  });
  if (!res.ok) {
    const msg = await res.text();
    throw new Error(msg.replace(/^.*?message[":\s]+/i, '').slice(0, 220) || 'تعذر استخدام كود الشحن.');
  }
  return await res.json();
}

export async function generateRechargeCode(req: any, credits: number, packageId?: string) {
  requireAdmin(req);
  const amount = Math.max(1, Math.floor(Number(credits)));
  const cleanPackageId = String(packageId || '').trim();
  const code = `AMIN-${amount}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  const res = await supabase('recharge_codes', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ code, credits: amount, package_id: cleanPackageId || null, active: true, created_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error('تعذر إنشاء كود الشحن على الخادم.');
  return { code, credits: amount };
}

export async function listAccounts(req: any) {
  requireAdmin(req);
  const res = await supabase('platform_users?select=id,username,display_name,role,credits,trial_operations_total,trial_operations_used,trial_expires_at,account_status,operations_used,last_seen_at,created_at,deleted_at&account_status=neq.deleted&order=created_at.desc');
  if (!res.ok) throw new Error('تعذر قراءة حسابات المنصة.');
  return await res.json();
}

export async function adjustAccountBalance(req: any, userId: string, amount: number, mode: 'add' | 'set' = 'add') {
  requireAdmin(req);
  const cleanId = String(userId || '').trim();
  if (!cleanId) throw new Error('يجب تحديد الحساب المستهدف.');
  const value = Math.floor(Number(amount));
  if (!Number.isFinite(value) || value < 0) throw new Error('قيمة الرصيد غير صالحة.');

  const rpcRes = await supabase('rpc/admin_adjust_platform_balance', {
    method: 'POST',
    body: JSON.stringify({
      p_user_id: cleanId,
      p_amount: value,
      p_mode: mode,
    }),
  });
  if (!rpcRes.ok) {
    const msg = await rpcRes.text();
    throw new Error(`تعذر تحديث رصيد الحساب (${rpcRes.status}): ${msg.slice(0, 180)}`);
  }
  const result = await rpcRes.json();
  return {
    userId: cleanId,
    newTotal: Number(result?.newTotal || 0),
    added: mode === 'add' ? value : undefined,
    accountStatus: result?.accountStatus || 'suspended',
  };
}

export async function deleteAccount(req: any, userId: string) {
  requireAdmin(req);
  const cleanId = String(userId || '').trim();
  if (!cleanId) throw new Error('يجب تحديد الحساب المستهدف.');

  const currentRes = await supabase(`platform_users?select=id,username,device_fingerprint,account_status&id=eq.${encodeURIComponent(cleanId)}&limit=1`);
  if (!currentRes.ok) throw new Error('تعذر قراءة الحساب المستهدف.');
  const current = (await currentRes.json())?.[0];
  if (!current) throw new Error('الحساب المستهدف غير موجود.');

  const now = new Date().toISOString();
  const updateRes = await supabase(`platform_users?id=eq.${encodeURIComponent(cleanId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ account_status: 'deleted', deleted_at: now, updated_at: now }),
  });
  if (!updateRes.ok) {
    const msg = await updateRes.text();
    throw new Error(`تعذر حذف الحساب (${updateRes.status}): ${msg.slice(0, 180)}`);
  }

  return { ok: true, userId: cleanId, username: current.username };
}
