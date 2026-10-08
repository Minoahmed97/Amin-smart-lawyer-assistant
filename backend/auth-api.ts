import {
  registerAccount,
  loginAccount,
  getCurrentAccount,
  consumeOperation,
  redeemCode,
  generateRechargeCode,
  listAccounts,
  adjustAccountBalance,
  deleteAccount,
  loginAdmin,
} from './auth.ts';
import { rateLimit, limitBodyString } from './security.ts';

export default async function handler(req: any, res: any) {
  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch {}
    }
    const route = String(req?.query?.subroute || req?.query?.action || '').trim();
    if (route === 'login') rateLimit(req, 'login', 12, 10 * 60 * 1000);
    if (route === 'register') rateLimit(req, 'register', 6, 60 * 60 * 1000);
    if (route === 'redeem') rateLimit(req, 'redeem', 10, 10 * 60 * 1000);
    if (route === 'consume') rateLimit(req, 'consume', 30, 10 * 60 * 1000);
    if (typeof body?.username === 'string') limitBodyString(body.username, 64, 'اسم المستخدم');
    if (typeof body?.password === 'string') limitBodyString(body.password, 256, 'كلمة المرور');
    if (typeof body?.pin === 'string') limitBodyString(body.pin, 128, 'رمز الإدارة');
    if (req.method === 'POST' && route === 'admin-login') {
      return res.json(loginAdmin(body?.pin || '', req));
    }
    if (req.method === 'POST' && route === 'register') {
      return res.json(await registerAccount(body?.username || '', body?.password || '', body?.displayName || '', body?.deviceFingerprint || '', req));
    }
    if (req.method === 'POST' && route === 'login') {
      return res.json(await loginAccount(body?.username || '', body?.password || '', body?.deviceFingerprint || ''));
    }
    if (req.method === 'GET' && route === 'me') {
      return res.json({ user: await getCurrentAccount(req) });
    }
    if (req.method === 'POST' && route === 'consume') {
      return res.json(await consumeOperation(req, body?.serviceName || 'عملية قضائية'));
    }
    if (req.method === 'POST' && route === 'redeem') {
      return res.json(await redeemCode(req, body?.code || ''));
    }
    if (req.method === 'POST' && route === 'generate-code') {
      return res.json(await generateRechargeCode(req, Number(body?.credits || 0), body?.packageId || ''));
    }
    if (req.method === 'GET' && route === 'accounts') {
      return res.json({ accounts: await listAccounts(req) });
    }
    if (req.method === 'POST' && route === 'admin-balance') {
      return res.json(await adjustAccountBalance(req, body?.userId || '', Number(body?.amount || 0), body?.mode === 'set' ? 'set' : 'add'));
    }
    if (req.method === 'POST' && route === 'admin-delete-account') {
      return res.json(await deleteAccount(req, body?.userId || ''));
    }
    return res.status(404).json({ error: 'مسار مصادقة غير موجود.' });
  } catch (err: any) {
    const message = typeof err?.message === 'string' && err.message.trim()
      ? err.message
      : typeof err === 'string' && err.trim()
        ? err
        : 'تعذر تنفيذ الطلب.';
    return res.status(err?.statusCode || 400).json({ error: message });
  }
}
