import { requireAdmin } from '../auth.ts';
import {
  fetchServerCloudOCRGroqFallbackConfig,
  saveServerCloudOCRGroqFallbackConfig,
  type OCRGroqFallbackConfig,
} from '../supabaseSync.ts';
import { GROQ_OCR_VISION_MODEL, testGroqOCRKey, testSavedGroqOCRFallback } from '../groqOcr.ts';

function maskKey(key: string): string {
  return key.length > 10 ? `${key.slice(0, 5)}...${key.slice(-4)}` : '****';
}

async function getStatus() {
  const config = await fetchServerCloudOCRGroqFallbackConfig(true);
  return {
    ok: true,
    enabled: config.enabled,
    configured: Boolean(config.apiKey),
    maskedKey: config.apiKey ? maskKey(config.apiKey) : '',
    model: config.model || GROQ_OCR_VISION_MODEL,
    provider: 'Groq Vision',
  };
}

export default async function handler(req: any, res: any) {
  try {
    requireAdmin(req);
    if (req.method === 'GET') return res.status(200).json(await getStatus());
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method Not Allowed' });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch {} }
    const action = String(body?.action || '');
    const current = await fetchServerCloudOCRGroqFallbackConfig(true);

    if (action === 'test') {
      const apiKey = typeof body?.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : current.apiKey;
      if (!apiKey) return res.status(400).json({ ok: false, error: 'أدخل مفتاح Groq أولاً أو احفظ المفتاح من قبل.' });
      const test = await testGroqOCRKey(apiKey, current.model || GROQ_OCR_VISION_MODEL);
      return res.status(test.success ? 200 : 503).json({ ok: test.success, ...test });
    }

    if (action === 'save') {
      const apiKey = typeof body?.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : current.apiKey;
      if (!apiKey.startsWith('gsk_') || apiKey.length < 20) {
        return res.status(400).json({ ok: false, error: 'مفتاح Groq غير صالح شكلياً. أنشئ المفتاح من Groq Console وانسخه كاملاً.' });
      }
      const next: OCRGroqFallbackConfig = {
        enabled: body?.enabled !== false,
        apiKey,
        model: GROQ_OCR_VISION_MODEL,
      };
      await saveServerCloudOCRGroqFallbackConfig(next);
      return res.status(200).json({ ok: true, message: next.enabled ? 'تم حفظ مفتاح Groq وتفعيل الاحتياطي عند تجاوز حصة Gemini.' : 'تم حفظ مفتاح Groq دون تفعيل الاحتياطي.', status: await getStatus() });
    }

    if (action === 'toggle') {
      if (body?.enabled === true && !current.apiKey) {
        return res.status(400).json({ ok: false, error: 'احفظ مفتاح Groq قبل تفعيل الاحتياطي.' });
      }
      await saveServerCloudOCRGroqFallbackConfig({ ...current, enabled: body?.enabled === true });
      return res.status(200).json({ ok: true, message: body?.enabled === true ? 'تم تفعيل احتياطي Groq لـ OCR.' : 'تم إيقاف احتياطي Groq؛ سيعود OCR للاعتماد على Gemini فقط.', status: await getStatus() });
    }

    if (action === 'testSaved') {
      const result = await testSavedGroqOCRFallback();
      return res.status(result.success ? 200 : 503).json({ ok: result.success, ...result });
    }

    if (action === 'delete') {
      await saveServerCloudOCRGroqFallbackConfig({ enabled: false, apiKey: '', model: GROQ_OCR_VISION_MODEL });
      return res.status(200).json({ ok: true, message: 'تم حذف مفتاح Groq من إعداد احتياطي OCR وإيقافه.', status: await getStatus() });
    }

    return res.status(400).json({ ok: false, error: 'عملية احتياطي Groq غير معروفة.' });
  } catch (error: any) {
    const status = Number(error?.statusCode || error?.status);
    return res.status(Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500)
      .json({ ok: false, error: error?.message || 'تعذر إدارة إعداد احتياطي Groq لـ OCR.' });
  }
}
