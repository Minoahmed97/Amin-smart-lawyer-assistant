import mammoth from 'mammoth';
import { executeWithKeyRotation, GEMINI_MODELS } from './keyRotation.ts';

import { requireActiveSession, consumeOperation } from './auth.ts';
import { rateLimit, validateBase64Payload, limitBodyString } from './security.ts';
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '50mb',
    },
  },
};

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  let streamStarted = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const sendStreamEvent = (event: Record<string, unknown>) => {
    if (streamStarted && !res.writableEnded && !res.destroyed) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };
  const startStream = () => {
    if (streamStarted) return;
    streamStarted = true;
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    sendStreamEvent({ type: 'start' });
    // Keep the browser/Vercel connection alive while Gemini reads long documents.
    heartbeat = setInterval(() => sendStreamEvent({ type: 'keepalive' }), 5000);
  };

  try {
    rateLimit(req, 'ocr', 12, 10 * 60 * 1000);
    await requireActiveSession(req);
    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {}
    }
    const { base64Data, mimeType, fileName } = body || {};
    const wantsStream = body?.stream === true;
    const compactBase64 = validateBase64Payload(base64Data, 20 * 1024 * 1024);
    limitBodyString(fileName, 255, 'اسم الملف');
    const lowerMime = String(mimeType || '').toLowerCase();
    const lowerName = String(fileName || '').toLowerCase();
    const allowed = ['application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','image/jpeg','image/png','image/webp','image/bmp'];
    const allowedExt = /\.(pdf|doc|docx|jpe?g|png|webp|bmp)$/i.test(lowerName);
    if (!allowedExt || (lowerMime && !allowed.includes(lowerMime))) {
      return res.status(400).json({ error: 'نوع الملف غير مدعوم.' });
    }


    const isWord =
      (mimeType && (mimeType.includes('wordprocessingml') || mimeType.includes('msword'))) ||
      lowerName.endsWith('.docx') ||
      lowerName.endsWith('.doc');

    // 1. If Word document
    if (isWord) {
      const fileBuffer = Buffer.from(compactBase64, 'base64');
      try {
        const mammothResult = await mammoth.extractRawText({ buffer: fileBuffer });
        if (mammothResult.value && mammothResult.value.trim().length > 0) {
          const usage = await consumeOperation(req, 'ocr');
          return res.json({ text: mammothResult.value.trim(), remainingCredits: usage.remainingCredits, trialRemaining: usage.trialRemaining });
        }
      } catch (wordErr) {
        console.warn('Word extraction fallback:', wordErr);
      }

      try {
        const utf8Text = fileBuffer.toString('utf8');
        const utf16Text = fileBuffer.toString('utf16le');
        const combined = `${utf8Text}\n${utf16Text}`;
        const arabicAndTextChunks = combined.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FFa-zA-Z0-9\s.,;:!?()-]{4,}/g);
        if (arabicAndTextChunks && arabicAndTextChunks.length > 0) {
          const clean = arabicAndTextChunks
            .join(' ')
            .replace(/\s+/g, ' ')
            .replace(/<[^>]+>/g, '')
            .trim();
          if (clean.length > 30) {
            const usage = await consumeOperation(req, 'ocr');
            return res.json({ text: clean, remainingCredits: usage.remainingCredits, trialRemaining: usage.trialRemaining });
          }
        }
      } catch {}
      throw new Error(`تعذر استخراج نص ملف Word (${fileName || 'المحدد'}).`);
    }

    // 2. Images and PDF OCR via Gemini Vision.
    // Use the MIME type of the actual bytes, not the filename: the client resizes
    // images to JPEG even when the original filename ends in .png or .webp.
    let safeGeminiMime = 'image/jpeg';
    if (lowerMime === 'application/pdf' || lowerName.endsWith('.pdf')) {
      safeGeminiMime = 'application/pdf';
    } else if (lowerMime === 'image/png') {
      safeGeminiMime = 'image/png';
    } else if (lowerMime === 'image/webp') {
      safeGeminiMime = 'image/webp';
    } else if (lowerMime === 'image/bmp') {
      safeGeminiMime = 'image/bmp';
    }

    if (wantsStream) startStream();
    const isImageOcr = safeGeminiMime.startsWith('image/');

    const ocrPrompt = `استخرج النص من المستند القضائي (${fileName || 'المستند'}) بأعلى أمانة ممكنة للمصدر. هذه مهمة استخراج حرفي وليست مهمة تلخيص أو تحليل قانوني. قواعد الاستخراج الإلزامية: - حافظ على ترتيب الصفحات والفقرات والأسطر قدر الإمكان. - حافظ على الأسماء والأرقام والتواريخ وعلامات الترقيم كما تظهر في الأصل. - لا تصحح النص من عندك ولا تعيد صياغته ولا تلخصه. - لا تستنتج كلمة غير مقروءة ولا تخترع نصاً مفقوداً؛ عند تعذر قراءة جزء واضح استخدم [غير مقروء] بدلاً من التخمين. - لا تضف عناوين أو وقائع أو مواد قانونية أو أحكاماً أو أسماء غير ظاهرة في المستند. - حافظ على الجداول والقوائم والتقسيمات والعناوين قدر الإمكان. - إذا وجدت توقيعاً أو ختماً أو كتابة بخط اليد ولم يكن محتواها مقروءاً، صف وجوده بإيجاز دون اختلاق مضمونه. - أخرج النص المستخرج فقط، دون مقدمة أو تعليق أو تحليل أو ادعاء بأن الدقة مطلقة.`;
    const extractedText = await executeWithKeyRotation(async (ai, _key, model) => {
      const requestOptions: any = {
        model,
        // OCR is literal extraction, not legal drafting; do not append the global drafting instruction.
        skipAdaptiveAnswerLength: true,
        contents: [
          {
            role: 'user',
            // Keep the OCR instructions before the image for text-heavy OCR.
            // Preserve the existing provider fallback chain so OCR can still
            // use OpenRouter when Gemini keys or Gemini service are unavailable.
            parts: [
              {
                text: ocrPrompt,
              },
              {
                inlineData: {
                  mimeType: safeGeminiMime,
                  data: compactBase64,
                },
              },
            ],
          },
        ],
        config: {
          temperature: 0.2,
          maxOutputTokens: 32768,
        },
      };
      // Keep each OpenRouter OCR attempt bounded. OCR-specific key rotation tries
      // one vision-capable free router first, then switches to the existing Gemini fallback.
      if (_key === 'openrouter') requestOptions.requestTimeoutMs = isImageOcr ? 18000 : 25000;
      const response = await ai.models.generateContent(requestOptions);
      const text = response.text?.trim() || '';
      if (!text) {
        // Throw inside the rotation callback so the next model/key is tried.
        // Returning an empty string would be treated as a successful API call
        // and bypass all configured OCR fallbacks.
        throw Object.assign(new Error(`لم يُرجع النموذج ${model} نصاً مستخرجاً صالحاً.`), { status: 503, statusCode: 503 });
      }
      return text;
    }, GEMINI_MODELS, undefined, false, { ocrMode: isImageOcr });

    if (extractedText) {
      const usage = await consumeOperation(req, 'ocr');
      const result = {
        text: extractedText,
        remainingCredits: usage.remainingCredits,
        trialRemaining: usage.trialRemaining,
      };
      if (streamStarted) {
        if (heartbeat) clearInterval(heartbeat);
        sendStreamEvent({ type: 'done', ...result });
        if (!res.writableEnded && !res.destroyed) return res.end();
        return;
      }
      return res.json(result);
    }
    throw new Error('لم تُرجع خدمة OCR نصاً صالحاً بعد تجربة النماذج المتاحة.');
  } catch (err: any) {
    if (heartbeat) clearInterval(heartbeat);
    console.error('OCR Error:', err);
    const statusCode = Number(err?.statusCode || err?.status);
    const status = Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600 ? statusCode : 500;
    const message = err?.message || 'حدث خطأ أثناء معالجة المستند.';
    if (streamStarted) {
      sendStreamEvent({ type: 'error', error: message });
      if (!res.writableEnded && !res.destroyed) return res.end();
      return;
    }
    return res.status(status).json({ error: message });
  }
}
