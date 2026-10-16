import mammoth from 'mammoth';
import { getSessionToken } from '../services/authService.ts';

export interface ExtractedFileResult {
  fileName: string;
  fileType: string;
  text: string;
  previewSnippet: string;
  characterCount: number;
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

/** 
 * ضغط الصور وتغيير حجمها من جانب العميل (Client-Side). 
 * ضبط أبعاد الصور بحد أقصى 1200px بجودة JPEG 0.70. 
 * يمنع خطأ HTTP 413 تماماً ويسرّع عملية التعرف الضوئي على الحروف (OCR). 
 */
export async function compressAndResizeImage( file: File, maxDimension = 1200, quality = 0.70 ): Promise<{ base64Data: string; mimeType: string }> {
  if (typeof window !== 'undefined' && 'createImageBitmap' in window) {
    try {
      const bitmap = await createImageBitmap(file);
      let { width, height } = bitmap;
      if (width > maxDimension || height > maxDimension) {
        const ratio = Math.min(maxDimension / width, maxDimension / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(bitmap, 0, 0, width, height);
        bitmap.close();
        const dataUrl = canvas.toDataURL('image/jpeg', quality);
        const base64Data = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
        return { base64Data, mimeType: 'image/jpeg' };
      }
    } catch (bitmapErr) {
      console.warn('createImageBitmap fallback to HTMLImage:', bitmapErr);
    }
  }

  return new Promise((resolve) => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      fileToBase64(file)
        .then((b64) => resolve({ base64Data: b64, mimeType: resolveMimeType(file) }))
        .catch(() => resolve({ base64Data: '', mimeType: 'image/jpeg' }));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => {
      fileToBase64(file)
        .then((b64) => resolve({ base64Data: b64, mimeType: resolveMimeType(file) }))
        .catch(() => resolve({ base64Data: '', mimeType: 'image/jpeg' }));
    };
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => {
        fileToBase64(file)
          .then((b64) => resolve({ base64Data: b64, mimeType: resolveMimeType(file) }))
          .catch(() => resolve({ base64Data: '', mimeType: 'image/jpeg' }));
      };
      img.onload = () => {
        try {
          let { width, height } = img;
          if (width > maxDimension || height > maxDimension) {
            const ratio = Math.min(maxDimension / width, maxDimension / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            fileToBase64(file)
              .then((b64) => resolve({ base64Data: b64, mimeType: resolveMimeType(file) }))
              .catch(() => resolve({ base64Data: '', mimeType: 'image/jpeg' }));
            return;
          }
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(img, 0, 0, width, height);
          const dataUrl = canvas.toDataURL('image/jpeg', quality);
          const base64Data = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
          resolve({ base64Data, mimeType: 'image/jpeg' });
        } catch {
          fileToBase64(file)
            .then((b64) => resolve({ base64Data: b64, mimeType: resolveMimeType(file) }))
            .catch(() => resolve({ base64Data: '', mimeType: 'image/jpeg' }));
        }
      };
      img.src = e.target?.result as string;
    };
    reader.readAsDataURL(file);
  });
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

/** 
 * استخراج النصوص عبر خادم OCR الموجه من خلال خدمة التدوير الآلي لمفاتيح الذكاء الاصطناعي. 
 */
export async function extractTextViaServerOCR(base64Data: string, mimeType: string, fileName: string): Promise<string> {
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

/** 
 * أداة الاستخراج الشاملة والسريعة: 
 * 1. وورد (.docx): تستخرج مصلحة Mammoth النص فوراً في العميل. 
 * 2. وورد (.doc): فك تشفير البيانات من العميل أو عبر خادم OCR. 
 * 3. بي دي إف والصور: يقوم العميل بضغط الصورة واستخراجها عبر خادم OCR المركزي. 
 * 4. الملفات النصية (.txt): قراءة فورية للنص. 
 */
export async function extractTextFromAnyFile(file: File): Promise<ExtractedFileResult> {
  const fileName = file.name;
  const lowerName = fileName.toLowerCase();
  let extractedText = '';

  if (fileName.startsWith('~$')) {
    throw new Error(`ملف مؤقت (${fileName}) من وورد. اختر المستند الأصلي.`);
  }

  // 1. الملفات النصية العادية
  if (lowerName.endsWith('.txt')) {
    extractedText = await file.text();
  }
  // 2. ملفات وورد الحديثة docx
  else if (lowerName.endsWith('.docx')) {
    try {
      extractedText = await extractTextFromDocx(file);
    } catch {
      const base64Data = await fileToBase64(file);
      const mimeType = resolveMimeType(file);
      extractedText = await extractTextViaServerOCR(base64Data, mimeType, fileName);
    }
  }
  // 3. ملفات وورد القديمة .doc
  else if (lowerName.endsWith('.doc')) {
    try {
      extractedText = await extractTextFromLegacyDoc(file);
    } catch {
      const base64Data = await fileToBase64(file);
      const mimeType = resolveMimeType(file);
      extractedText = await extractTextViaServerOCR(base64Data, mimeType, fileName);
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
      try {
        const compressed = await compressAndResizeImage(file, 1200, 0.70);
        base64Data = compressed.base64Data;
        mimeType = compressed.mimeType;
      } catch {
        base64Data = await fileToBase64(file);
      }
    } else {
      base64Data = await fileToBase64(file);
    }
    extractedText = await extractTextViaServerOCR(base64Data, mimeType, fileName);
  } else {
    try {
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
  };
}
