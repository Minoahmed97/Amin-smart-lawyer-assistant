import mammoth from 'mammoth';
import { getSessionToken } from '../services/authService.ts';
import { runSavedOcrTask } from '../services/aiService.ts';
import type { SavedOcrTaskLifecycle } from '../services/aiService.ts';
import { getActiveLawyerUserId } from './legalVaultService.ts';

export interface ExtractedFileResult {
  fileName: string;
  fileType: string;
  text: string;
  previewSnippet: string;
  characterCount: number;
  backgroundJobId?: string;
}

export function fileToBase64(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      resolve(base64);
    };
    reader.onerror = (error) => reject(error);
    reader.readAsDataURL(file);
  });
}

/** * تجهيز الصور قبل OCR: تحويل إلى رمادي، تصغير الأبعاد، وضغط JPEG. * يحاول إبقاء ملف الصورة الناتج دون 1MB مع الحفاظ على وضوح النص قدر الإمكان. */
export async function compressAndResizeImage( file: File, maxDimension = 1800, quality = 0.82, ): Promise<{ base64Data: string; mimeType: string }> {
  const MAX_IMAGE_BYTES = 1024 * 1024;
  const encodeCanvas = (canvas: HTMLCanvasElement, q: number) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', q));

  const loadImage = async (): Promise<{ source: CanvasImageSource; width: number; height: number; close?: () => void }> => {
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    }
    const sourceUrl = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('تعذر فتح الصورة للضغط.'));
        image.src = sourceUrl;
      });
      return { source: img, width: img.naturalWidth, height: img.naturalHeight };
    } finally {
      URL.revokeObjectURL(sourceUrl);
    }
  };

  if (typeof document === 'undefined') {
    const base64Data = await fileToBase64(file);
    return { base64Data, mimeType: resolveMimeType(file) };
  }

  try {
    const image = await loadImage();
    let maxSide = maxDimension;
    let resultBlob: Blob | null = null;
    try {
      // Reduce dimensions progressively if compression alone cannot reach the target.
      for (let dimensionPass = 0; dimensionPass < 6; dimensionPass++) {
        const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
        const width = Math.max(1, Math.round(image.width * scale));
        const height = Math.max(1, Math.round(image.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('تعذر تجهيز الصورة للضغط.');
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, width, height);
        ctx.filter = 'grayscale(100%)';
        ctx.drawImage(image.source, 0, 0, width, height);
        ctx.filter = 'none';

        for (const q of [quality, 0.78, 0.74, 0.70, 0.66, 0.62, 0.58]) {
          const candidate = await encodeCanvas(canvas, q);
          if (candidate && (!resultBlob || candidate.size < resultBlob.size)) resultBlob = candidate;
          if (candidate && candidate.size <= MAX_IMAGE_BYTES) {
            resultBlob = candidate;
            break;
          }
        }
        if (resultBlob && resultBlob.size <= MAX_IMAGE_BYTES) break;
        maxSide = Math.max(900, Math.floor(maxSide * 0.85));
      }
    } finally {
      image.close?.();
    }

    if (!resultBlob || resultBlob.size > MAX_IMAGE_BYTES) {
      throw new Error('تعذر ضغط الصورة إلى أقل من 1MB مع الحفاظ على وضوحها.');
    }
    const base64Data = await fileToBase64(resultBlob);
    return { base64Data, mimeType: 'image/jpeg' };
  } catch (error) {
    // Do not silently send the original oversized image: report a clear error instead.
    console.warn('Image compression failed:', error);
    throw new Error('تعذر تجهيز الصورة وإيصال حجمها إلى أقل من 1MB. جرّب صورة أوضح أو أصغر.');
  }
}

export function resolveMimeType(file: File): string {
  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith('.pdf')) return 'application/pdf';
  if (lowerName.endsWith('.png')) return 'image/png';
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return 'image/jpeg';
  if (lowerName.endsWith('.webp')) return 'image/webp';
  if (lowerName.endsWith('.bmp')) return 'image/bmp';
  if (lowerName.endsWith('.docx')) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  if (lowerName.endsWith('.doc')) return 'application/msword';
  return file.type || 'image/jpeg';
}

