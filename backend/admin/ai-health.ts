import { requireAdmin } from '../auth.ts';
import { getOpenRouterModels } from '../openrouterAdapter.ts';
import { getVercelGeminiKeys } from '../keyRotation.ts';
import { fetchServerCloudGeminiKeys } from '../supabaseSync.ts';

function shortError(value: unknown): string {
  return String(value || 'سبب غير معروف').replace(/\s+/g, ' ').slice(0, 240);
}

async function testOpenRouterGeneration() {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return { configured: false, ok: false, latencyMs: 0, message: 'مفتاح OpenRouter غير مضبوط على Vercel.' };

  const startedAt = Date.now();
  const models = getOpenRouterModels().slice(0, 2);
  let lastMessage = 'لم يرجع أي نموذج نتيجة.';
  // One tiny generation attempt on the configured router. If the router returns
  // HTTP 200 without actual text, try at most one explicit free model.
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
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
      const choice = data?.choices?.[0];
      const content = choice?.message?.content;
      const generatedText = typeof content === 'string'
        ? content.trim()
        : Array.isArray(content)
          ? content.map((part: any) => typeof part?.text === 'string' ? part.text : '').join('').trim()
          : '';
      if (response.ok && generatedText) {
        return {
          configured: true, ok: true, latencyMs: Date.now() - startedAt,
          model: data?.model || model,
          message: `نجح توليد نص فعلي من OpenRouter عبر ${data?.model || model}.`,
        };
      }

      const finishReason = choice?.finish_reason ? `؛ finish_reason=${String(choice.finish_reason).slice(0, 60)}` : '';
      const returnedModel = data?.model ? `؛ النموذج الفعلي=${String(data.model).slice(0, 100)}` : '';
      const providerError = data?.error?.message || data?.error?.metadata?.raw || '';
      const detail = providerError || (response.ok
        ? `وصل رد HTTP ${response.status} لكن بدون نص في choices[0].message.content${finishReason}${returnedModel}.`
        : (raw || response.statusText));
      lastMessage = `النموذج ${model} فشل (${response.status}): ${shortError(detail)}`;
      // Retry only once for an empty HTTP-200 response or temporary server error.
      if (i + 1 >= models.length || !(response.ok || response.status >= 500 || response.status === 408)) break;
    } catch (error: any) {
      lastMessage = shortError(error?.name === 'TimeoutError' ? 'تجاوز اختبار OpenRouter 20 ثانية دون نتيجة.' : error?.message);
      break;
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

  // Read model metadata first (no text generation). Pick a currently listed model
  // that explicitly supports generateContent, then make one tiny generation call.
  let keysChecked = 1;
  const key = keys[0];
  try {
    const listResponse = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', {
      method: 'GET',
      headers: { 'x-goog-api-key': key },
      signal: AbortSignal.timeout(10000),
    });
    const listRaw = await listResponse.text();
    let listData: any = {};
    try { listData = listRaw ? JSON.parse(listRaw) : {}; } catch {}
    if (!listResponse.ok) {
      const message = String(listData?.error?.message || listRaw || listResponse.statusText);
      return {
        configured: true, ok: false, latencyMs: Date.now() - startedAt, cloudKeysReadable, keysChecked,
        message: `تعذر التحقق من مفتاح Gemini أو قائمة النماذج (${listResponse.status}): ${shortError(message)}`,
      };
    }

    const models = Array.isArray(listData?.models) ? listData.models : [];
    const generationModels = models.filter((item: any) =>
      typeof item?.name === 'string' &&
      Array.isArray(item?.supportedGenerationMethods) &&
      item.supportedGenerationMethods.includes('generateContent')
    );
    // Prefer current stable Flash models. Gemini 2.5 Flash can still appear in
    // some model listings even when Google restricts it for new API users.
    const preferredModelNames = [
      'models/gemini-3.8-flash',
      'models/gemini-3.6-flash',
      'models/gemini-3.5-flash-lite',
      'models/gemini-3.5-flash',
    ];
    const model =
      preferredModelNames.map((name) => generationModels.find((item: any) => item.name === name)).find(Boolean) ||
      generationModels.find((item: any) => !/gemini-2\.5-(flash|pro)/i.test(String(item.name))) ||
      generationModels[0];
    if (!model?.name) {
      return {
        configured: true, ok: false, latencyMs: Date.now() - startedAt, cloudKeysReadable, keysChecked,
        message: 'المفتاح وصل إلى Gemini، لكن قائمة النماذج لا تعرض نموذجًا يدعم generateContent.',
      };
    }

    const modelName = String(model.name).replace(/^models\//, '');
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Reply with exactly OK.' }] }],
        generationConfig: { maxOutputTokens: 8, temperature: 0 },
      }),
      signal: AbortSignal.timeout(15000),
    });
    const raw = await response.text();
    let data: any = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch {}
    const generatedText = (data?.candidates?.[0]?.content?.parts || [])
      .map((part: any) => part?.text || '').join('').trim();
    if (response.ok && generatedText) {
      return {
        configured: true, ok: true, latencyMs: Date.now() - startedAt, cloudKeysReadable, keysChecked,
        model: modelName,
        message: `نجح توليد نص فعلي من Gemini عبر النموذج المتاح ${modelName}.`,
      };
    }

    const status = Number(data?.error?.code || response.status);
    const detail = data?.error?.message || raw || response.statusText;
    return {
      configured: true, ok: false, latencyMs: Date.now() - startedAt, cloudKeysReadable, keysChecked, model: modelName,
      message: `فشل توليد Gemini (${status}) عبر ${modelName}: ${shortError(detail)}`,
    };
  } catch (error: any) {
    return {
      configured: true, ok: false, latencyMs: Date.now() - startedAt, cloudKeysReadable, keysChecked,
      message: shortError(error?.name === 'TimeoutError' ? 'تجاوز اختبار Gemini مهلة الاتصال.' : error?.message),
    };
  }
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
