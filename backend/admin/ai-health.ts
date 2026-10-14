import { requireAdmin } from '../auth.ts';
import { getOpenRouterModels } from '../openrouterAdapter.ts';
import { getVercelGeminiKeys, GEMINI_MODELS } from '../keyRotation.ts';
import { fetchServerCloudGeminiKeys } from '../supabaseSync.ts';

function shortError(value: unknown): string {
  return String(value || 'سبب غير معروف').replace(/\s+/g, ' ').slice(0, 240);
}

async function testOpenRouterGeneration() {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return { configured: false, ok: false, latencyMs: 0, message: 'مفتاح OpenRouter غير مضبوط على Vercel.' };

  const startedAt = Date.now();
  let lastMessage = 'لم يرجع أي نموذج نتيجة.';
  for (const model of getOpenRouterModels().slice(0, 1)) {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'https://amin-smart-lawyer-assistant.vercel.app',
          'X-Title': 'Amin Smart Lawyer Assistant - Admin Connection Test',
        },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with exactly OK.' }], max_tokens: 8, temperature: 0 }),
        signal: AbortSignal.timeout(20000),
      });
      const raw = await response.text();
      let data: any = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch {}
      if (response.ok && String(data?.choices?.[0]?.message?.content || '').trim()) {
        return { configured: true, ok: true, latencyMs: Date.now() - startedAt, model, message: `نجح توليد نص فعلي من OpenRouter عبر ${model}.` };
      }
      lastMessage = `النموذج ${model} فشل (${response.status}): ${shortError(data?.error?.message || raw || response.statusText)}`;
      // Keep this diagnostic deliberately low-cost: test only one configured model per click.
      if (![400, 401, 402, 403, 404, 408, 413, 429].includes(response.status) && response.status < 500) break;
    } catch (error: any) {
      lastMessage = shortError(error?.name === 'TimeoutError' ? 'تجاوز اختبار OpenRouter 20 ثانية دون نتيجة.' : error?.message);
    }
  }
  return { configured: true, ok: false, latencyMs: Date.now() - startedAt, message: lastMessage };
}

async function testGeminiGeneration() {
  const startedAt = Date.now();
  let keys = getVercelGeminiKeys();
  let cloudKeysReadable = true;
  try {
    for (const key of await fetchServerCloudGeminiKeys()) if (!keys.includes(key)) keys.push(key);
  } catch (error) {
    cloudKeysReadable = false;
    if (!keys.length) return { configured: false, ok: false, latencyMs: Date.now() - startedAt, cloudKeysReadable, keysChecked: 0, message: `تعذر قراءة مفاتيح Gemini من Supabase: ${shortError((error as any)?.message)}` };
  }
  if (!keys.length) return { configured: false, ok: false, latencyMs: Date.now() - startedAt, cloudKeysReadable, keysChecked: 0, message: 'لا توجد مفاتيح Gemini في متغيرات Vercel أو لوحة الإدارة.' };

  let lastMessage = 'لم يرجع Gemini نتيجة.';
  let keysChecked = 0;
  // Keep this diagnostic deliberately low-cost: test only one configured Gemini key per click.
  for (const key of keys.slice(0, 1)) {
    keysChecked++;
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODELS[0])}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: 'Reply with exactly OK.' }] }], generationConfig: { maxOutputTokens: 8, temperature: 0 } }),
        signal: AbortSignal.timeout(15000),
      });
      const raw = await response.text();
      let data: any = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch {}
      const generatedText = (data?.candidates?.[0]?.content?.parts || []).map((part: any) => part?.text || '').join('').trim();
      if (response.ok && generatedText) {
        return { configured: true, ok: true, latencyMs: Date.now() - startedAt, cloudKeysReadable, keysChecked, model: GEMINI_MODELS[0], message: `نجح توليد نص فعلي من Gemini عبر ${GEMINI_MODELS[0]}.` };
      }
      lastMessage = `فشل اختبار Gemini بالمفتاح رقم ${keysChecked} (${response.status}): ${shortError(data?.error?.message || raw || response.statusText)}`;
      if (response.status === 401) continue;
      if (response.status === 429 || response.status >= 500 || response.status === 403 || response.status === 404) continue;
    } catch (error: any) {
      lastMessage = shortError(error?.name === 'TimeoutError' ? 'تجاوز اختبار Gemini 15 ثانية دون نتيجة.' : error?.message);
    }
  }
  return { configured: true, ok: false, latencyMs: Date.now() - startedAt, cloudKeysReadable, keysChecked, message: lastMessage };
}

/** * GET is metadata-only and never consumes model-generation quota. * POST is an explicit admin action that tests real text generation on both providers. */
export default async function handler(req: any, res: any) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method Not Allowed' });

  try {
    requireAdmin(req);
    if (req.method === 'GET') {
      const openrouterConfigured = Boolean(process.env.OPENROUTER_API_KEY?.trim());
      let geminiKeys = getVercelGeminiKeys();
      let cloudKeysReadable = true;
      try {
        for (const key of await fetchServerCloudGeminiKeys()) if (!geminiKeys.includes(key)) geminiKeys.push(key);
      } catch { cloudKeysReadable = false; }
      return res.status(200).json({
        ok: true,
        tested: false,
        aiReachable: false,
        routing: {
          primary: 'openrouter',
          fallback: 'gemini',
        },
        providers: {
          openrouter: { configured: openrouterConfigured, ok: null, message: openrouterConfigured ? 'المفتاح مضبوط؛ لم يتم توليد نص في هذا الفحص التلقائي.' : 'مفتاح OpenRouter غير مضبوط.' },
          gemini: { configured: geminiKeys.length > 0, ok: null, keysCount: geminiKeys.length, cloudKeysReadable, message: geminiKeys.length ? 'المفاتيح موجودة؛ لم يتم توليد نص في هذا الفحص التلقائي.' : 'لا توجد مفاتيح Gemini متاحة.' },
        },
        message: 'هذا فحص إعدادات فقط ولا يستهلك حصة توليد. اضغط «اختبار فعلي للمزوّدين» للتحقق من توليد إجابة حقيقية.',
      });
    }

    const [openrouter, gemini] = await Promise.all([testOpenRouterGeneration(), testGeminiGeneration()]);
    const ok = openrouter.ok && gemini.ok;
    return res.status(openrouter.ok || gemini.ok ? 200 : 502).json({
      ok,
      tested: true,
      aiReachable: openrouter.ok || gemini.ok,
      routing: {
        primary: 'openrouter',
        fallback: 'gemini',
      },
      latencyMs: Math.max(openrouter.latencyMs, gemini.latencyMs),
      providers: { openrouter, gemini },
      message: ok
        ? 'نجح التوليد الفعلي من OpenRouter وGemini.'
        : openrouter.ok || gemini.ok
          ? 'أحد المزوّدين نجح والآخر فشل. راجع حالة كل مزوّد أدناه؛ التطبيق قد يواصل العمل عبر المزوّد السليم.'
          : 'فشل التوليد الفعلي من المزوّدين. راجع رسائل الخطأ وإعدادات المفاتيح والحصص.',
    });
  } catch (error: any) {
    const status = Number(error?.statusCode) || 401;
    return res.status(status).json({ ok: false, tested: false, aiReachable: false, message: error?.message || 'تعذر إجراء فحص الاتصال بصلاحيات الإدارة.' });
  }
}