/** * استخراج النصوص عبر خادم OCR الموجه من خلال خدمة التدوير الآلي لمفاتيح الذكاء الاصطناعي. */
async function extractTextViaServerOCROnce(base64Data: string, mimeType: string, fileName: string): Promise<string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const sessionToken = getSessionToken();
  if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;

  let response: Response;
  try {
    // يستغرق OCR وقتاً أطول من طلبات JSON العادية.
    // ترسل النقطة النهائية أحداث الحفاظ على الاتصال أثناء عمل Gemini لتعذير انقطاع الاتصال قبل استلام النص.
    response = await fetch('/api/ocr', {
      method: 'POST',
      headers,
      body: JSON.stringify({ base64Data, mimeType, fileName, stream: true }),
    });
  } catch (error: any) {
    if (error instanceof TypeError || /failed to fetch|network error/i.test(String(error?.message || ''))) {
      throw new Error('انقطع الاتصال بخادم استخراج النصوص قبل استلام النتيجة. تأكد من اتصال الإنترنت ومن نشر مسار البرمجة على الخادم، ثم أعد المحاولة.');
    }
    throw error;
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData?.error || `فشل الاستخراج (${response.status})`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream')) {
    if (!response.body) throw new Error('أُغلق اتصال استخراج النصوص قبل استلام النتيجة.');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalResult: any = null;
    let serverError = '';

    const processFrame = (frame: string) => {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (!data) return;
      try {
        const event = JSON.parse(data);
        if (event?.type === 'done') finalResult = event;
        else if (event?.type === 'error') serverError = String(event.error || 'فشل استخراج النص من المستند.');
      } catch {
        // يتجاهل إطارات الحفاظ على الاتصال غير المكتملة أو غير المتعلقة؛
        // حيث يمرر محلل المخزن الإطارات الكاملة لهذه الدالة.
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });

        let separatorMatch: RegExpMatchArray | null;
        while ((separatorMatch = buffer.match(/\r?\n\r?\n/)) !== null) {
          const separatorIndex = separatorMatch.index ?? -1;
          if (separatorIndex < 0) break;
          processFrame(buffer.slice(0, separatorIndex));
          buffer = buffer.slice(separatorIndex + separatorMatch[0].length);
        }

        if (done) {
          if (buffer.trim()) processFrame(buffer);
          break;
        }
      }
    } catch (error: any) {
      if (error instanceof TypeError || /failed to fetch|network error/i.test(String(error?.message || ''))) {
        throw new Error('انقطع الاتصال أثناء استخراج النص. لم تصل النتيجة كاملة؛ تحقق من الاتصال ثم أعد المحاولة.');
      }
      throw error;
    } finally {
      reader.releaseLock();
    }

    if (serverError) throw new Error(serverError);
    if (typeof finalResult?.text === 'string' && finalResult.text.trim()) return finalResult.text.trim();
    throw new Error('انتهى اتصال استخراج النص دون إرجاع النص المستخرج. أعد المحاولة، وإذا تكرر الخطأ فراجع سجل واجهة البرمجة على الخادم.');
  }

  // قد ينتهي استخراج ملفات وورد محلياً في الخادم ويرجع JSON عادي.
  const data = await response.json().catch(() => ({}));
  if (data && typeof data.text === 'string' && data.text.trim()) return data.text.trim();
  throw new Error(data?.error || 'خدمة استخراج النص لم ترجع نصاً صالحاً.');
}


/** Check the server-managed OCR key/model pool before a batch of images/PDFs starts. */
export async function checkServerOCRReadiness(): Promise<void> {
  const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
  const sessionToken = getSessionToken();
  if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
  let response: Response;
  try {
    response = await fetch('/api/ocr', { method: 'GET', headers, cache: 'no-store' });
  } catch {
    throw new Error('تعذر فحص جاهزية مفاتيح الصور والمستندات بسبب انقطاع الاتصال بالخادم.');
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result?.ready !== true) {
    throw new Error(result?.message || result?.error || 'مجموعة مفاتيح الصور والمستندات (OCR) غير جاهزة. راجعها من لوحة إدارة المنصة.');
  }
}

