import { fetchServerCloudOCRGroqFallbackConfig } from './supabaseSync.ts';

// استخدم أحد نماذج الرؤية المعتمدة رسمياً من Groq مثل llama-3.2-11b-vision-preview أو 90b
export const GROQ_OCR_VISION_MODEL = 'meta-llama/llama-3.2-11b-vision-preview';

function groqErrorMessage(status: number, body: any): string {
  // طباعة الاستجابة الكاملة في وحدة التحكم لتسهيل الـ Debugging
  console.error('Groq API Error Response Body:', JSON.stringify(body, null, 2));

  const apiMessage = body?.error?.message || body?.message || '';
  
  if (status === 401 || status === 403) return 'مفتاح Groq الاحتياطي غير صالح أو لا يملك صلاحية الوصول. افحص المفتاح من إدارة المنصة.';
  if (status === 429) return 'وصل احتياطي Groq إلى حد الاستخدام المؤقت (Rate Limit). انتظر تجدد الحصة أو راجع حدود حسابك.';
  if (status === 400) return `رفض Groq الطلب (400): ${apiMessage || 'تأكد من أن النموذج يدعم الرؤية وأن حجم الصورة مناسب.'}`;
  if (status === 404) return `النموذج المحدد غير موجود أو غير مدعوم (404): ${apiMessage}`;
  if (status >= 500) return 'خدمة الرؤية في Groq غير متاحة مؤقتاً (خطأ خادم). أعد المحاولة بعد قليل.';
  
  return `فشل اتصال OCR الاحتياطي بـ Groq (${status})${apiMessage ? `: ${apiMessage}` : '.'}`;
}

async function groqChatCompletion(apiKey: string, model: string, messages: any[], maxCompletionTokens: number, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  
  const selectedModel = model && model.trim() !== '' ? model : GROQ_OCR_VISION_MODEL;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: selectedModel,
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
    const output = typeof text === 'string' 
      ? text.trim() 
      : Array.isArray(text)
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
      const timeoutError: any = new Error('انتهت مهلة خدمة OCR الاحتياطية في Groq (Timeout). أعد المحاولة بعد قليل.');
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
    return { success: false, message: 'صيغة مفتاح Groq غير صحيحة. يجب أن تبدأ بـ gsk_ وتكون أطول.' };
  }
  const started = Date.now();
  try {
    await groqChatCompletion(key, model, [{ role: 'user', content: 'Reply with OK only.' }], 8, 12000);
    return { success: true, message: `اتصال Groq يعمل والنموذج (${model}) متاح.`, latencyMs: Date.now() - started };
  } catch (error: any) {
    return { success: false, message: error?.message || 'تعذر اختبار مفتاح Groq.', latencyMs: Date.now() - started };
  }
}

export async function extractTextWithGroqOCR(base64Data: string, mimeType: string, fileName: string): Promise<string> {
  const config = await fetchServerCloudOCRGroqFallbackConfig();
  if (!config.enabled || !config.apiKey) {
    throw new Error('احتياطي Groq لـ OCR غير مفعل أو لم يتم حفظ مفتاحه من إدارة المنصة.');
  }

  if (!String(mimeType || '').toLowerCase().startsWith('image/')) {
    const error: any = new Error('نفدت حصة Gemini، لكن احتياطي Groq الحالي يدعم الصور فقط وليس ملفات PDF مباشرة. حوّل صفحات PDF إلى صور أو انتظر تجدد حصة Gemini.');
    error.statusCode = 503;
    throw error;
  }

  // تنظيف وتأكيد صيغة الـ Base64 (إزالة أي بادئة قد تكون مرفقة بالخطأ مثل data:image/...;base64,)
  let cleanBase64 = String(base64Data || '').trim();
  if (cleanBase64.includes('base64,')) {
    cleanBase64 = cleanBase64.split('base64,')[1];
  }

  const safeMime = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(String(mimeType).toLowerCase())
    ? String(mimeType).toLowerCase()
    : 'image/jpeg';

  const prompt = `استخرج النص الظاهر من المستند القانوني (${String(fileName || 'المستند').slice(0, 180)}) استخراجاً حرفياً. حافظ على اللغة العربية والأسماء والأرقام والتواريخ وعلامات الترقيم وترتيب الصفحات والفقرات والأسطر قدر الإمكان. في الكتابة اليدوية، بما فيها محاضر الشرطة المصرية وتحقيقات النيابة، افحص شكل الحروف واتصالها والنقاط والكلمات المحيطة، واستخدم السياق القانوني فقط لترجيح قراءة تؤيدها العلامات المرئية؛ لا تستكمل عبارة متوقعة لمجرد شيوعها ولا تجعل السياق بديلاً عن الحروف غير الظاهرة. لا تصحح الإملاء أو النحو ولا تعِد الصياغة ولا تحوّل النص إلى صياغة قانونية مألوفة. إذا بقيت كلمة غير مؤكدة فاكتب حرفياً [كلمة غير واضحة] مكانها ولا تخمّنها، مع إبقاء الكلمات المقروءة حولها كما هي. لا تضف أسماء أو وقائع أو أرقاماً أو تواريخ أو نصوصاً غير ظاهرة. إذا ظهر توقيع أو ختم غير مقروء، فاذكر وجوده فقط دون اختلاق مضمونه. أخرج النص المستخرج فقط دون مقدمة أو تعليق أو تحليل.`;

  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: `data:${safeMime};base64,${cleanBase64}` } },
    ],
  }];

  const modelToUse = config.model || GROQ_OCR_VISION_MODEL;
  return groqChatCompletion(config.apiKey, modelToUse, messages, 8192, 90000);
}

export async function testSavedGroqOCRFallback(): Promise<{ success: boolean; message: string; latencyMs?: number }> {
  const config = await fetchServerCloudOCRGroqFallbackConfig(true);
  if (!config.apiKey) return { success: false, message: 'لم يتم حفظ مفتاح Groq بعد.' };
  return testGroqOCRKey(config.apiKey, config.model || GROQ_OCR_VISION_MODEL);
}
