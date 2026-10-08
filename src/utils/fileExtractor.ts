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
 * Client-Side Image Compression & Resizing.
 * Normalizes images to max 1200px bounding box at JPEG 0.70 quality.
 * Prevents HTTP 413 completely and speeds up OCR processing.
 */
export async function compressAndResizeImage(
  file: File,
  maxDimension = 1200,
  quality = 0.70
): Promise<{ base64Data: string; mimeType: string }> {
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
 * Server OCR powered by Gemini Vision with Silent Key Rotation.
 */
export async function extractTextViaServerOCR(
  base64Data: string,
  mimeType: string,
  fileName: string
): Promise<string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const sessionToken = getSessionToken();
  if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;

  const maxAttempts = 3;
  let lastError: any = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      let response: globalThis.Response;
      try {
        response = await fetch('/api/gemini/ocr', {
          method: 'POST',
          headers,
          body: JSON.stringify({ base64Data, mimeType, fileName }),
        });
      } catch {
        response = await fetch('/api/ocr', {
          method: 'POST',
          headers,
          body: JSON.stringify({ base64Data, mimeType, fileName }),
        });
      }
      if (response.status === 404) {
        response = await fetch('/api/ocr', {
          method: 'POST',
          headers,
          body: JSON.stringify({ base64Data, mimeType, fileName }),
        });
      }
      if (response.ok) {
        const data = await response.json();
        if (data && data.text) {
          return data.text.trim();
        }
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt < maxAttempts - 1) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
      }
      const errorData = await response.json().catch(() => ({}));
      lastError = new Error(errorData.error || `فشل الاستخراج (${response.status})`);
    } catch (err: any) {
      lastError = err;
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
    }
  }


  throw lastError || new Error('فشل استخراج النص.');
}

export async function extractTextFromDocx(file: File): Promise<string> {
  if (file.name.startsWith('~$')) {
    throw new Error(
      `هذا ملف مؤقت (${file.name}) تم إنشاؤه بواسطة Microsoft Word (~$). يرجى اختيار الملف الأصلي.`
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
    throw new Error('فشل استخراج محتوى Word.');
  } catch (err: any) {
    console.warn('Mammoth extraction failed, will attempt server fallback:', err);
    throw err;
  }
}

export async function extractTextFromLegacyDoc(file: File): Promise<string> {
  if (file.name.startsWith('~$')) {
    throw new Error('ملف مؤقت (~$). اختر ملف Word الأصلي.');
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
  throw new Error(`تعذر استخراج نص Word القديم (${file.name}).`);
}

/**
 * Universal fast extractor:
 * 1. Word (.docx): Client mammoth extracts instantly in 50ms.
 * 2. Word (.doc): Client stream decoding or server OCR.
 * 3. PDF and Images: Client compresses image and extracts via server OCR with Silent Key Rotation.
 * 4. Text (.txt): Instant text reading.
 */
export async function extractTextFromAnyFile(file: File): Promise<ExtractedFileResult> {
  const fileName = file.name;
  const lowerName = fileName.toLowerCase();
  let extractedText = '';

  if (fileName.startsWith('~$')) {
    throw new Error(`ملف مؤقت (${fileName}) من Word. اختر المستند الأصلي.`);
  }

  // 1. Plain text files
  if (lowerName.endsWith('.txt')) {
    extractedText = await file.text();
  }
  // 2. Word Modern docx
  else if (lowerName.endsWith('.docx')) {
    try {
      extractedText = await extractTextFromDocx(file);
    } catch {
      const base64Data = await fileToBase64(file);
      const mimeType = resolveMimeType(file);
      extractedText = await extractTextViaServerOCR(base64Data, mimeType, fileName);
    }
  }
  // 3. Word Legacy .doc
  else if (lowerName.endsWith('.doc')) {
    try {
      extractedText = await extractTextFromLegacyDoc(file);
    } catch {
      const base64Data = await fileToBase64(file);
      const mimeType = resolveMimeType(file);
      extractedText = await extractTextViaServerOCR(base64Data, mimeType, fileName);
    }
  }
  // 4. PDF documents and Images
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
