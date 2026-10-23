import { testGeminiKey } from '../keyRotation.ts';
import {
  fetchServerCloudOCRGeminiKeys,
  saveServerCloudOCRGeminiKey,
  deleteServerCloudOCRGeminiKey,
} from '../supabaseSync.ts';
import { requireAdmin } from '../auth.ts';
import { sanitizeGeminiKey, isValidKeyFormat } from '../centralKeys.ts';

function maskKey(key: string) {
  return key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-4)}` : '****';
}

async function getStatus() {
  const keys = await fetchServerCloudOCRGeminiKeys();
  const maskedSeen = new Set<string>();
  const visibleKeys = keys.map((key, index) => ({
    index,
    id: `ocr_key_${index + 1}`,
    name: `مفتاح OCR (${index + 1})`,
    masked: maskKey(key),
    prefix: key.slice(0, 2),
    isActive: index === 0,
  })).filter((key) => {
    if (maskedSeen.has(key.masked)) return false;
    maskedSeen.add(key.masked);
    return true;
  });
  return { ok: true, keys: visibleKeys, totalCount: visibleKeys.length, isConfigured: visibleKeys.length > 0, rotationEnabled: visibleKeys.length > 1 };
}

export default async function handler(req: any, res: any) {
  try {
    requireAdmin(req);
    if (req.method === 'GET') return res.status(200).json(await getStatus());
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch {} }
    const action = String(body?.action || '');

    if (action === 'add' || action === 'test') {
      const key = sanitizeGeminiKey(body?.apiKey);
      if (!isValidKeyFormat(key)) return res.status(400).json({ ok: false, error: 'أدخل مفتاح Gemini صالحاً لمجموعة الصور والمستندات.' });
      const tested = await testGeminiKey(key, 12000);
      const definitelyInvalid = !tested.success && /أكدت Google أن مفتاح Gemini غير صالح|Google رفض مفتاح Gemini|مفتاح Gemini غير صالح شكلياً/i.test(tested.message || '');
      if (definitelyInvalid) return res.status(400).json({ ok: false, success: false, error: tested.message, message: tested.message });
      if (action === 'test') return res.status(tested.success ? 200 : 503).json({ ok: tested.success, ...tested });
      await saveServerCloudOCRGeminiKey(key);
      return res.status(200).json({ ok: true, success: tested.success, message: tested.success ? `تم اختبار المفتاح وحفظه في مجموعة OCR. ${tested.message}` : `تم حفظ المفتاح في مجموعة OCR، لكن تعذر تأكيد عمله الآن: ${tested.message}`, status: await getStatus() });
    }

    if (action === 'testSaved' || action === 'delete') {
      const index = body?.index;
      if (!Number.isInteger(index) || index < 0) return res.status(400).json({ ok: false, error: 'رقم المفتاح غير صحيح.' });
      const keys = await fetchServerCloudOCRGeminiKeys();
      const key = keys[index];
      if (!key) return res.status(404).json({ ok: false, error: 'مفتاح OCR غير موجود.' });
      if (action === 'testSaved') {
        const tested = await testGeminiKey(key, 12000);
        return res.status(tested.success ? 200 : 503).json({ ok: tested.success, ...tested });
      }
      await deleteServerCloudOCRGeminiKey(key);
      return res.status(200).json({ ok: true, message: 'تم حذف المفتاح من مجموعة OCR فقط.', status: await getStatus() });
    }

    return res.status(400).json({ ok: false, error: 'عملية مجموعة OCR غير معروفة.' });
  } catch (error: any) {
    const status = Number(error?.statusCode || error?.status);
    return res.status(Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500)
      .json({ ok: false, error: error?.message || 'تعذر إدارة مفاتيح الصور والمستندات.' });
  }
}
