import { recordHeartbeat } from '../analyticsStore.ts';
import { createSession, requireSession } from '../auth.ts';
import { rateLimit, limitBodyString } from '../security.ts';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  try {
    const session = requireSession(req);
    rateLimit(req, 'analytics-heartbeat', 30, 60 * 1000, { identity: session.userId });
    const { deviceId, role, isLawyer } = req.body || {};
    limitBodyString(deviceId, 160, 'معرف الجهاز');
    await recordHeartbeat(deviceId || '', role || 'lawyer', isLawyer !== false);
    return res.json({ ok: true, sessionToken: createSession(session.userId, session.username) });
  } catch (err: any) {
    return res.status(err?.statusCode || 400).json({ error: err?.message || 'تعذر تسجيل النشاط.' });
  }
}
