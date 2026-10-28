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

interface FileUploadZoneProps {
  onTextExtracted: (text: string, fileName: string, fileType?: string, sourceFile?: File) => void;
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

  // Reattach completed or queued OCR work to the correct legal workflow after reopening it.
  useEffect(() => {
    let active = true;
    const userId = getActiveLawyerUserId();
    const savedJobs = getSavedOcrJobs(recoveryScope, userId);
    if (!savedJobs.length) return () => { active = false; };

    setIsProcessing(true);
    onProcessingChange?.(true);
    setErrorMsg(null);
    setWarnings([]);

    void (async () => {
      let recoveredChars = 0;
      const recoveredNames: string[] = [];
      for (let i = 0; i < savedJobs.length; i++) {
        const job = savedJobs[i];
        if (!active) return;
        setBatchProgress({ current: i + 1, total: savedJobs.length, currentFileName: `استعادة: ${job.fileName}` });
        try {
          const text = await resumeSavedOcrTask(job.jobId, recoveryScope, userId);
          if (!active || !text.trim()) continue;
          onTextExtracted(text, job.fileName, job.mimeType || undefined);
          recoveredChars += text.length;
          recoveredNames.push(job.fileName);
          // Acknowledge only after delivering the text to its original workflow callback.
          await new Promise((resolve) => setTimeout(resolve, 50));
          if (active) acknowledgeSavedOcrJob(recoveryScope, userId, job.jobId);
        } catch (error: any) {
          if (!active) return;
          if (!error?.savedJobPending) acknowledgeSavedOcrJob(recoveryScope, userId, error?.jobId || job.jobId);
          setWarnings((previous) => [...previous, error?.savedJobPending
            ? `المهمة الخاصة بالملف ${job.fileName} ما زالت محفوظة على الخادم؛ ارجع لاحقًا لاستعادة نتيجتها.`
            : `تعذر استعادة ${job.fileName}: ${error?.message || 'حدث خطأ أثناء استرجاع المهمة.'}`]);
        }
      }
      if (!active) return;
      if (recoveredNames.length) {
        setSuccessInfo({ processedCount: recoveredNames.length, totalChars: recoveredChars, fileNames: recoveredNames });
      }
      setIsProcessing(false);
      onProcessingChange?.(false);
      setBatchProgress(null);
    })();

    return () => { active = false; };
  }, [recoveryScope]);

  const processFilesBatch = async (filesList: FileList | File[]) => {
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
        failedNames.push(`${file.name}: تعذر استخراج النص حتى بعد إعادة المحاولة (${finalReason})`);
      }
    }

    // Publish all successful results in original upload order, even when a result
    // was recovered during the retry pass (e.g. image 3 stays in position 3).
    for (const entry of extractedResults) {
      if (!entry) continue;
      if (!mountedRef.current) return;
      const { file, result } = entry;
      processedNames.push(file.name);
      onTextExtracted(result.text, result.fileName, result.fileType, file);
      if (result.backgroundJobId) {
        acknowledgeSavedOcrJob(recoveryScope, getActiveLawyerUserId(), result.backgroundJobId);
      }
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
