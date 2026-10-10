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
    // Check keys one by one: stop as soon as a working key is found, and
    // let the key tester stop immediately on confirmed quota exhaustion.
    const keysToCheck = keys;
    const results: Array<{ success: boolean; message: string }> = [];
    for (const key of keysToCheck) {
      let result: { success: boolean; message: string };
      try { result = await testGeminiKey(key, 12000); }
      catch (error: any) { result = { success: false, message: error?.message || 'تعذر اختبار المفتاح.' }; }
      results.push(result);
      if (result.success && !/تعذر تأكيد إمكانية الاستخدام الآن|نفاد الحصة|تحديد المعدل/.test(String(result.message || ''))) break;
    }
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
        keyResults: results.map((result, index) => ({ index, status: result.success ? 'working' : (/الحصة مستنفدة|نفاد الحصة|حد الاستخدام/.test(result.message) ? 'quota_exhausted' : 'unavailable'), message: result.message })),
        latencyMs: Date.now() - startedAt,
        message: `الاتصال سليم: تم استلام نص فعلي من Gemini باستخدام أحد المفاتيح المختبرة. تم فحص ${results.length} من أصل ${keys.length} مفاتيح متاحة للفحص السريع.`,
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
      keyResults: results.map((result, index) => ({ index, status: result.success ? 'working' : (/الحصة مستنفدة|نفاد الحصة|حد الاستخدام/.test(result.message) ? 'quota_exhausted' : 'unavailable'), message: result.message })),
      latencyMs: Date.now() - startedAt,
      message: `وصل الطلب إلى السيرفر، لكن لم يتم استلام نص مولّد فعلي من المفاتيح المختبرة. هذا لا يعني بالضرورة أن المفاتيح غير صالحة؛ قد يكون السبب الحصة أو الصلاحيات أو مهلة الشبكة أو عدم إتاحة النموذج. ${lastMessage}`,
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