/** * إعادة محاولة محدودة لاستخراج OCR عند تأكيد أن الخادم أعاد خطأ مؤقتاً من Gemini. * لا نعيد المحاولة عند انقطاع اتصال غامض، لتجنب تكرار عملية قد تكون نجحت واحتسبت بالفعل. */
export async function extractTextViaServerOCR(base64Data: string, mimeType: string, fileName: string): Promise<string> {
  try {
    return await extractTextViaServerOCROnce(base64Data, mimeType, fileName);
  } catch (error: any) {
    const message = String(error?.message || '');
    const isTransientProviderFailure =
      /\b(?:503|504)\b|DEADLINE_EXCEEDED|temporar(?:y|ily)|unavailable|high demand|مشغول.{0,20}مؤقت|انتهت المهلة المتاحة|تعذر الاتصال بنماذج|تعذر الاتصال بـ Gemini/i.test(message);
    const isConnectionInterruption =
      /انقطع الاتصال|أُغلق اتصال استخراج النصوص|انتهى اتصال استخراج النص|failed to fetch|network error|load failed/i.test(message);

    if (!isTransientProviderFailure && !isConnectionInterruption) throw error;

    // محاولة واحدة بعد انتظار قصير عند تعطل مؤقت من المزود أو انقطاع الاتصال.
    // لا نغيّر ضغط الصور أو طريقة استخراجها أو بقية وظائف التطبيق.
    await new Promise((resolve) => setTimeout(resolve, isConnectionInterruption ? 2000 : 1200));
    return await extractTextViaServerOCROnce(base64Data, mimeType, fileName);
  }
}

export async function extractTextFromDocx(file: File): Promise<string> {
  if (file.name.startsWith('~$')) {
    throw new Error(
      `هذا ملف مؤقت (${file.name}) تم إنشاؤه بواسطة مايكروسوفت وورد (~$). يرجى اختيار الملف الأصلي.`
    );
  }
  if (file.size === 0) {
    throw new Error('الملف فارغ.');
  }
  const arrayBuffer = await file.arrayBuffer();
  try {
    const result = await mammoth.extractRawText({ arrayBuffer });
    if (result.value && result.value.trim().length > 0) {
      return result.value.trim();
    }
    throw new Error('فشل استخراج محتوى وورد.');
  } catch (err: any) {
    console.warn('Mammoth extraction failed, will attempt server fallback:', err);
    throw err;
  }
}

export async function extractTextFromLegacyDoc(file: File): Promise<string> {
  if (file.name.startsWith('~$')) {
    throw new Error('ملف مؤقت (~$). اختر ملف وورد الأصلي.');
  }
  try {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const rawText = decoder.decode(bytes);
    const chunks = rawText.match(/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\w\s.,;:!?()-]{4,}/g);
    if (chunks && chunks.length > 0) {
      const extracted = chunks.join('\n').replace(/\s{2,}/g, ' ').trim();
      if (extracted.length > 50) {
        return extracted;
      }
    }
  } catch (e) {
    console.warn('Legacy .doc parsing attempt failed:', e);
  }
  throw new Error(`تعذر استخراج نص وورد القديم (${file.name}).`);
}

/** * أداة الاستخراج الشاملة والسريعة مع دعم حفظ هوية المهمة ومراحلها لاستعادتها بعد تحديث الصفحة. */
export interface FileExtractionOptions {
  userId?: string;
  jobId?: string;
  onStage?: (stage: 'preparing' | 'processing') => void | Promise<void>;
  onJobStatus?: SavedOcrTaskLifecycle['onStatus'];
}

