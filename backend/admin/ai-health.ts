import { requireAdmin } from '../auth.ts';
import { getVercelGeminiKeys, testGeminiKey } from '../keyRotation.ts';
import { fetchServerCloudGeminiKeys } from '../supabaseSync.ts';

function shortError(value: unknown): string {
  return String(value || 'سبب غير معروف').replace(/\s+/g, ' ').slice(0, 240);
}

function maskKey(key: string): string {
  const clean = String(key || '').trim();
  return clean.length > 8 ? `${clean.slice(0, 4)}…${clean.slice(-4)}` : '••••';
}

async function testGroqGeneration() {
  const apiKey = String(process.env.GROQ_API_KEY || '').trim();
  if (!apiKey) return { configured: false, ok: false, latencyMs: 0, message: 'احتياطي Groq غير مضبوط؛ أضف GROQ_API_KEY إلى متغيرات Vercel.' };
  const startedAt = Date.now();
  const model = String(process.env.GROQ_MODEL || 'openai/gpt-oss-120b').trim();
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with exactly OK.' }], max_tokens: 8, temperature: 0 }),
      signal: AbortSignal.timeout(20000),
    });
    const raw = await response.text();
    let data: any = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch {}
    const content = data?.choices?.[0]?.message?.content;
    const generatedText = typeof content === 'string' ? content.trim() : '';
    if (response.ok && generatedText) {
      return { configured: true, ok: true, latencyMs: Date.now() - startedAt, model: data?.model || model, message: `نجح الاتصال والتوليد الفعلي عبر Groq Direct باستخدام ${data?.model || model}.` };
    }
    return { configured: true, ok: false, latencyMs: Date.now() - startedAt, model, message: `فشل اختبار Groq (${response.status}): ${shortError(data?.error?.message || raw || response.statusText)}` };
  } catch (error: any) {
    return { configured: true, ok: false, latencyMs: Date.now() - startedAt, model, message: shortError(error?.name === 'TimeoutError' ? 'تجاوز اختبار Groq مهلة 20 ثانية.' : error?.message) };
  }
}

