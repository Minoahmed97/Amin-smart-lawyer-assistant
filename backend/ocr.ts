import mammoth from 'mammoth';
import { executeWithDedicatedOCRKeyRotation, checkDedicatedOCRGeminiReadiness, GEMINI_MODELS } from './keyRotation.ts';

import { requireActiveSession, consumeOperation } from './auth.ts';
import { validateBase64Payload, limitBodyString } from './security.ts';
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '50mb',
    },
  },
};

export default async function handler(req: any, res: any) {
  if (req.method === 'GET') {
    try {
      await requireActiveSession(req);
      const readiness = await checkDedicatedOCRGeminiReadiness(9000);
      return res.status(readiness.ready ? 200 : 503).json(readiness);
    } catch (err: any) {
      const statusCode = Number(err?.statusCode || err?.status);
      const status = Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600 ? statusCode : 500;
      return res.status(status).json({ ready: false, keyCount: 0, checkedKeys: 0, error: err?.message || 'تعذر فحص جاهزية مجموعة OCR.' });
    }
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }


  try {
    await requireActiveSession(req);
    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {}
    }
    const { base64Data, mimeType, fileName } = body || {};
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
      throw new Error(`تعذر استخراج نص ملف وورد (${fileName || 'المحدد'}).`);
    }

    // 2. الصور تستخدم Gemini مباشرةً، بينما تحتفظ ملفات بي دي إف بمسار المزوّدين وتدوير المفاتيح الحالي.
    // The client compresses images to JPEG even when the original filename is
    // .png or .webp, so prefer the MIME type describing the uploaded bytes.
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

    const ocrPrompt = `استخرج النص من المستند القضائي (${fileName || 'المستند'}) بأعلى أمانة ممكنة للمصدر. هذه مهمة استخراج حرفي وليست مهمة تلخيص أو تحليل قانوني. قواعد الاستخراج الإلزامية: - حافظ على ترتيب الصفحات والفقرات والأسطر قدر الإمكان. - حافظ على الأسماء والأرقام والتواريخ وعلامات الترقيم كما تظهر في الأصل. - لا تصحح النص من عندك ولا تعيد صياغته ولا تلخصه. - لا تستنتج كلمة غير مقروءة ولا تخترع نصاً مفقوداً؛ عند تعذر قراءة جزء واضح استخدم [غير مقروء] بدلاً من التخمين. - لا تضف عناوين أو وقائع أو مواد قانونية أو أحكاماً أو أسماء غير ظاهرة في المستند. - حافظ على الجداول والقوائم والتقسيمات والعناوين قدر الإمكان. - إذا وجدت توقيعاً أو ختماً أو كتابة بخط اليد ولم يكن محتواها مقروءاً، صف وجوده بإيجاز دون اختلاق مضمونه. - أخرج النص المستخرج فقط، دون مقدمة أو تعليق أو تحليل أو ادعاء بأن الدقة مطلقة.`;
    const extractedText = await executeWithDedicatedOCRKeyRotation(async (ai, _key, model) => {
      const response = await ai.models.generateContent({
        skipAdaptiveAnswerLength: true,
        model,
        contents: [
          {
            role: 'user',
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
      } as any);
      const text = response.text?.trim() || '';
      if (!text) {
        // Treat an empty model response as a failed attempt so the existing
        // provider/model/key rotation can continue instead of stopping early.
        throw Object.assign(new Error(`لم يُرجع النموذج ${model} نصاً مستخرجاً صالحاً.`), {
          status: 503,
          statusCode: 503,
        });
      }
      return text;
    }, GEMINI_MODELS, 240000);

    if (extractedText) {
      const usage = await consumeOperation(req, 'ocr');
      return res.json({ text: extractedText, remainingCredits: usage.remainingCredits, trialRemaining: usage.trialRemaining });
    }
    throw new Error('فشل استخراج النص.');
  } catch (err: any) {
    console.error('OCR Error:', err);
    const statusCode = Number(err?.statusCode || err?.status);
    const status = Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600 ? statusCode : 500;
    return res.status(status).json({ error: err.message || 'حدث خطأ أثناء معالجة المستند.' });
  }
}
