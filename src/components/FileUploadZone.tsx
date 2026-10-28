import React, { useEffect, useRef, useState } from 'react';
import {
  UploadCloud,
  Loader2,
  X,
  Layers,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react';
import { checkServerOCRReadiness, extractTextFromAnyFile } from '../utils/fileExtractor.ts';
import { acknowledgeSavedOcrJob, getSavedOcrJobs, resumeSavedOcrTask } from '../services/aiService.ts';
import { getActiveLawyerUserId } from '../utils/legalVaultService.ts';


interface PendingUploadFileRecord {
  id: string;
  scope: string;
  userId: string;
  fileName: string;
  mimeType: string;
  size: number;
  lastModified: number;
  createdAt: string;
  blob: Blob;
}

const PENDING_UPLOAD_DB = 'amin-pending-upload-files';
const PENDING_UPLOAD_STORE = 'files';

function openPendingUploadDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const request = indexedDB.open(PENDING_UPLOAD_DB, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(PENDING_UPLOAD_STORE)) {
          request.result.createObjectStore(PENDING_UPLOAD_STORE, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function savePendingUploadFiles(files: File[], scope: string, userId: string): Promise<PendingUploadFileRecord[]> {
  const db = await openPendingUploadDb();
  if (!db) return [];
  const records = files.map((file) => ({
    id: `${scope}_${userId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    scope, userId, fileName: file.name, mimeType: file.type || 'application/octet-stream',
    size: file.size, lastModified: file.lastModified, createdAt: new Date(Date.now() + files.indexOf(file)).toISOString(),
    blob: file.slice(0, file.size, file.type || 'application/octet-stream'),
  }));
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(PENDING_UPLOAD_STORE, 'readwrite');
      const store = tx.objectStore(PENDING_UPLOAD_STORE);
      records.forEach((record) => store.put(record));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('تعذر حفظ الملفات مؤقتًا.'));
      tx.onabort = () => reject(tx.error || new Error('تم إلغاء حفظ الملفات مؤقتًا.'));
    });
    return records;
  } catch (error) {
    console.warn('Pending upload files could not be persisted:', error);
    return [];
  } finally { db.close(); }
}

async function getPendingUploadFiles(scope: string, userId: string): Promise<PendingUploadFileRecord[]> {
  const db = await openPendingUploadDb();
  if (!db) return [];
  try {
    const all = await new Promise<PendingUploadFileRecord[]>((resolve, reject) => {
      const request = db.transaction(PENDING_UPLOAD_STORE, 'readonly').objectStore(PENDING_UPLOAD_STORE).getAll();
      request.onsuccess = () => resolve((request.result || []) as PendingUploadFileRecord[]);
      request.onerror = () => reject(request.error || new Error('تعذر استعادة الملفات المؤقتة.'));
    });
    return all.filter((row) => row.scope === scope && row.userId === userId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch { return []; }
  finally { db.close(); }
}

async function deletePendingUploadFile(id: string): Promise<void> {
  const db = await openPendingUploadDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(PENDING_UPLOAD_STORE, 'readwrite');
      tx.objectStore(PENDING_UPLOAD_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } finally { db.close(); }
}

function restoreFileFromRecord(record: PendingUploadFileRecord): File {
  return new File([record.blob], record.fileName, { type: record.mimeType, lastModified: record.lastModified });
}

interface FileUploadZoneProps {
  onTextExtracted: (text: string, fileName: string, fileType?: string, sourceFile?: File) => void | Promise<void>;
  title?: string;
  description?: string;
  maxFiles?: number;
  onProcessingChange?: (isProcessing: boolean) => void;
  recoveryScope?: 'drafting' | 'deconstruct' | 'qualify' | 'vault' | string;
}

export const FileUploadZone: React.FC<FileUploadZoneProps> = ({
  onTextExtracted,
  title = 'رفع المستندات (وورد / بي دي إف / صور)',
  description = 'استخراج فوري للنصوص بالذكاء الاصطناعي مع الحفاظ على البيانات.',
  maxFiles = 10,
  onProcessingChange,
  recoveryScope = 'general',
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const processFilesBatchRef = useRef<((filesList: FileList | File[], existingRecords?: PendingUploadFileRecord[]) => Promise<void>) | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{
    current: number;
    total: number;
    currentFileName: string;
  } | null>(null);
  const [successInfo, setSuccessInfo] = useState<{
    processedCount: number;
    totalChars: number;
    fileNames: string[];
  } | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Restore both already-started OCR jobs and files that were still waiting in a batch
  // when the page refreshed. This prevents a three-file upload from shrinking to only
  // the first file whose server job had started before refresh.
  useEffect(() => {
    let active = true;
    const userId = getActiveLawyerUserId();
    void (async () => {
      const [savedJobs, pendingFiles] = await Promise.all([
        Promise.resolve(getSavedOcrJobs(recoveryScope, userId)),
        getPendingUploadFiles(recoveryScope, userId),
      ]);
      if (!active || (!savedJobs.length && !pendingFiles.length)) return;
      setIsProcessing(true);
      onProcessingChange?.(true);
      setErrorMsg(null);
      setWarnings([]);
      const reservedFileIds = new Set<string>();
      let recoveredChars = 0;
      const recoveredNames: string[] = [];

      for (let i = 0; i < savedJobs.length; i++) {
        const job = savedJobs[i];
        if (!active) return;
        // OCR may compress PNG/WebP to JPEG before sending it, so the job MIME
        // type can differ from the original upload. Match by filename and order.
        const originalRecord = pendingFiles.find((record) =>
          !reservedFileIds.has(record.id) && record.fileName === job.fileName
        );
        if (originalRecord) reservedFileIds.add(originalRecord.id);
        setBatchProgress({ current: i + 1, total: savedJobs.length, currentFileName: `استعادة: ${job.fileName}` });
        try {
          const text = await resumeSavedOcrTask(job.jobId, recoveryScope, userId);
          if (!active) return;
          if (!text.trim()) throw new Error('اكتملت المهمة دون نص مستخرج صالح.');
          const sourceFile = originalRecord ? restoreFileFromRecord(originalRecord) : undefined;
          await Promise.resolve(onTextExtracted(text, job.fileName, job.mimeType || undefined, sourceFile));
          recoveredChars += text.length;
          recoveredNames.push(job.fileName);
          await new Promise((resolve) => setTimeout(resolve, 50));
          if (active) {
            acknowledgeSavedOcrJob(recoveryScope, userId, job.jobId);
            if (originalRecord) await deletePendingUploadFile(originalRecord.id);
          }
        } catch (error: any) {
          if (!active) return;
          if (!error?.savedJobPending && !error?.preservePendingUpload) {
            acknowledgeSavedOcrJob(recoveryScope, userId, error?.jobId || job.jobId);
            if (originalRecord) await deletePendingUploadFile(originalRecord.id);
          }
          setWarnings((previous) => [...previous, (error?.savedJobPending || error?.preservePendingUpload)
            ? `تعذر إتمام حفظ ${job.fileName}؛ احتُفظ بالملف والمهمة لإعادة المحاولة لاحقًا.`
            : `تعذر استعادة ${job.fileName}: ${error?.message || 'حدث خطأ أثناء استرجاع المهمة.'}`]);
        }
      }

      if (!active) return;
      if (recoveredNames.length) setSuccessInfo({ processedCount: recoveredNames.length, totalChars: recoveredChars, fileNames: recoveredNames });
      // Files with no server job yet are the unstarted tail of the original batch.
      // Requeue them in original order instead of silently dropping them after refresh.
      const latestPending = await getPendingUploadFiles(recoveryScope, userId);
      const queuedRecords = latestPending.filter((record) => !reservedFileIds.has(record.id));
      if (active && queuedRecords.length && processFilesBatchRef.current) {
        await processFilesBatchRef.current(queuedRecords.map(restoreFileFromRecord), queuedRecords);
      } else if (active) {
        setIsProcessing(false);
        onProcessingChange?.(false);
        setBatchProgress(null);
      }
    })();
    return () => { active = false; };
  }, [recoveryScope]);

  const processFilesBatch = async (filesList: FileList | File[], existingRecords?: PendingUploadFileRecord[]) => {
    const rawFiles = Array.from(filesList);
    if (rawFiles.length === 0) return;

    let filesToProcess = rawFiles;
    let extraWarning = '';
    if (rawFiles.length > maxFiles) {
      filesToProcess = rawFiles.slice(0, maxFiles);
      extraWarning = `تم تحديد أول ${maxFiles} ملفات فقط لتجنب ضغط الذاكرة.`;
    }

    setIsProcessing(true);
    onProcessingChange?.(true);
    setErrorMsg(null);
    setSuccessInfo(null);
    setWarnings(extraWarning ? [extraWarning] : []);

    // Images and PDFs always require the dedicated server OCR route. Check its own keys/models
    // before starting the batch; local TXT/DOCX extraction remains available without OCR keys.
    const hasServerOCRFiles = filesToProcess.some((file) => {
      const name = file.name.toLowerCase();
      return name.endsWith('.pdf') || /\.(jpe?g|png|webp|bmp)$/i.test(name) || file.type.startsWith('image/');
    });
    if (hasServerOCRFiles) {
      try {
        await checkServerOCRReadiness();
        if (!mountedRef.current) return;
      } catch (error: any) {
        if (!mountedRef.current) return;
        setIsProcessing(false);
        onProcessingChange?.(false);
        setBatchProgress(null);
        setErrorMsg(error?.message || 'مجموعة مفاتيح الصور والمستندات (OCR) غير جاهزة.');
        if (fileInputRef.current) fileInputRef.current.value = '';
        return;
      }
    }

    const activeUserId = getActiveLawyerUserId();
    const queueRecords = existingRecords && existingRecords.length === filesToProcess.length
      ? existingRecords
      : await savePendingUploadFiles(filesToProcess, recoveryScope, activeUserId);
    const pendingByIndex = queueRecords.length === filesToProcess.length ? queueRecords : [];
    const pendingAfterRefresh = new Set<number>();
    if (pendingByIndex.length !== filesToProcess.length) {
      setWarnings((previous) => [...previous, 'تعذر حفظ نسخة محلية مؤقتة من كل الملفات؛ ستستمر المعالجة، لكن قد لا يمكن استعادة الملفات التي لم تبدأ مهمتها بعد إذا أُغلقت الصفحة.']);
    }

    let totalChars = 0;
    const processedNames: string[] = [];
    const failedNames: string[] = [];
    // Keep each successful extraction at its original upload position.
    // Results are delivered to the parent only after retries finish, in upload order.
    type ExtractionResult = Awaited<ReturnType<typeof extractTextFromAnyFile>>;
    const extractedResults: Array<{ file: File; result: ExtractionResult } | undefined> =
      new Array(filesToProcess.length);
    const failedImages: Array<{ file: File; index: number }> = [];
    let hasStartedServerOCR = false;

    const isImageFile = (file: File) =>
      file.type.startsWith('image/') || /\.(jpe?g|png|webp|bmp)$/i.test(file.name.toLowerCase());

    const getCleanFailureReason = (file: File, err: any) => {
      const rawMsg = err?.message || '';
      if (file.name.startsWith('~$')) return 'ملف مؤقت وورد';
      if (rawMsg.includes('413')) return 'حجم الملف كبير';
      if (rawMsg.includes('مفتاح') || rawMsg.includes('API Key') || rawMsg.includes('api key')) {
        return 'يرجى تهيئة مفتاح Gemini';
      }
      return rawMsg || 'خطأ غير محدد أثناء استخراج النص';
    };

    for (let i = 0; i < filesToProcess.length; i++) {
      const file = filesToProcess[i];
      setBatchProgress({
        current: i + 1,
        total: filesToProcess.length,
        currentFileName: file.name,
      });

      const lowerFileName = file.name.toLowerCase();
      const isDirectOCRFile = lowerFileName.endsWith('.pdf') || /\.(jpe?g|png|webp|bmp)$/i.test(lowerFileName) || file.type.startsWith('image/');
      if (isDirectOCRFile && hasStartedServerOCR) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        if (!mountedRef.current) return;
      }
      try {
        const result = await extractTextFromAnyFile(file, recoveryScope);
        if (!mountedRef.current) return;
        if (isDirectOCRFile) hasStartedServerOCR = true;
        if (result && result.text) {
          totalChars += result.characterCount;
          extractedResults[i] = { file, result };
        }
      } catch (err: any) {
        if (!mountedRef.current) return;
        if (err?.jobId && !err?.savedJobPending) acknowledgeSavedOcrJob(recoveryScope, getActiveLawyerUserId(), err.jobId);
        if (isDirectOCRFile) hasStartedServerOCR = true;
        console.warn(`Extraction error for ${file.name}:`, err);
        const cleanReason = getCleanFailureReason(file, err);
        if (err?.savedJobPending) pendingAfterRefresh.add(i);
        if (isImageFile(file) && !err?.savedJobPending) {
          // Retry only definitive OCR failures; a saved pending job must never be charged twice.
          failedImages.push({ file, index: i });
        } else {
          failedNames.push(`${file.name}: ${err?.savedJobPending ? 'المهمة محفوظة للمتابعة في الخلفية، ويمكن استعادة نتيجتها لاحقًا' : cleanReason}`);
        }
      }
    }

    // Retry only failed images, once, after every file in the original batch has been attempted.
    // Successful files are never processed again, and non-image files keep their existing behavior.
    for (let i = 0; i < failedImages.length; i++) {
      const { file, index: originalIndex } = failedImages[i];
      setBatchProgress({
        current: i + 1,
        total: failedImages.length,
        currentFileName: `إعادة المحاولة: ${file.name}`,
      });

      // Keep OCR requests spaced out during the retry pass as well.
      await new Promise((resolve) => setTimeout(resolve, 2500));
      if (!mountedRef.current) return;
      try {
        const result = await extractTextFromAnyFile(file, recoveryScope);
        if (!mountedRef.current) return;
        if (result && result.text) {
          totalChars += result.characterCount;
          extractedResults[originalIndex] = { file, result };
        } else {
          throw new Error('لم تُرجع خدمة استخراج النص نصًا صالحًا.');
        }
      } catch (retryErr: any) {
        if (!mountedRef.current) return;
        if (retryErr?.jobId && !retryErr?.savedJobPending) acknowledgeSavedOcrJob(recoveryScope, getActiveLawyerUserId(), retryErr.jobId);
        console.warn(`Image extraction retry failed for ${file.name}:`, retryErr);
        const finalReason = getCleanFailureReason(file, retryErr);
        if (retryErr?.savedJobPending) pendingAfterRefresh.add(originalIndex);
        failedNames.push(`${file.name}: ${retryErr?.savedJobPending ? 'المهمة محفوظة لاستكمالها بعد الرجوع' : `تعذر استخراج النص حتى بعد إعادة المحاولة (${finalReason})`}`);
      }
    }

    // Publish all successful results in original upload order, even when a result
    // was recovered during the retry pass (e.g. image 3 stays in position 3).
    for (const entry of extractedResults) {
      if (!entry) continue;
      if (!mountedRef.current) return;
      const { file, result } = entry;
      const queueIndex = filesToProcess.indexOf(file);
      try {
        await Promise.resolve(onTextExtracted(result.text, result.fileName, result.fileType, file));
      } catch (callbackError: any) {
        pendingAfterRefresh.add(queueIndex);
        failedNames.push(`${file.name}: ${callbackError?.message || 'تعذر حفظ نتيجة الملف في الوجهة المطلوبة؛ احتُفظ به لإعادة المحاولة.'}`);
        continue;
      }
      processedNames.push(file.name);
      if (result.backgroundJobId) {
        acknowledgeSavedOcrJob(recoveryScope, activeUserId, result.backgroundJobId);
      }
      if (pendingByIndex[queueIndex]) await deletePendingUploadFile(pendingByIndex[queueIndex].id);
    }

    for (let i = 0; i < pendingByIndex.length; i++) {
      if (!pendingAfterRefresh.has(i) && !extractedResults[i]) await deletePendingUploadFile(pendingByIndex[i].id);
    }

    if (!mountedRef.current) return;
    setIsProcessing(false);
    onProcessingChange?.(false);
    setBatchProgress(null);

    if (fileInputRef.current) fileInputRef.current.value = '';

    if (processedNames.length > 0) {
      setSuccessInfo({
        processedCount: processedNames.length,
        totalChars,
        fileNames: processedNames,
      });
    }

    if (failedNames.length > 0) {
      setWarnings((prev) => [
        ...prev,
        `تعذر استخراج ${failedNames.length} ملفات: ${failedNames.join(' | ')}`,
      ]);
    } else if (processedNames.length === 0) {
      setErrorMsg('تعذر استخراج نصوص صالحة من الملفات المحددة.');
    }
  };

  processFilesBatchRef.current = processFilesBatch;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFilesBatch(e.target.files);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processFilesBatch(e.dataTransfer.files);
    }
  };

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`rounded-2xl border-2 transition-all p-3.5 my-2.5 ${
        isDragging
          ? 'border-amber-400 bg-amber-950/40 shadow-lg shadow-amber-900/30'
          : isProcessing
          ? 'border-amber-500/80 bg-slate-900/90'
          : 'border-dashed border-amber-600/40 bg-slate-900/80 hover:border-[#b45309] hover:bg-slate-900'
      }`}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".pdf,.docx,.doc,.txt,.png,.jpg,.jpeg,.webp"
        onChange={handleFileChange}
        className="hidden"
      />
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 text-right">
        <div className="flex items-center gap-3.5 w-full sm:w-auto">
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-amber-600/20 to-amber-700/30 border border-amber-500/40 flex items-center justify-center text-amber-400 flex-shrink-0 shadow-inner">
            {isProcessing ? (
              <Loader2 className="w-5 h-5 animate-spin text-amber-300" />
            ) : (
              <UploadCloud className="w-5 h-5" />
            )}
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h4 className="text-xs sm:text-sm font-bold text-slate-100">{title}</h4>
              <div className="flex items-center gap-1">
                <span className="text-[10px] bg-amber-500/20 text-amber-300 px-1.5 py-0.5 rounded border border-amber-500/40 font-bold flex items-center gap-1">
                  <Layers className="w-3 h-3" />
                  حتى {maxFiles} ملفات
                </span>
                <span className="text-[10px] bg-blue-950/80 text-blue-300 px-1.5 py-0.5 rounded border border-blue-500/30 font-mono font-bold">
                  وورد
                </span>
                <span className="text-[10px] bg-rose-950/80 text-rose-300 px-1.5 py-0.5 rounded border border-rose-500/30 font-mono font-bold">
                  ملف بي دي إف
                </span>
                <span className="text-[10px] bg-emerald-950/80 text-emerald-300 px-1.5 py-0.5 rounded border border-emerald-500/30 font-mono font-bold">
                  صور / استخراج النص آليًا
                </span>
              </div>
            </div>
            <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">{description}</p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isProcessing}
          className="w-full sm:w-auto px-4 py-2.5 bg-gradient-to-r from-[#b45309] to-amber-600 hover:from-amber-600 hover:to-amber-500 text-white rounded-xl text-xs font-bold transition-all shadow-md shadow-amber-950/50 cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2 flex-shrink-0 whitespace-nowrap"
        >
          {isProcessing ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin text-amber-200" />
              <span>جارٍ المعالجة...</span>
            </>
          ) : (
            <>
              <UploadCloud className="w-4 h-4" />
              <span>اختر مستندات</span>
            </>
          )}
        </button>
      </div>

      {batchProgress && (
        <div className="mt-3 p-3 bg-amber-950/50 border border-amber-500/50 rounded-xl space-y-2 animate-in fade-in">
          <div className="flex items-center justify-between text-xs text-amber-200">
            <span className="font-bold flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400" />
              <span>
                جارٍ استخراج النص من الملف ({batchProgress.current} من {batchProgress.total}):
              </span>
              <b className="text-white max-w-[220px] truncate inline-block align-bottom mr-1">
                {batchProgress.currentFileName}
              </b>
            </span>

          </div>
          <div className="w-full bg-slate-900 h-2 rounded-full overflow-hidden border border-slate-700">
            <div
              className="bg-gradient-to-r from-amber-500 to-emerald-500 h-full w-full animate-pulse"
              aria-label="جارٍ استخراج النص"
            ></div>
          </div>
          <p className="text-[10px] leading-relaxed text-slate-400">
            تتم معالجة الملفات بالتتابع. لا يُعتبر الاستخراج ناجحًا إلا بعد استلام النص، ثم يُدرج في حقل «وقائع الدعوى».
          </p>
        </div>
      )}

      {successInfo && (
        <div className="mt-3 p-2.5 bg-emerald-950/80 border border-emerald-600/50 rounded-xl text-emerald-200 text-xs flex items-center justify-between shadow-sm animate-in fade-in">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
            <span>
              تم استخراج نصوص <b>({successInfo.processedCount})</b> مستندات بنجاح وإدراجها فوراً.
            </span>
          </div>
          <button
            type="button"
            onClick={() => setSuccessInfo(null)}
            className="text-slate-400 hover:text-white p-0.5 rounded cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="mt-2 space-y-1">
          {warnings.map((warn, idx) => (
            <div
              key={idx}
              className="p-2 bg-amber-950/60 border border-amber-600/40 rounded-lg text-amber-200 text-[11px] flex items-center justify-between"
            >
              <div className="flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                <span>{warn}</span>
              </div>
              <button
                type="button"
                onClick={() => setWarnings(warnings.filter((_, i) => i !== idx))}
                className="text-slate-400 hover:text-white p-0.5 cursor-pointer"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {errorMsg && (
        <div className="mt-3 p-2.5 bg-rose-950/80 border border-rose-600/50 rounded-xl text-rose-200 text-xs flex items-center justify-between shadow-sm animate-in fade-in">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-rose-400 flex-shrink-0" />
            <span>{errorMsg}</span>
          </div>
          <button
            type="button"
            onClick={() => setErrorMsg(null)}
            className="text-slate-400 hover:text-white p-0.5 rounded cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
};
