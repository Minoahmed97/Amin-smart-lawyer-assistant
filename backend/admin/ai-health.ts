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
      // Bound the Supabase lookup too; a stalled cloud request must not keep
      // the admin health-check response waiting indefinitely.
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
        latencyMs: Date.now() - startedAt,
        message: cloudReadOk
          ? 'وصل الفحص إلى السيرفر، لكن لم يتم العثور على أي مفتاح Gemini مضبوط.'
          : 'وصل الفحص إلى السيرفر، لكن تعذرت قراءة المفاتيح السحابية ولم يوجد مفتاح خادم بديل.',
      });
    }

    let lastMessage = 'لم ينجح أي مفتاح في الاتصال بخدمة Gemini.';
    // Check up to four keys concurrently using metadata-only requests; do not consume generation quota.
    const keysToCheck = keys.slice(0, 4);
    const results = await Promise.all(keysToCheck.map(async (key) => {
      try {
        return await testGeminiKey(key, 60000);
      } catch (error: any) {
        return { success: false, message: error?.message || 'تعذر اختبار المفتاح.' };
      }
    }));
    const successfulIndex = results.findIndex((result) => result.success &&
      !/تعذر تأكيد إمكانية الاستخدام الآن|نفاد الحصة|تحديد المعدل|تعرّف على المفتاح لكنه أبلغ/.test(String(result.message || '')));

    if (successfulIndex >= 0) {
      return res.status(200).json({
        ok: true,
        apiReachable: true,
        aiReachable: true,
        cloudKeysReadable: cloudReadOk,
        checkedKeys: results.length,
        configuredKeys: keys.length,
        latencyMs: Date.now() - startedAt,
        message: `اتصال الخادم سليم، وتم التحقق من الوصول إلى بيانات أحد نماذج Gemini دون توليد نص أو استهلاك حصة توليد المحتوى. تم فحص ${results.length} من أصل ${keys.length} مفاتيح متاحة للفحص السريع.`,
      });
    }

    lastMessage = results.map((result, index) => `المفتاح ${index + 1}: ${result.message}`).join(' | ') || lastMessage;
    return res.status(502).json({
      ok: false,
      apiReachable: true,
      aiReachable: false,
      cloudKeysReadable: cloudReadOk,
      checkedKeys: results.length,
      configuredKeys: keys.length,
      latencyMs: Date.now() - startedAt,
      message: `وصل الطلب إلى السيرفر، لكن لم يتمكن الفحص من تأكيد الوصول إلى بيانات نموذج Gemini للمفاتيح المختبرة. هذا لا يعني بالضرورة أن المفاتيح غير صالحة؛ قد يكون السبب الحصة أو الصلاحيات أو مهلة الشبكة أو عدم إتاحة النموذج. ${lastMessage}`,
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
