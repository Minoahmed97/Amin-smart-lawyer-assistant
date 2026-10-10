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
      let cloudTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        cloudKeys = await Promise.race([
          fetchServerCloudGeminiKeys(),
          new Promise<string[]>((_, reject) => {
            cloudTimeout = setTimeout(
              () => reject(new Error('انتهت مهلة قراءة مفاتيح Gemini من Supabase بعد 5 ثوانٍ.')),
              5000,
            );
          }),
        ]);
      } finally {
        if (cloudTimeout) clearTimeout(cloudTimeout);
      }
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
        configuredKeys: 0,
        latencyMs: Date.now() - startedAt,
        message: cloudReadOk
          ? 'وصل الفحص إلى السيرفر، لكن لم يتم العثور على أي مفتاح Gemini مضبوط.'
          : 'وصل الفحص إلى السيرفر، لكن تعذرت قراءة المفاتيح السحابية ولم يوجد مفتاح خادم بديل.',
      });
    }

    // Check keys in order. Quota/rate-limit errors fail fast for that key, so
    // the next key is tested without probing every model on the exhausted key.
    // A global deadline prevents a long key list from hanging the admin panel.
    const healthDeadline = Date.now() + 25000;
    const keyStatuses: Array<{ key: number; success: boolean; message: string }> = [];
    let successfulKeyIndex = -1;

    for (let i = 0; i < keys.length; i++) {
      const remainingMs = healthDeadline - Date.now();
      if (remainingMs <= 0) {
        keyStatuses.push({ key: i + 1, success: false, message: 'لم يُفحص هذا المفتاح بسبب انتهاء المهلة الإجمالية للفحص.' });
        break;
      }
      try {
        const result = await testGeminiKey(keys[i], Math.min(8000, remainingMs));
        keyStatuses.push({ key: i + 1, success: result.success, message: result.message });
        if (result.success) {
          successfulKeyIndex = i;
          break;
        }
      } catch (error: any) {
        keyStatuses.push({ key: i + 1, success: false, message: error?.message || 'تعذر اختبار المفتاح.' });
      }
    }

    if (successfulKeyIndex >= 0) {
      return res.status(200).json({
        ok: true,
        apiReachable: true,
        aiReachable: true,
        cloudKeysReadable: cloudReadOk,
        checkedKeys: keyStatuses.length,
        configuredKeys: keys.length,
        workingKey: successfulKeyIndex + 1,
        keyStatuses,
        latencyMs: Date.now() - startedAt,
        message: `الاتصال سليم: المفتاح ${successfulKeyIndex + 1} استلم نصًا فعليًا من Gemini. تم تجاوز المفاتيح السابقة غير العاملة، وفُحص ${keyStatuses.length} من أصل ${keys.length} مفتاحًا.`,
      });
    }

    const details = keyStatuses.map((result) => `المفتاح ${result.key}: ${result.message}`).join(' | ');
    return res.status(502).json({
      ok: false,
      apiReachable: true,
      aiReachable: false,
      cloudKeysReadable: cloudReadOk,
      checkedKeys: keyStatuses.length,
      configuredKeys: keys.length,
      keyStatuses,
      latencyMs: Date.now() - startedAt,
      message: `لم يتم استلام نص مولّد من المفاتيح التي أمكن فحصها. حالات المفاتيح موضحة بالتفصيل؛ نفاد الحصة لا يعني أن بقية المفاتيح غير صالحة. ${details}`,
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
