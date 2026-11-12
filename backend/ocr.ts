import mammoth from 'mammoth';
import { executeWithDedicatedOCRKeyRotation, checkDedicatedOCRGeminiReadiness, GEMINI_MODELS } from './keyRotation.ts';

import { requireActiveSession, consumeOperation } from './auth.ts';
import { fetchServerCloudOCRGroqFallbackConfig } from './supabaseSync.ts';
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
      // If the administrator enabled the server-side Groq vision fallback,
      // don't block image uploads just because the Gemini OCR pool is exhausted.
      try {
        const groqFallback = await fetchServerCloudOCRGroqFallbackConfig();
        if (groqFallback.enabled && groqFallback.apiKey) {
          return res.status(200).json({
            ready: true,
            keyCount: 0,
            checkedKeys: 0,
            fallbackReady: true,
            message: 'احتياطي Groq Vision مفعّل. سيجرب التطبيق Gemini أولاً ثم Groq عند تجاوز حصة Gemini للصور.',
          });
        }
      } catch (fallbackConfigError: any) {
        console.warn('[OCR readiness] Could not read Groq fallback configuration. Gemini readiness will be checked.');
      }
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

    const ocrPrompt = `استخرج النص من المستند القضائي (${fileName || 'المستند'}) بأعلى أمانة ممكنة للمصدر. هذه مهمة استخراج حرفي وليست مهمة تلخيص أو تحليل قانوني. قواعد الاستخراج الإلزامية: - حافظ على ترتيب الصفحات والفقرات والأسطر والجداول والعناوين قدر الإمكان. - حافظ على الأسماء والأرقام والتواريخ وعلامات الترقيم كما تظهر في الأصل، ولا تطبع الأرقام أو تغيّر صيغتها. - تعليمات خاصة بالخط اليدوي: افحص شكل الحروف واتصالها والنقاط والمسافات والكلمات المحيطة، خصوصاً في محاضر الشرطة المصرية وتحقيقات النيابة. استخدم سياق الجملة القانونية وموضوع المحضر لترجيح قراءة بين احتمالات تدعمها العلامات المرئية في الصورة فقط؛ لا تستكمل عبارة متوقعة لمجرد شيوعها، ولا تجعل السياق بديلاً عن الحروف غير الظاهرة. - لا تصحح الإملاء أو النحو، ولا تعِد الصياغة، ولا تستبدل التعبير الأصلي بصياغة قانونية مألوفة. - إذا بقيت كلمة غير مؤكدة بعد فحص الصورة والسياق، فاكتب حرفياً [كلمة غير واضحة] مكانها، ولا تخمّنها ولا تخترع أي كلمة. حافظ على الكلمات المقروءة قبلها وبعدها ولا تستبدل الجملة كلها بعلامة واحدة إذا كانت بعض كلماتها واضحة. - لا تضف وقائع أو أسماء أو أرقاماً أو تواريخ أو مواد قانونية أو أحكاماً غير ظاهرة في المستند. - إذا وجدت توقيعاً أو ختماً لا يمكن قراءة محتواه، فاذكر وجوده بإيجاز من دون نسبة اسم أو مضمون إليه. - أخرج النص المستخرج فقط دون مقدمة أو تعليق أو تحليل، ولا تدّعِ دقة مطلقة.`;

    // PDFs are inspected page by page. Text-only pages use PDF text extraction;
    // scanned or mixed pages are rendered as page images and sent through the
    // same dedicated image-OCR key/model rotation used for ordinary photographs.
    if (lowerMime === 'application/pdf' || lowerName.endsWith('.pdf')) {
      let pdfDocument: any = null;
      let pageImageOcrStarted = false;
      try {
        const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const pdfBytes = Buffer.from(compactBase64, 'base64');
        pdfDocument = await pdfjs.getDocument({
          data: new Uint8Array(pdfBytes),
          useSystemFonts: true,
          isEvalSupported: false,
        }).promise;
        const canvasFactory = pdfDocument.canvasFactory;
        if (!canvasFactory || typeof canvasFactory.create !== 'function') {
          throw new Error('محرك تحويل صفحات PDF إلى صور غير متاح على الخادم.');
        }

        const pageTexts: string[] = new Array(pdfDocument.numPages).fill('');
        const imagePages: Array<{ pageNumber: number; base64: string }> = [];
        const imageOperators = new Set([
          pdfjs.OPS.paintImageXObject,
          pdfjs.OPS.paintInlineImageXObject,
          pdfjs.OPS.paintImageMaskXObject,
          pdfjs.OPS.paintJpegXObject,
          pdfjs.OPS.paintImageXObjectRepeat,
        ].filter((value: any) => typeof value === 'number'));

        for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber++) {
          const page = await pdfDocument.getPage(pageNumber);
          const textContent = await page.getTextContent();
          const pageText = (textContent.items || [])
            .map((item: any) => typeof item?.str === 'string' ? item.str : '')
            .filter(Boolean)
            .join(' ')
            .replace(/[\t ]+/g, ' ')
            .trim();

          let containsImage = false;
          try {
            const operatorList = await page.getOperatorList();
            containsImage = (operatorList.fnArray || []).some((operator: number) => imageOperators.has(operator));
          } catch (inspectionError: any) {
            // If inspection is inconclusive, render the page so image text is not lost.
            containsImage = true;
            console.warn('PDF page image inspection was inconclusive:', inspectionError?.message || inspectionError);
          }

          if (containsImage || !pageText) {
            const baseViewport = page.getViewport({ scale: 1.6 });
            const maxDimension = Math.max(baseViewport.width, baseViewport.height);
            const scale = maxDimension > 2400 ? 1.6 * (2400 / maxDimension) : 1.6;
            const viewport = page.getViewport({ scale });
            const pair = canvasFactory.create(viewport.width, viewport.height);
            try {
              pair.context.fillStyle = '#FFFFFF';
              pair.context.fillRect(0, 0, viewport.width, viewport.height);
              await page.render({
                canvasContext: pair.context,
                viewport,
                canvasFactory,
              }).promise;
              const imageBuffer = pair.canvas.toBuffer('image/jpeg', 92);
              imagePages.push({ pageNumber, base64: imageBuffer.toString('base64') });
            } finally {
              canvasFactory.destroy(pair);
            }
          } else {
            pageTexts[pageNumber - 1] = pageText;
          }
          page.cleanup?.();
        }

        if (imagePages.length === 0 && pageTexts.some((value) => value.trim())) {
          const text = pageTexts.filter(Boolean).join('\n\n').trim();
          const usage = await consumeOperation(req, 'ocr');
          return res.json({ text, remainingCredits: usage.remainingCredits, trialRemaining: usage.trialRemaining });
        }

        if (imagePages.length > 0) {
          const pageImageParts: any[] = [];
          for (const imagePage of imagePages) {
            pageImageParts.push(
              { text: `هذه صورة الصفحة رقم ${imagePage.pageNumber} من ملف PDF. استخرج نص هذه الصفحة فقط، ولا تخلطها بصفحات أخرى.` },
              { inlineData: { mimeType: 'image/jpeg', data: imagePage.base64 } },
            );
          }
          const pagePrompt = `${ocrPrompt}\n\nهذا ملف PDF متعدد الصفحات حُولت صفحاته المصورة إلى صور مستقلة. أخرج نتيجة كل صورة في كتلة مستقلة بهذا الشكل الحرفي: [صفحة 3] مع استبدال الرقم 3 برقم الصفحة الفعلي، ثم النص المستخرج منها. لا تدمج صفحتين في كتلة واحدة، ولا تسقط صفحة، وحافظ على ترتيب أرقام الصفحات.`;
          pageImageOcrStarted = true;
          const visualText = await executeWithDedicatedOCRKeyRotation(async (ai, _key, model) => {
            const response = await ai.models.generateContent({
              skipAdaptiveAnswerLength: true,
              model,
              contents: [{ role: 'user', parts: [{ text: pagePrompt }, ...pageImageParts] }],
              config: { temperature: 0.1, maxOutputTokens: 32768 },
            } as any);
            const result = response.text?.trim() || '';
            if (!result) throw Object.assign(new Error(`لم يُرجع النموذج ${model} نص صفحات PDF المصورة.`), { status: 503, statusCode: 503 });
            return result;
          }, GEMINI_MODELS, 280000);

          const extractedImagePages = new Map<number, string>();
          const markers = Array.from(visualText.matchAll(/\[(?:صفحة|PAGE)\s*(\d+)\]/gi));
          if (imagePages.length === 1 && markers.length === 0) {
            extractedImagePages.set(imagePages[0].pageNumber, visualText);
          } else {
            for (let i = 0; i < markers.length; i++) {
              const pageNumber = Number(markers[i][1]);
              const start = (markers[i].index || 0) + markers[i][0].length;
              const nextStart = i + 1 < markers.length ? (markers[i + 1].index || visualText.length) : visualText.length;
              const pageResult = visualText.slice(start, nextStart).trim();
              if (imagePages.some((item) => item.pageNumber === pageNumber) && pageResult) {
                extractedImagePages.set(pageNumber, pageResult);
              }
            }
          }

          if (imagePages.some((item) => !extractedImagePages.has(item.pageNumber))) {
            throw new Error('لم يمكن فصل النص المستخرج إلى صفحات PDF المصورة بدقة؛ سيُستخدم مسار OCR الأصلي للملف.');
          }

          for (const [pageNumber, text] of extractedImagePages) pageTexts[pageNumber - 1] = text;
          const combinedPdfText = pageTexts.map((value) => value.trim()).filter(Boolean).join('\n\n').trim();
          if (!combinedPdfText) throw new Error('لم يُستخرج نص صالح من صفحات PDF.');
          const usage = await consumeOperation(req, 'ocr');
          return res.json({ text: combinedPdfText, remainingCredits: usage.remainingCredits, trialRemaining: usage.trialRemaining });
        }
      } catch (pdfPageError: any) {
        if (pageImageOcrStarted) throw pdfPageError;
        console.warn('PDF page rendering could not complete; falling back to the original PDF OCR path:', pdfPageError?.message || pdfPageError);
      } finally {
        try { await pdfDocument?.destroy?.(); } catch {}
      }
    }

    let extractedText = '';
    try {
      extractedText = await executeWithDedicatedOCRKeyRotation(async (ai, _key, model) => {
        const response = await ai.models.generateContent({
          skipAdaptiveAnswerLength: true,
          model,
          contents: [
            {
              role: 'user',
              parts: [
                { text: ocrPrompt },
                { inlineData: { mimeType: safeGeminiMime, data: compactBase64 } },
              ],
            },
          ],
          config: { temperature: 0.2, maxOutputTokens: 32768 },
        } as any);
        const text = response.text?.trim() || '';
        if (!text) {
          throw Object.assign(new Error(`لم يُرجع النموذج ${model} نصاً مستخرجاً صالحاً.`), {
            status: 503,
            statusCode: 503,
          });
        }
        return text;
      }, GEMINI_MODELS, 280000);
    } catch (geminiError: any) {
      // executeWithDedicatedOCRKeyRotation already performs two complete
      // Gemini-key/model -> Groq rounds. Do not trigger an extra third Groq call here.
      throw geminiError;
    }

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
