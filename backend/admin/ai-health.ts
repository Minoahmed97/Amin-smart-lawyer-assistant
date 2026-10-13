import { requireAdmin } from '../auth.ts';

/** Admin-only metadata check for the configured AI provider; it does not generate text. */
export default async function handler(req: any, res: any) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }

  try {
    requireAdmin(req);
    const startedAt = Date.now();
    if (process.env.AI_PROVIDER?.trim().toLowerCase() === 'gemini') {
      return res.status(503).json({
        ok: false,
        apiReachable: true,
        aiReachable: false,
        latencyMs: Date.now() - startedAt,
        message: 'إعداد الخادم ما زال يحدد Gemini كمزوّد. غيّر AI_PROVIDER إلى openrouter أو احذف المتغير، ثم اضبط OPENROUTER_API_KEY.',
      });
    }
    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) {
      return res.status(503).json({
        ok: false,
        apiReachable: true,
        aiReachable: false,
        latencyMs: Date.now() - startedAt,
        message: 'لم يتم ضبط OPENROUTER_API_KEY في متغيرات بيئة Vercel.',
      });
    }

    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 500);
      return res.status(response.status === 401 ? 502 : response.status).json({
        ok: false,
        apiReachable: true,
        aiReachable: false,
        latencyMs: Date.now() - startedAt,
        message: `تعذر التحقق من اتصال OpenRouter (${response.status}). ${detail}`,
      });
    }
    return res.status(200).json({
      ok: true,
      apiReachable: true,
      aiReachable: true,
      configuredProvider: 'openrouter',
      latencyMs: Date.now() - startedAt,
      message: 'تم الاتصال بـ OpenRouter والتحقق من صلاحية الوصول إلى قائمة النماذج دون توليد نص أو استهلاك حصة توليد.',
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