async function testGeminiGeneration() {
  const startedAt = Date.now();
  let keys = getVercelGeminiKeys();
  let cloudKeysReadable = true;
  try {
    for (const key of await fetchServerCloudGeminiKeys()) if (!keys.includes(key)) keys.push(key);
  } catch (error) {
    cloudKeysReadable = false;
    if (!keys.length) return { configured: false, ok: false, latencyMs: Date.now() - startedAt, cloudKeysReadable, keysChecked: 0, attempts: 0, message: `تعذر قراءة مفاتيح Gemini من Supabase: ${shortError((error as any)?.message)}` };
  }
  if (!keys.length) return { configured: false, ok: false, latencyMs: Date.now() - startedAt, cloudKeysReadable, keysChecked: 0, attempts: 0, message: 'لا توجد مفاتيح Gemini في متغيرات Vercel أو لوحة الإدارة.' };

  // Listing models is metadata-only. A 503 from one model means that endpoint is
  // overloaded, not that the key is invalid. Test a few alternate supported
  // models/keys with tiny outputs to avoid unnecessary quota usage.
  let keysChecked = 0;
  let attempts = 0;
  const triedModels: string[] = [];
  let lastFailure = 'لم يرجع أي نموذج نتيجة.';
  const maxGenerationAttempts = 4;
  const preferredModelNames = [
    'models/gemini-3.8-flash',
    'models/gemini-3.6-flash',
    'models/gemini-3.5-flash',
    'models/gemini-3.5-flash-lite',
  ];

  for (const key of keys.slice(0, 3)) {
    keysChecked += 1;
    try {
      const listResponse = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=100', {
        method: 'GET',
        headers: { 'x-goog-api-key': key },
        signal: AbortSignal.timeout(8000),
      });
      const listRaw = await listResponse.text();
      let listData: any = {};
      try { listData = listRaw ? JSON.parse(listRaw) : {}; } catch {}
      if (!listResponse.ok) {
        const status = Number(listData?.error?.code || listResponse.status);
        lastFailure = `تعذر قراءة قائمة نماذج Gemini (${status}): ${shortError(listData?.error?.message || listRaw || listResponse.statusText)}`;
        continue;
      }

      const models = Array.isArray(listData?.models) ? listData.models : [];
      const generationModels = models.filter((item: any) =>
        typeof item?.name === 'string' &&
        Array.isArray(item?.supportedGenerationMethods) &&
        item.supportedGenerationMethods.includes('generateContent') &&
        !/gemini-2\.5-(flash|pro)/i.test(String(item.name))
      );
      const candidates = [
        ...preferredModelNames.map((name) => generationModels.find((item: any) => item.name === name)).filter(Boolean),
        ...generationModels.filter((item: any) => !preferredModelNames.includes(item.name)),
      ].filter((item: any, index: number, arr: any[]) => arr.findIndex((x) => x.name === item.name) === index).slice(0, 4);

      if (!candidates.length) {
        lastFailure = 'المفتاح وصل إلى Gemini، لكن قائمة النماذج لا تعرض نموذجًا متاحًا يدعم generateContent.';
        continue;
      }

      for (const model of candidates) {
        if (attempts >= maxGenerationAttempts) break;
        const modelName = String(model.name).replace(/^models\//, '');
        triedModels.push(modelName);
        attempts += 1;
        try {
          const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent`, {
            method: 'POST',
            headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: 'Return only the word OK. Do not add punctuation or explanation.' }] }],
              generationConfig: { maxOutputTokens: 16, temperature: 0 },
            }),
            signal: AbortSignal.timeout(10000),
          });
          const raw = await response.text();
          let data: any = {};
          try { data = raw ? JSON.parse(raw) : {}; } catch {}
          const generatedText = (data?.candidates?.[0]?.content?.parts || [])
            .map((part: any) => part?.text || '').join('').trim();
          if (response.ok && generatedText) {
            return {
              configured: true, ok: true, latencyMs: Date.now() - startedAt, cloudKeysReadable, keysChecked, attempts,
              model: modelName, triedModels,
              message: `نجح توليد نص فعلي من Gemini عبر ${modelName}${triedModels.length > 1 ? ` بعد تجاوز نموذج مشغول (${triedModels.slice(0, -1).join('، ')})` : ''}.`,
            };
          }
          const status = Number(data?.error?.code || response.status);
          const finishReason = String(data?.candidates?.[0]?.finishReason || '');
          const detail = data?.error?.message ||
            (response.ok && !generatedText
              ? `وصل HTTP ${response.status} لكن لم يصل نص فعلي. finishReason=${finishReason || 'غير محدد'}؛ maxOutputTokens=16.`
              : raw || response.statusText);
          lastFailure = `فشل توليد Gemini (${status}) عبر ${modelName}: ${shortError(detail)}`;
          // 503/404/400: try another model. Credential/quota errors move to the next key.
          if (status === 401 || status === 403 || status === 429) break;
        } catch (error: any) {
          lastFailure = shortError(error?.name === 'TimeoutError' ? `تجاوز اختبار Gemini مهلة الاتصال عبر ${modelName}.` : error?.message);
        }
      }
    } catch (error: any) {
      lastFailure = shortError(error?.name === 'TimeoutError' ? 'تجاوز اختبار قائمة نماذج Gemini مهلة الاتصال.' : error?.message);
    }
    if (attempts >= maxGenerationAttempts) break;
  }

  const temporary = /\(503\)|\(504\)|high demand|overloaded|temporarily unavailable|service unavailable/i.test(lastFailure);
  return {
    configured: true, ok: false, latencyMs: Date.now() - startedAt, cloudKeysReadable, keysChecked, attempts, triedModels,
    temporary,
    message: temporary
      ? `مفاتيح Gemini موجودة، لكن النماذج المختبرة مشغولة مؤقتًا لدى Google. هذا لا يثبت أن المفتاح تالف. آخر نتيجة: ${shortError(lastFailure)}`
      : lastFailure,
  };
}

/** GET and POST health checks use metadata-only requests; neither route generates model text. */
export default async function handler(req: any, res: any) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method Not Allowed' });

  try {
    requireAdmin(req);
    const verifyMetadataRequested = req.method === 'POST' || String(req.headers?.['x-ai-health-check'] || '') === 'metadata' || String(req.query?.verify || '') === '1';
    if (req.method === 'GET' && !verifyMetadataRequested) {
      const groqConfigured = Boolean(process.env.GROQ_API_KEY?.trim());
      let geminiKeys = getVercelGeminiKeys();
      let cloudKeysReadable = true;
      try {
        for (const key of await fetchServerCloudGeminiKeys()) if (!geminiKeys.includes(key)) geminiKeys.push(key);
      } catch { cloudKeysReadable = false; }
      return res.status(200).json({
        ok: true,
        tested: false,
        checkType: 'configuration',
        aiReachable: false,
        routing: { primary: 'gemini', fallback: 'groq' },
        providers: {
          gemini: { configured: geminiKeys.length > 0, ok: null, keysCount: geminiKeys.length, cloudKeysReadable, message: geminiKeys.length ? 'المفاتيح موجودة؛ لم يتم الاتصال بمزود خارجي في الفحص التلقائي.' : 'لا توجد مفاتيح Gemini متاحة.' },
          groq: { configured: groqConfigured, ok: null, model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b', message: groqConfigured ? 'مفتاح Groq مضبوط؛ لم يتم اختبار التوليد في الفحص التلقائي.' : 'أضف GROQ_API_KEY لتفعيل الاحتياطي.' },
        },
        message: 'عرض الإعدادات فقط؛ لم يتم إرسال أي طلب إلى مزودي الذكاء الاصطناعي. استخدم زر «فحص المفاتيح دون توليد» للتحقق من بيانات الاعتماد والاستخدام دون توليد نص.',
      });
    }

    if (req.method === 'GET' || req.method === 'POST') {
      const startedAt = Date.now();
      const groqConfigured = Boolean(process.env.GROQ_API_KEY?.trim());
      let geminiKeys = getVercelGeminiKeys();
      let cloudKeysReadable = true;
      try {
        for (const key of await fetchServerCloudGeminiKeys()) if (!geminiKeys.includes(key)) geminiKeys.push(key);
      } catch {
        cloudKeysReadable = false;
      }

      // فحص الوصول لكل مفتاح Gemini باستخدام GET لبيانات النموذج فقط؛ لا يتم توليد نص.
      const geminiKeyResults = await Promise.all(geminiKeys.map(async (key, index) => {
        const result = await testGeminiKey(key, 7000);
        return {
          index: index + 1,
          masked: maskKey(key),
          valid: result.success,
          status: result.success ? 'valid' : 'unverified_or_rejected',
          message: result.message,
        };
      }));
      
      const validGeminiKeys = geminiKeyResults.filter((item) => item.valid).length;
      const geminiConfigured = geminiKeys.length > 0;
      const geminiOk = validGeminiKeys > 0;
      const aiReachable = geminiOk || groqConfigured;
      return res.status(200).json({
        ok: aiReachable,
        tested: false,
        checkType: 'metadata',
        aiReachable,
        routing: { primary: 'gemini', fallback: 'openrouter' },
        latencyMs: Date.now() - startedAt,
        cloudKeysReadable,
        checkedKeys: geminiKeyResults.length,
        providers: {
          gemini: {
            configured: geminiConfigured,
            ok: geminiConfigured ? geminiOk : false,
            keysCount: geminiKeys.length,
            keysChecked: geminiKeyResults.length,
            validKeys: validGeminiKeys,
            cloudKeysReadable,
            keyResults: geminiKeyResults,
            quotaRemaining: null,
            message: !geminiConfigured
              ? 'لا توجد مفاتيح Gemini في متغيرات الخادم أو لوحة الإدارة.'
              : `تم فحص ${geminiKeyResults.length} مفتاح Gemini دون توليد نص؛ ${validGeminiKeys} مفتاح وصل إلى بيانات النموذج. لا تعرض واجهة Gemini العامة مقدار حصة التوليد المتبقية من هذا الفحص، لذا حالة الحصة غير معروفة هنا.`,
          },
          groq: { configured: groqConfigured, ok: null, model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b', message: groqConfigured ? 'مفتاح Groq مضبوط؛ لم يتم توليد نص في فحص البيانات الوصفية.' : 'أضف GROQ_API_KEY لتفعيل الاحتياطي.' },
        },
        message: 'فحص بيانات الاتصال فقط دون توليد نص. Gemini هو المزود الأساسي وGroq Direct هو الاحتياطي. يمكن التحقق من قبول مفتاح Gemini دون استهلاك حصة التوليد، لكن لا يمكن معرفة المتبقي الدقيق لحصة Gemini من واجهة الفحص هذه.',
      });
    }

    const [groq, gemini] = await Promise.all([testGroqGeneration(), testGeminiGeneration()]);
    // This explicit diagnostic still performs generation; report the actual configured priority.
    const ok = groq.ok || gemini.ok;
    const degraded = !groq.ok || !gemini.ok;
    return res.status(ok ? 200 : 502).json({
      ok,
      degraded,
      tested: true,
      aiReachable: groq.ok || gemini.ok,
      routing: {
        primary: 'gemini',
        fallback: 'openrouter',
      },
      latencyMs: Math.max(groq.latencyMs, gemini.latencyMs),
      providers: { groq, gemini },
      message: groq.ok && gemini.ok
        ? 'نجح التوليد الفعلي من OpenRouter وGemini.'
         : groq.ok
          ? (gemini.temporary
            ? 'Gemini مشغول مؤقتًا؛ نجح اختبار Groq Direct الاحتياطي.'
            : 'Groq Direct يعمل كاحتياطي، لكن فحص Gemini الأساسي لم ينجح. راجع تفاصيل Gemini أدناه.')
          : gemini.ok
            ? 'Gemini يعمل، لكن فحص Groq Direct الاحتياطي يحتاج مراجعة.'
            : 'فشل التوليد الفعلي من Gemini وGroq Direct. راجع رسائل الخطأ وإعدادات المفاتيح والحصص.',
    });
  } catch (error: any) {
    const status = Number(error?.statusCode) || 401;
    return res.status(status).json({ ok: false, tested: false, aiReachable: false, message: error?.message || 'تعذر إجراء فحص الاتصال بصلاحيات الإدارة.' });
  }
}
