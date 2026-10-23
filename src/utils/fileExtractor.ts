import mammoth from 'mammoth';
import { getSessionToken } from '../services/authService.ts';
import { runSavedOcrTask } from '../services/aiService.ts';
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

/** * ضغط الصور وتغيير حجمها من جانب العميل (Client-Side). * ضبط أبعاد الصور بحد أقصى 1200px بجودة JPEG 0.70. * يمنع خطأ HTTP 413 تماماً ويسرّع عملية التعرف الضوئي على الحروف (OCR). */
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

/** * يودع مهمة OCR في قائمة المعالجة المحفوظة؛ يظل السيرفر مسؤولاً عن النتيجة عند مغادرة المتصفح. */
async function extractTextViaServerOCROnce(
  base64Data: string,
  mimeType: string,
  fileName: string,
  recoveryScope = 'general',
): Promise<{ text: string; jobId: string }> {
  return runSavedOcrTask(base64Data, mimeType, fileName, recoveryScope, getActiveLawyerUserId());
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

/** * إعادة محاولة محدودة عند رفض المهمة مؤقتاً فقط؛ لا تُكرر مهمة محفوظة ما زالت قيد التنفيذ. */
export async function extractTextViaServerOCR(
  base64Data: string,
  mimeType: string,
  fileName: string,
  recoveryScope = 'general',
): Promise<{ text: string; jobId: string }> {
  try {
    return await extractTextViaServerOCROnce(base64Data, mimeType, fileName, recoveryScope);
  } catch (error: any) {
    if (error?.savedJobPending || error?.terminalJobError || error?.jobId) throw error;
    const message = String(error?.message || '');
    const isTransientProviderFailure =
      /\b(?:503|504)\b|DEADLINE_EXCEEDED|temporar(?:y|ily)|unavailable|high demand|مشغول.{0,20}مؤقت|انتهت المهلة المتاحة|تعذر الاتصال بنماذج|تعذر الاتصال بـ Gemini/i.test(message);
    if (!isTransientProviderFailure) throw error;

    await new Promise((resolve) => setTimeout(resolve, 1200));
    return await extractTextViaServerOCROnce(base64Data, mimeType, fileName, recoveryScope);
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

/** * أداة الاستخراج الشاملة والسريعة: * 1. وورد (.docx): تستخرج مصلحة Mammoth النص فوراً في العميل. * 2. وورد (.doc): فك تشفير البيانات من العميل أو عبر خادم OCR. * 3. بي دي إف والصور: يقوم العميل بضغط الصورة واستخراجها عبر خادم OCR المركزي. * 4. الملفات النصية (.txt): قراءة فورية للنص. */
export async function extractTextFromAnyFile(file: File, recoveryScope = 'general'): Promise<ExtractedFileResult> {
  const fileName = file.name;
  const lowerName = fileName.toLowerCase();
  let extractedText = '';
  let backgroundJobId: string | undefined;

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
      const ocrResult = await extractTextViaServerOCR(base64Data, mimeType, fileName, recoveryScope);
      extractedText = ocrResult.text;
      backgroundJobId = ocrResult.jobId;
    }
  }
  // 3. ملفات وورد القديمة .doc
  else if (lowerName.endsWith('.doc')) {
    try {
      extractedText = await extractTextFromLegacyDoc(file);
    } catch {
      const base64Data = await fileToBase64(file);
      const mimeType = resolveMimeType(file);
      const ocrResult = await extractTextViaServerOCR(base64Data, mimeType, fileName, recoveryScope);
      extractedText = ocrResult.text;
      backgroundJobId = ocrResult.jobId;
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
    const ocrResult = await extractTextViaServerOCR(base64Data, mimeType, fileName, recoveryScope);
    extractedText = ocrResult.text;
    backgroundJobId = ocrResult.jobId;
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
    ...(backgroundJobId ? { backgroundJobId } : {}),
  };
}
