import { getKeysStatus, getVercelGeminiKeys, getFileStoredKeys, removeStoredKey } from '../../keyRotation.ts';
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
      const fileKeys = getFileStoredKeys();
      const envKeys = getVercelGeminiKeys().filter((key) => !fileKeys.includes(key));
      const cloudOnlyKeys = cloudKeys.filter((key) => !envKeys.includes(key) && !fileKeys.includes(key));

      // Keep the same order returned by keys-status: environment, local legacy,
      // then cloud-only. Persistent deletion must succeed before local mutation.
      if (index < envKeys.length) {
        return res.status(400).json({ error: 'مفتاح Environment لا يُحذف من داخل المنصة.' });
      }
      const fileIndex = index - envKeys.length;
      if (fileIndex < fileKeys.length) {
        const target = fileKeys[fileIndex];
        if (cloudKeys.includes(target)) await deleteServerCloudGeminiKey(target);
        removeStoredKey(fileIndex);
        return res.json({ ok: true, status: getKeysStatus() });
      }
      const target = cloudOnlyKeys[fileIndex - fileKeys.length];
      if (!target) return res.status(404).json({ error: 'المفتاح غير موجود.' });
      await deleteServerCloudGeminiKey(target);
      return res.json({ ok: true, status: getKeysStatus() });
    }
    return res.status(400).json({ error: 'بيانات الحذف غير صحيحة.' });
  } catch (err: any) {
    return res.status(err?.statusCode || 500).json({ error: err?.message || 'فشل حذف المفتاح من التخزين الدائم.' });
  }
}
