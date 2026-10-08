import { getManagedGeminiKeyByIndex, testGeminiKey } from '../../keyRotation.ts';
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
    const { apiKey, index } = body || {};
    const keyToTest = typeof index === 'number' ? await getManagedGeminiKeyByIndex(index) : apiKey;
    const result = await testGeminiKey(keyToTest || '');
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err?.message || 'حدث خطأ في النظام.' });
  }
}
