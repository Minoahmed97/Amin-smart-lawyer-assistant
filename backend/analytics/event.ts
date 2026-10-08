import { recordEvent } from '../analyticsStore.ts';
import { requireSession } from '../auth.ts';
import { rateLimit, limitBodyString } from '../security.ts';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  try {
    const session = requireSession(req);
    rateLimit(req, 'analytics-event', 60, 60 * 1000, { identity: session.userId });
    const { type, deviceId, role, metadata } = req.body || {};
    if (!['register','use','subscribe'].includes(type)) return res.status(400).json({ error: 'نوع الحدث غير صالح.' });
    limitBodyString(deviceId, 160, 'معرف الجهاز');
    limitBodyString(role, 40, 'الدور');
    if (metadata && typeof metadata === 'object') {
      const raw = JSON.stringify(metadata);
      if (raw.length > 4000) return res.status(413).json({ error: 'بيانات التحليلات كبيرة جداً.' });
    }
    await recordEvent(type, deviceId || '', role || 'lawyer', metadata);
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(err?.statusCode || 400).json({ error: err?.message || 'تعذر تسجيل الحدث.' });
  }
}
