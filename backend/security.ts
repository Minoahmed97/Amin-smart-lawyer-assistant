import crypto from 'node:crypto';

type Bucket = { count: number; resetAt: number; failures: number; blockedUntil: number };
const buckets = new Map<string, Bucket>();

function now() { return Date.now(); }

export function getClientIp(req: any): string {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const real = String(req?.headers?.['x-real-ip'] || '').trim();
  return forwarded || real || String(req?.socket?.remoteAddress || 'unknown');
}

export function safeString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

export function getRegistrationGuardKey(req: any, deviceFingerprint: string): string {
  const ip = getClientIp(req);
  const userAgent = safeString(req?.headers?.['user-agent'], 512);
  return crypto
    .createHash('sha256')
    .update(`v1|${ip}|${userAgent}|${deviceFingerprint}`)
    .digest('hex');
}

export function rateLimit(
  req: any,
  scope: string,
  limit: number,
  windowMs: number,
  options: { identity?: string; failure?: boolean } = {},
) {
  const ip = getClientIp(req);
  const identity = options.identity ? safeString(options.identity, 160) : '';
  const key = crypto.createHash('sha256').update(`${scope}|${ip}|${identity}`).digest('hex');
  const t = now();
  let b = buckets.get(key);
  if (!b || t >= b.resetAt) b = { count: 0, resetAt: t + windowMs, failures: 0, blockedUntil: 0 };
  if (b.blockedUntil > t) {
    buckets.set(key, b);
    const retryAfter = Math.max(1, Math.ceil((b.blockedUntil - t) / 1000));
    const err: any = new Error('عدد المحاولات كبير مؤقتاً. حاول مرة أخرى لاحقاً.');
    err.statusCode = 429;
    err.retryAfter = retryAfter;
    throw err;
  }
  b.count++;
  if (options.failure) b.failures++;
  if (b.count > limit) {
    const err: any = new Error('تم تجاوز الحد المسموح من الطلبات مؤقتاً.');
    err.statusCode = 429;
    err.retryAfter = Math.max(1, Math.ceil((b.resetAt - t) / 1000));
    buckets.set(key, b);
    throw err;
  }
  if (b.failures >= 5) {
    b.blockedUntil = t + Math.min(15 * 60 * 1000, 1000 * 2 ** Math.min(8, b.failures - 5));
  }
  buckets.set(key, b);
}

export function requirePostJson(req: any) {
  if (req.method !== 'POST') {
    const err: any = new Error('Method Not Allowed');
    err.statusCode = 405;
    throw err;
  }
  const contentType = String(req?.headers?.['content-type'] || '').toLowerCase();
  if (contentType && !contentType.includes('application/json')) {
    const err: any = new Error('Content-Type غير مدعوم.');
    err.statusCode = 415;
    throw err;
  }
}

export function limitBodyString(value: unknown, max: number, field = 'البيانات') {
  if (typeof value === 'string' && value.length > max) {
    const err: any = new Error(`حجم ${field} أكبر من الحد المسموح.`);
    err.statusCode = 413;
    throw err;
  }
}

export function validateBase64Payload(base64Data: unknown, maxBytes = 20 * 1024 * 1024) {
  if (typeof base64Data !== 'string' || !base64Data) {
    const err: any = new Error('بيانات الملف غير متوفرة.');
    err.statusCode = 400;
    throw err;
  }
  if (!/^[A-Za-z0-9+/=\s]+$/.test(base64Data)) {
    const err: any = new Error('صيغة الملف غير صالحة.');
    err.statusCode = 400;
    throw err;
  }
  const compact = base64Data.replace(/\s/g, '');
  const estimatedBytes = Math.floor(compact.length * 3 / 4) - (compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0);
  if (estimatedBytes > maxBytes) {
    const err: any = new Error('حجم الملف أكبر من الحد المسموح.');
    err.statusCode = 413;
    throw err;
  }
  return compact;
}