async function extractUsingSavedOcr(
  file: File,
  recoveryScope: string,
  options: FileExtractionOptions,
  suppliedBase64?: string,
  suppliedMimeType?: string,
): Promise<{ text: string; jobId: string }> {
  const base64Data = suppliedBase64 || await fileToBase64(file);
  const mimeType = suppliedMimeType || resolveMimeType(file);
  await options.onStage?.('processing');
  return runSavedOcrTask(
    base64Data,
    mimeType,
    file.name,
    recoveryScope,
    options.userId || getActiveLawyerUserId(),
    options.jobId,
    { onStatus: options.onJobStatus },
  );
}

export async function extractTextFromAnyFile(
  file: File,
  recoveryScope = 'general',
  options: FileExtractionOptions = {},
): Promise<ExtractedFileResult> {
  const fileName = file.name;
  const lowerName = fileName.toLowerCase();
  let extractedText = '';
  let backgroundJobId: string | undefined;

  if (fileName.startsWith('~$')) {
    throw new Error(`ملف مؤقت (${fileName}) من وورد. اختر المستند الأصلي.`);
  }

  await options.onStage?.('preparing');

  // 1. الملفات النصية العادية
  if (lowerName.endsWith('.txt')) {
    await options.onStage?.('processing');
    extractedText = await file.text();
  }
  // 2. ملفات وورد الحديثة docx
  else if (lowerName.endsWith('.docx')) {
    try {
      await options.onStage?.('processing');
      extractedText = await extractTextFromDocx(file);
    } catch (localError) {
      console.warn('Local DOCX extraction failed; continuing through the durable OCR job queue:', localError);
      const savedTask = await extractUsingSavedOcr(file, recoveryScope, options);
      extractedText = savedTask.text;
      backgroundJobId = savedTask.jobId;
    }
  }
  // 3. ملفات وورد القديمة .doc
  else if (lowerName.endsWith('.doc')) {
    try {
      await options.onStage?.('processing');
      extractedText = await extractTextFromLegacyDoc(file);
    } catch (localError) {
      console.warn('Local legacy DOC extraction failed; continuing through the durable OCR job queue:', localError);
      const savedTask = await extractUsingSavedOcr(file, recoveryScope, options);
      extractedText = savedTask.text;
      backgroundJobId = savedTask.jobId;
    }
  }
  // 4. مستندات بي دي إف والصور
  else if (
    lowerName.endsWith('.pdf') ||
    lowerName.endsWith('.jpg') ||
    lowerName.endsWith('.jpeg') ||
    lowerName.endsWith('.png') ||
    lowerName.endsWith('.webp') ||
    lowerName.endsWith('.bmp') ||
    file.type.startsWith('image/')
  ) {
    const isImage = file.type.startsWith('image/') || /\.(jpe?g|png|webp|bmp)$/i.test(lowerName);
    let base64Data = '';
    let mimeType = resolveMimeType(file);
    if (isImage) {
      const compressed = await compressAndResizeImage(file, 1800, 0.82);
      base64Data = compressed.base64Data;
      mimeType = compressed.mimeType;
    } else {
      base64Data = await fileToBase64(file);
    }

    // The original bytes are stored by FileUploadZone. This durable server job
    // reuses the same job ID after refresh instead of submitting another OCR task.
    const savedTask = await extractUsingSavedOcr(file, recoveryScope, options, base64Data, mimeType);
    extractedText = savedTask.text;
    backgroundJobId = savedTask.jobId;
  } else {
    try {
      await options.onStage?.('processing');
      extractedText = await file.text();
    } catch {
      throw new Error(`صيغة الملف (${fileName}) غير مدعومة.`);
    }
  }

  const cleanText = extractedText.trim();
  if (!cleanText) {
    throw new Error(`تعذر استخراج نص من "${fileName}".`);
  }

  return {
    fileName,
    fileType: file.type || lowerName.split('.').pop() || 'unknown',
    text: cleanText,
    previewSnippet: cleanText.slice(0, 200) + (cleanText.length > 200 ? '...' : ''),
    characterCount: cleanText.length,
    ...(backgroundJobId ? { backgroundJobId } : {}),
  };
}
