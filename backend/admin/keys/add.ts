import { getKeysStatus } from '../../keyRotation.ts';
import { saveServerCloudGeminiKey } from '../../supabaseSync.ts';
import { requireAdmin } from '../../auth.ts';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    requireAdmin(req);
    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {}
    }
    const { apiKey } = body || {};
    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 10) {
      return res.status(400).json({ error: 'يرجى تقديم مفتاح Gemini صالح (يبدأ بـ AIza أو AQ).' });
    }
    const cleanKey = apiKey.trim();
    // Saving a key is deliberately not a connectivity test. Its runtime status
    // changes only after an actual Gemini request uses this managed key.
    await saveServerCloudGeminiKey(cleanKey);

    return res.json({
      ok: true,
      message: 'تم حفظ المفتاح في إدارة المنصة دون فحص. ستظهر حالته بعد أول استخدام فعلي له.',
      status: getKeysStatus(),
    });
  } catch (err: any) {
    return res.status(err?.statusCode || 500).json({ error: err?.message || 'فشل حفظ المفتاح في التخزين الدائم.' });
  }
}
