import { fetchServerCloudOCRGroqFallbackConfig } from './supabaseSync.ts';

export const GROQ_OCR_VISION_MODEL = 'qwen/qwen3.6-27b';

function groqErrorMessage(status: number, body: any): string {
  if (status === 401 || status === 403) return 'مفتاح Groq الاحتياطي غير صالح أو لا يملك صلاحية الوصول. افحص المفتاح من إدارة المنصة.';
  if (status === 429) return 'وصل احتياطي Groq إلى حد الاستخدام المؤقت. انتظر تجدد الحصة أو راجع حدود Groq؛ لم يتم إخفاء هذا الفشل.';
  if (status === 400 || status === 404) return 'رفض Groq طلب OCR أو النموذج المحدد. راجع إعداد نموذج الرؤية المتاح لحسابك.';
  if (status >= 500) return 'خدمة الرؤية في Groq غير متاحة مؤقتاً. أعد المحاولة بعد قليل.';
  const message = String(body?.error?.message || body?.message || '').slice(0, 180);
  return `فشل اتصال OCR الاحتياطي بـ Groq (${status})${message ? `: ${message}` : '.'}`;
}

async function groqChatCompletion(apiKey: string, model: string, messages: any[], maxCompletionTokens: number, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model || GROQ_OCR_VISION_MODEL,
        messages,
        temperature: 0.1,
        max_completion_tokens: maxCompletionTokens,
        stream: false,
      }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error: any = new Error(groqErrorMessage(response.status, body));
      error.statusCode = response.status === 429 ? 429 : response.status >= 500 ? 503 : response.status >= 400 ? 502 : 500;
      throw error;
    }
    const text = body?.choices?.[0]?.message?.content;
    const output = typeof text === 'string' ? text.trim() : Array.isArray(text)
      ? text.map((part: any) => typeof part?.text === 'string' ? part.text : '').join('').trim()
      : '';
    if (!output) {
      const error: any = new Error('أعاد Groq استجابة فارغة أثناء استخراج النص.');
      error.statusCode = 502;
      throw error;
    }
    return output;
  } catch (error: any) {
    if (controller.signal.aborted) {
      const timeoutError: any = new Error('انتهت مهلة خدمة OCR الاحتياطية في Groq. أعد المحاولة بعد قليل.');
      timeoutError.statusCode = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function testGroqOCRKey(apiKey: string, model = GROQ_OCR_VISION_MODEL): Promise<{ success: boolean; message: string; latencyMs?: number }> {
  const key = String(apiKey || '').trim();
  if (!key.startsWith('gsk_') || key.length < 20) {
    return { success: false, message: 'صيغة مفتاح Groq غير صحيحة. تأكد من نسخ المفتاح كاملاً.' };
  }
  const started = Date.now();
  try {
    await groqChatCompletion(key, model, [{ role: 'user', content: 'Reply with OK only.' }], 8, 12000);
    return { success: true, message: `اتصال Groq يعمل والنموذج ${model} متاح.`, latencyMs: Date.now() - started };
  } catch (error: any) {
    return { success: false, message: error?.message || 'تعذر اختبار مفتاح Groq.', latencyMs: Date.now() - started };
  }
}

export async function extractTextWithGroqOCR(base64Data: string, mimeType: string, fileName: string): Promise<string> {
  const config = await fetchServerCloudOCRGroqFallbackConfig();
  if (!config.enabled || !config.apiKey) throw new Error('احتياطي Groq لـ OCR غير مفعل أو لم يتم حفظ مفتاحه من إدارة المنصة.');
  if (!String(mimeType || '').toLowerCase().startsWith('image/')) {
    const error: any = new Error('نفدت حصة Gemini، لكن احتياطي Groq الحالي يدعم الصور فقط وليس ملفات PDF مباشرة. حوّل صفحات PDF إلى صور أو انتظر تجدد حصة Gemini.');
    error.statusCode = 503;
    throw error;
  }
  const safeMime = ['image/jpeg', 'image/png', 'image/webp'].includes(String(mimeType).toLowerCase())
    ? String(mimeType).toLowerCase()
    : 'image/jpeg';
  const prompt = `استخرج النص الظاهر من المستند القانوني (${String(fileName || 'المستند').slice(0, 180)}) استخراجاً حرفياً. حافظ على اللغة العربية والأسماء والأرقام والتواريخ وعلامات الترقيم وترتيب الصفحات والفقرات والأسطر قدر الإمكان. في الكتابة اليدوية، بما فيها محاضر الشرطة المصرية وتحقيقات النيابة، افحص شكل الحروف واتصالها والنقاط والكلمات المحيطة، واستخدم السياق القانوني فقط لترجيح قراءة تؤيدها العلامات المرئية؛ لا تستكمل عبارة متوقعة لمجرد شيوعها ولا تجعل السياق بديلاً عن الحروف غير الظاهرة. لا تصحح الإملاء أو النحو ولا تعِد الصياغة ولا تحوّل النص إلى صياغة قانونية مألوفة. إذا بقيت كلمة غير مؤكدة فاكتب حرفياً [كلمة غير واضحة] مكانها ولا تخمّنها، مع إبقاء الكلمات المقروءة حولها كما هي. لا تضف أسماء أو وقائع أو أرقاماً أو تواريخ أو نصوصاً غير ظاهرة. إذا ظهر توقيع أو ختم غير مقروء، فاذكر وجوده فقط دون اختلاق مضمونه. أخرج النص المستخرج فقط دون مقدمة أو تعليق أو تحليل.`;
  return groqChatCompletion(config.apiKey, config.model || GROQ_OCR_VISION_MODEL, [{
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: `data:${safeMime};base64,${base64Data}` } },
    ],
  }], 8192, 90000);
}

export async function testSavedGroqOCRFallback(): Promise<{ success: boolean; message: string; latencyMs?: number }> {
  const config = await fetchServerCloudOCRGroqFallbackConfig(true);
  if (!config.apiKey) return { success: false, message: 'لم يتم حفظ مفتاح Groq بعد.' };
  return testGroqOCRKey(config.apiKey, config.model || GROQ_OCR_VISION_MODEL);
}
