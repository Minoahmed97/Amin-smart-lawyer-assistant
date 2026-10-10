import { requireAdmin } from '../auth.ts';
import { getVercelGeminiKeys, testGeminiKey } from '../keyRotation.ts';
import { fetchServerCloudGeminiKeys } from '../supabaseSync.ts';

/** Admin-only end-to-end check: browser -> Vercel API -> Gemini provider. */
export default async function handler(req: any, res: any) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  try {
    requireAdmin(req);
    const startedAt = Date.now();
    const serverKeys = getVercelGeminiKeys();
    let cloudKeys: string[] = [];
    let cloudReadOk = true;
    try {
      cloudKeys = await fetchServerCloudGeminiKeys();
    } catch (error: any) {
      cloudReadOk = false;
      console.error('AI health check: could not read cloud keys:', error?.message || error);
    }

    const keys = [...new Set([...cloudKeys, ...serverKeys])];
    if (keys.length === 0) {
      return res.status(503).json({
        ok: false,
        apiReachable: true,
        aiReachable: false,
        cloudKeysReadable: cloudReadOk,
        checkedKeys: 0,
        latencyMs: Date.now() - startedAt,
        message: cloudReadOk
          ? 'وصل الفحص إلى السيرفر، لكن لم يتم العثور على أي مفتاح Gemini مضبوط.'
          : 'وصل الفحص إلى السيرفر، لكن تعذرت قراءة المفاتيح السحابية ولم يوجد مفتاح خادم بديل.',
      });
    }

    let lastMessage = 'لم ينجح أي مفتاح في الاتصال بخدمة Gemini.';
    let checkedKeys = 0;
    // Keep the admin health check bounded: test at most four configured keys,
    // with a strict per-key timeout. This endpoint must never hang on a slow provider.
    const keysToCheck = keys.slice(0, 4);
    for (const key of keysToCheck) {
      checkedKeys += 1;
      try {
        const result = await testGeminiKey(key, 6000);
        if (result.success && !String(result.message || '').includes('تعذر تأكيد إمكانية الاستخدام الآن')) {
          return res.status(200).json({
            ok: true,
            apiReachable: true,
            aiReachable: true,
            cloudKeysReadable: cloudReadOk,
            checkedKeys,
            configuredKeys: keys.length,
            latencyMs: Date.now() - startedAt,
            message: 'الاتصال سليم: وصل الطلب إلى السيرفر وتم استلام استجابة فعلية من Gemini.',
          });
        }
        lastMessage = result.message || lastMessage;
      } catch (error: any) {
        lastMessage = error?.message || lastMessage;
      }
    }

    return res.status(502).json({
      ok: false,
      apiReachable: true,
      aiReachable: false,
      cloudKeysReadable: cloudReadOk,
      checkedKeys,
      configuredKeys: keys.length,
      latencyMs: Date.now() - startedAt,
      message: `وصل الطلب إلى السيرفر، لكن تعذر تأكيد اتصال Gemini. تم فحص ${checkedKeys} من أصل ${keys.length} مفاتيح كحد أقصى للفحص السريع. ${lastMessage}`, 
    });
  } catch (error: any) {
    const status = Number(error?.statusCode) || 401;
    return res.status(status).json({
      ok: false,
      apiReachable: true,
      aiReachable: false,
      message: error?.message || 'تعذر إجراء فحص الاتصال بصلاحيات الإدارة.',
    });
  }
}
