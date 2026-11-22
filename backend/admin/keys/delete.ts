import { getKeysStatus } from '../../keyRotation.ts';
import { deleteServerCloudGeminiKey, fetchServerCloudGeminiKeys } from '../../supabaseSync.ts';
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
    const { index } = body || {};
    if (typeof index === 'number' && Number.isInteger(index) && index >= 0) {
      const cloudKeys = await fetchServerCloudGeminiKeys();
      const target = cloudKeys[index];
      if (!target) return res.status(404).json({ error: 'المفتاح غير موجود في مفاتيح Supabase.' });
      await deleteServerCloudGeminiKey(target);
      const remainingKeys = await fetchServerCloudGeminiKeys();
      return res.json({ ok: true, status: getKeysStatus(remainingKeys) });
    }
    return res.status(400).json({ error: 'بيانات الحذف غير صحيحة.' });
  } catch (err: any) {
    return res.status(err?.statusCode || 500).json({ error: err?.message || 'فشل حذف المفتاح من التخزين الدائم.' });
  }
}
