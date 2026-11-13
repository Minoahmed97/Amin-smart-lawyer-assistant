import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
UploadCloud,
Loader2,
X,
Layers,
CheckCircle2,
AlertTriangle,
FileText,
RefreshCw,
Clock3,
Image as ImageIcon,
} from 'lucide-react';
import { checkServerOCRReadiness, extractTextFromAnyFile } from '../utils/fileExtractor.ts';
import { acknowledgeSavedOcrJob, cancelSavedOcrTask, getSavedOcrJobs, resumeSavedOcrTask } from '../services/aiService.ts';
import { getActiveLawyerUserId } from '../utils/legalVaultService.ts';
import {
createFileBatchId,
createFileOcrJobId,
deleteFileBatchItem,
getFileBatchItems,
restoreFileFromBatchItem,
saveFileBatchItems,
updateFileBatchItem,
} from '../utils/fileBatchStorage.ts';
import type { StoredFileBatchItem } from '../utils/fileBatchStorage.ts';

interface FileUploadZoneProps {
onTextExtracted: (text: string, fileName: string, fileType?: string, sourceFile?: File) => void | Promise<void>;
title?: string;
description?: string;
maxFiles?: number;
onProcessingChange?: (isProcessing: boolean) => void;
recoveryScope?: 'drafting' | 'deconstruct' | 'qualify' | 'vault' | string;
userId?: string;
}

const ACTIVE_FILE_TASKS = new Map<string, Promise<void>>();
const ACTIVE_FILE_TASK_CONTROLLERS = new Map<string, AbortController>();
const CANCELLED_FILE_TASKS = new Set<string>();

const makeFileTaskKey = (userId: string, scope: string, fileId: string) => `${userId}::${scope}::${fileId}`;
const isFileTaskCancelled = (userId: string, scope: string, fileId: string) =>
  CANCELLED_FILE_TASKS.has(makeFileTaskKey(userId, scope, fileId));
const makeFileTaskAbortError = () => {
  const error = new Error('تم إلغاء معالجة الملف.');
  error.name = 'AbortError';
  return error;
};

const isImageFile = (item: Pick<StoredFileBatchItem, 'fileName' | 'mimeType'>) =>
item.mimeType.startsWith('image/') || /.(jpe?g|png|webp|bmp)$/i.test(item.fileName);

const isServerOcrFile = (item: Pick<StoredFileBatchItem, 'fileName' | 'mimeType'>) =>
/.(pdf|doc|docx|jpe?g|png|webp|bmp)$/i.test(item.fileName) || item.mimeType.startsWith('image/');

const isDirectOcrFile = (item: Pick<StoredFileBatchItem, 'fileName' | 'mimeType'>) =>
/.pdf$/i.test(item.fileName) || isImageFile(item);

const inferFileMimeType = (file: File): string => {
if (file.type) return file.type;
const name = file.name.toLowerCase();
if (name.endsWith('.pdf')) return 'application/pdf';
if (name.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
if (name.endsWith('.doc')) return 'application/msword';
if (name.endsWith('.png')) return 'image/png';
if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
if (name.endsWith('.webp')) return 'image/webp';
if (name.endsWith('.bmp')) return 'image/bmp';
if (name.endsWith('.txt')) return 'text/plain';
return 'application/octet-stream';
};

const statusLabel = (item: StoredFileBatchItem): string => {
if (item.status === 'waiting') return 'منتظر';
if (item.status === 'preparing') return 'تجهيز الملف';
if (item.status === 'processing') return item.stageLabel || 'قيد معالجة OCR';
if (item.status === 'completed') return 'مكتمل';
return 'فشل';
};

const statusProgress = (status: StoredFileBatchItem['status']): number => {
if (status === 'preparing') return 20;
if (status === 'processing') return 50;
if (status === 'completed') return 100;
return 0;
};

export const FileUploadZone: React.FC<FileUploadZoneProps> = ({
onTextExtracted,
title = 'رفع المستندات (وورد / بي دي إف / صور)',
description = 'استخراج فوري للنصوص بالذكاء الاصطناعي مع الحفاظ على البيانات.',
maxFiles = 10,
onProcessingChange,
recoveryScope = 'general',
userId,
}) => {
const fileInputRef = useRef<HTMLInputElement>(null);
const mountedRef = useRef(true);
const onTextExtractedRef = useRef(onTextExtracted);
const previewUrlsRef = useRef<Record<string, string>>({});
const [storedItems, setStoredItems] = useState<StoredFileBatchItem[]>([]);
const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
const [activeBatchId, setActiveBatchId] = useState('');
const [currentFileId, setCurrentFileId] = useState('');
const [isProcessing, setIsProcessing] = useState(false);
const [isRestoring, setIsRestoring] = useState(true);
const [isDragging, setIsDragging] = useState(false);
const [successInfo, setSuccessInfo] = useState<{ processedCount: number; totalChars: number } | null>(null);
const [warnings, setWarnings] = useState<string[]>([]);
const [errorMsg, setErrorMsg] = useState<string | null>(null);

const effectiveUserId = String(userId || getActiveLawyerUserId()).trim();
const contextKey = `${effectiveUserId}::${recoveryScope}`;
const activeContextRef = useRef(contextKey);
activeContextRef.current = contextKey;

useEffect(() => {
onTextExtractedRef.current = onTextExtracted;
}, [onTextExtracted]);

useEffect(() => {
mountedRef.current = true;
return () => {
mountedRef.current = false;
Object.values(previewUrlsRef.current).forEach((url) => URL.revokeObjectURL(url));
previewUrlsRef.current = {};
};
}, []);

useEffect(() => {
const wantedIds = new Set(storedItems.map((item) => item.id));
for (const item of storedItems) {
if (isImageFile(item) && !previewUrlsRef.current[item.id]) {
try {
previewUrlsRef.current[item.id] = URL.createObjectURL(item.blob);
} catch (error) {
console.warn('Could not create a preview for a stored upload:', error);
}
}
}
for (const [id, url] of Object.entries(previewUrlsRef.current)) {
if (!wantedIds.has(id)) {
URL.revokeObjectURL(url);
delete previewUrlsRef.current[id];
}
}
setPreviewUrls({ ...previewUrlsRef.current });
}, [storedItems]);

const updateRecord = async (
id: string,
changes: Partial<Omit<StoredFileBatchItem, 'id' | 'userId' | 'scope' | 'blob'>>,
): Promise<StoredFileBatchItem> => {
if (isFileTaskCancelled(effectiveUserId, recoveryScope, id)) throw makeFileTaskAbortError();
const updated = await updateFileBatchItem(id, effectiveUserId, recoveryScope, changes);
if (isFileTaskCancelled(effectiveUserId, recoveryScope, id)) throw makeFileTaskAbortError();
if (mountedRef.current && activeContextRef.current === contextKey) {
setStoredItems((previous) => previous.map((item) => item.id === id ? updated : item));
}
return updated;
};

const deliverCompletedText = async (item: StoredFileBatchItem, text: string, sourceFile: File, taskContextKey: string) => {
if (!mountedRef.current || activeContextRef.current !== taskContextKey || item.deliveredToWorkflow || isFileTaskCancelled(effectiveUserId, recoveryScope, item.id)) return;
try {
await onTextExtractedRef.current(text, item.fileName, item.mimeType || undefined, sourceFile);
if (recoveryScope === 'vault') {
  // The vault callback has now saved the extracted model and original file.
  // Persist delivery using the item's own account/scope even if the user has
  // navigated away while IndexedDB was finishing; this prevents a duplicate
  // model from being imported when the vault is opened again.
  const deliveredRecord = await updateFileBatchItem(item.id, effectiveUserId, recoveryScope, { deliveredToWorkflow: true });
  if (mountedRef.current && activeContextRef.current === taskContextKey) {
    setStoredItems((previous) => previous.map((record) => record.id === item.id ? deliveredRecord : record));
  }
  try {
    await deleteFileBatchItem(item.id, effectiveUserId, recoveryScope);
    if (mountedRef.current && activeContextRef.current === taskContextKey) {
      setStoredItems((previous) => previous.filter((record) => record.id !== item.id));
    }
  } catch (cleanupError) {
    // The delivered row is hidden by its flag and cleaned up on the next visit.
    console.warn('Could not remove completed vault upload record:', cleanupError);
  }
} else {
  await updateRecord(item.id, { deliveredToWorkflow: true });
}
} catch (error: any) {
// OCR is already complete and persisted; a workflow callback/storage issue
// must not downgrade this file to failed and cause another OCR charge.
if (error?.name === 'AbortError' || isFileTaskCancelled(effectiveUserId, recoveryScope, item.id)) return;
console.warn('Extracted file text could not be acknowledged by its workflow:', error);
if (mountedRef.current && activeContextRef.current === taskContextKey) {
setWarnings((previous) => [...previous, `اكتمل استخراج ${item.fileName}، لكن تعذر تثبيت تسليمه إلى حقول الواجهة. ستظل النتيجة محفوظة دون إعادة OCR.`]);
}
}
};

const processStoredItem = async (originalItem: StoredFileBatchItem): Promise<void> => {
const taskContextKey = `${effectiveUserId}::${recoveryScope}`;
const taskKey = makeFileTaskKey(effectiveUserId, recoveryScope, originalItem.id);
if (!mountedRef.current || activeContextRef.current !== taskContextKey || CANCELLED_FILE_TASKS.has(taskKey)) return;
const existingTask = ACTIVE_FILE_TASKS.get(taskKey);
if (existingTask) {
await existingTask;
return;
}

const taskController = new AbortController();
ACTIVE_FILE_TASK_CONTROLLERS.set(taskKey, taskController);
const isCancelled = () => taskController.signal.aborted || CANCELLED_FILE_TASKS.has(taskKey);

const task = (async () => {  
  let item = originalItem;  
  if (isCancelled()) return;
  const sourceFile = restoreFileFromBatchItem(item);  
  if (item.status === 'completed') {  
    if (item.extractedText && !item.deliveredToWorkflow && mountedRef.current) {  
      await deliverCompletedText(item, item.extractedText, sourceFile, taskContextKey);  
    }  
    return;  
  }  
  if (item.status === 'failed') return;  

  const shouldResumeExistingJob = item.status === 'processing' && Boolean(item.jobId);  
  const jobId = item.jobId || (isServerOcrFile(item) ? createFileOcrJobId() : undefined);  
  item = await updateRecord(item.id, {  
    status: shouldResumeExistingJob ? 'processing' : 'preparing',  
    stageLabel: shouldResumeExistingJob ? 'استعادة مهمة OCR المحفوظة' : 'تجهيز الملف الأصلي المحفوظ',  
    ...(jobId ? { jobId } : {}),  
    error: undefined,  
  });  
  if (isCancelled()) return;
  if (mountedRef.current && activeContextRef.current === taskContextKey) setCurrentFileId(item.id);  

  const onJobStatus = async (status: 'queued' | 'processing' | 'completed' | 'failed') => {
    if (isCancelled()) return;  
    const stageLabel = status === 'queued'  
      ? 'تم إدراج المهمة في طابور OCR'  
      : status === 'completed'  
        ? 'اكتمل OCR على الخادم'  
        : status === 'failed'  
          ? 'فشلت مهمة OCR على الخادم'  
          : 'قيد معالجة OCR على الخادم';  
    await updateRecord(item.id, {  
      status: status === 'failed' ? 'failed' : 'processing',  
      stageLabel,  
      serverJobCreated: true,  
    });  
  };  

  let extracted: Awaited<ReturnType<typeof extractTextFromAnyFile>> | null = null;  
  try {  
    if (shouldResumeExistingJob && jobId) {  
      try {  
        const text = await resumeSavedOcrTask(jobId, recoveryScope, effectiveUserId, { onStatus: onJobStatus, signal: taskController.signal });  
        extracted = {  
          fileName: item.fileName,  
          fileType: item.mimeType || item.fileName.split('.').pop() || 'unknown',  
          text,  
          previewSnippet: text.slice(0, 200),  
          characterCount: text.length,  
          backgroundJobId: jobId,  
        };  
      } catch (resumeError: any) {  
        const isMissingJob = Number(resumeError?.statusCode) === 404 || /لم يتم العثور على المهمة/.test(String(resumeError?.message || ''));  
        if (!isMissingJob) throw resumeError;  
        if (!mountedRef.current || activeContextRef.current !== taskContextKey) return;  
        // The browser may have refreshed after persisting the job ID but before  
        // the server accepted the POST. Re-send the same ID; the API is idempotent.  
        await checkServerOCRReadiness();  
        extracted = await extractTextFromAnyFile(sourceFile, recoveryScope, {  
          userId: effectiveUserId,  
          jobId,  
          signal: taskController.signal,
          onStage: async (stage) => {  
            await updateRecord(item.id, {  
              status: stage,  
              stageLabel: stage === 'preparing' ? 'تجهيز الملف لإرساله إلى OCR' : 'إرسال الملف ومتابعة OCR',  
            });  
          },  
          onJobStatus,  
        });  
      }  
    } else {  
      extracted = await extractTextFromAnyFile(sourceFile, recoveryScope, {  
        userId: effectiveUserId,  
        jobId,  
        signal: taskController.signal,
        onStage: async (stage) => {  
          await updateRecord(item.id, {  
            status: stage,  
            stageLabel: stage === 'preparing' ? 'تجهيز الملف للاستخراج' : 'استخراج النص / انتظار نتيجة OCR',  
          });  
        },  
        onJobStatus,  
      });  
    }  

    if (isCancelled()) return;
    if (!extracted?.text?.trim()) throw new Error('لم تُرجع خدمة استخراج النص نصًا صالحًا.');  
    const completed = await updateRecord(item.id, {  
      status: 'completed',  
      stageLabel: 'مكتمل',  
      extractedText: extracted.text,  
      jobId: extracted.backgroundJobId,  
      error: undefined,  
    });  
    if (extracted.backgroundJobId) acknowledgeSavedOcrJob(recoveryScope, effectiveUserId, extracted.backgroundJobId);  
    if (mountedRef.current && activeContextRef.current === taskContextKey) {  
      await deliverCompletedText(completed, extracted.text, sourceFile, taskContextKey);  
    }  
  } catch (error: any) {  
    if (isCancelled() || error?.name === 'AbortError') return;
    const pendingOnServer = Boolean(error?.savedJobPending);  
    const failureText = String(error?.message || 'حدث خطأ أثناء استخراج النص.');  
    await updateRecord(item.id, {  
      status: pendingOnServer ? 'processing' : 'failed',  
      stageLabel: pendingOnServer ? 'المهمة محفوظة على الخادم؛ تنتظر استعادة النتيجة' : 'فشل الاستخراج',  
      error: failureText,  
      ...(pendingOnServer && jobId ? { jobId } : {}),  
    }).catch((storageError) => console.warn('Could not persist file extraction status:', storageError));  
    if (mountedRef.current && activeContextRef.current === taskContextKey) {  
      setWarnings((previous) => [  
        ...previous,  
        pendingOnServer  
          ? `الملف ${item.fileName}: المهمة ما زالت محفوظة على الخادم، ويمكن متابعة نفس المهمة دون إنشاء طلب OCR جديد.`  
          : `الملف ${item.fileName}: ${failureText}`,  
      ]);  
    }  
  }  
})();  

ACTIVE_FILE_TASKS.set(taskKey, task);  
try {
  await task;
} catch (error: any) {
  if (error?.name !== 'AbortError') throw error;
} finally {
  if (ACTIVE_FILE_TASKS.get(taskKey) === task) ACTIVE_FILE_TASKS.delete(taskKey);
  if (ACTIVE_FILE_TASK_CONTROLLERS.get(taskKey) === taskController) ACTIVE_FILE_TASK_CONTROLLERS.delete(taskKey);
}

};

const processRecords = async (records: StoredFileBatchItem[], isCurrent: () => boolean = () => mountedRef.current && activeContextRef.current === contextKey) => {
const eligible = records.filter((item) =>
!isFileTaskCancelled(effectiveUserId, recoveryScope, item.id) && (item.status === 'waiting' || item.status === 'preparing' || item.status === 'processing' ||
(item.status === 'completed' && Boolean(item.extractedText) && !item.deliveredToWorkflow)),
);
if (!eligible.length || !isCurrent()) return;

const needsReadinessCheck = eligible.some((item) =>  
  item.status !== 'completed' && isDirectOcrFile(item) && !(item.status === 'processing' && item.jobId),  
);  
if (needsReadinessCheck) {  
  // Persist a real preparation stage while the server checks the OCR pool;  
  // the aggregate indicator must not remain at 0% during this phase.  
  for (const item of eligible) {  
    if (!isCurrent()) return;  
    if (!isFileTaskCancelled(effectiveUserId, recoveryScope, item.id) && item.status !== 'completed' && isDirectOcrFile(item) && !(item.status === 'processing' && item.jobId)) {
      try {
        await updateRecord(item.id, { status: 'preparing', stageLabel: 'التحقق من جاهزية خدمة OCR' });
      } catch (error: any) {
        if (error?.name !== 'AbortError') throw error;
      }
    }  
  }  
  try {  
    await checkServerOCRReadiness();  
  } catch (error: any) {  
    if (isCurrent() && mountedRef.current) {  
      setErrorMsg(error?.message || 'مجموعة مفاتيح الصور والمستندات (OCR) غير جاهزة.');  
      setIsProcessing(false);  
      onProcessingChange?.(false);  
    }  
    return;  
  }  
}  

if (!isCurrent()) return;  
if (mountedRef.current) {  
  setIsProcessing(true);  
  onProcessingChange?.(true);  
  setErrorMsg(null);  
}  

for (let index = 0; index < eligible.length; index += 1) {  
  const item = eligible[index];  
  if (!isCurrent()) return;  
  await processStoredItem(item);  
  if (index < eligible.length - 1 && isDirectOcrFile(item) && isDirectOcrFile(eligible[index + 1])) {  
    await new Promise((resolve) => setTimeout(resolve, 2500));  
  }  
}  

if (!isCurrent()) return;  
const latest = await getFileBatchItems(effectiveUserId, recoveryScope).catch(() => []);  
if (!isCurrent()) return;  
setStoredItems(latest);  
const batchId = records.find((item) => item.batchId === activeBatchId)?.batchId || records[0]?.batchId || activeBatchId;  
const batchItems = batchId ? latest.filter((item) => item.batchId === batchId) : latest;  
const completedItems = batchItems.filter((item) => item.status === 'completed');  
if (completedItems.length) {  
  setSuccessInfo({  
    processedCount: completedItems.length,  
    totalChars: completedItems.reduce((sum, item) => sum + String(item.extractedText || '').length, 0),  
  });  
}  
setCurrentFileId('');  
setIsProcessing(false);  
onProcessingChange?.(false);

};

useEffect(() => {
let active = true;
const restoringContextKey = contextKey;
setIsRestoring(true);
setStoredItems([]);
setPreviewUrls({});
setActiveBatchId('');
setWarnings([]);
setErrorMsg(null);
setSuccessInfo(null);
setIsProcessing(false);
setCurrentFileId('');
onProcessingChange?.(false);
void (async () => {
try {
let records = await getFileBatchItems(effectiveUserId, recoveryScope);
if (!active) return;
if (recoveryScope === 'vault') {
  const deliveredItems = records.filter((item) => item.status === 'completed' && item.deliveredToWorkflow);
  for (const item of deliveredItems) {
    try { await deleteFileBatchItem(item.id, effectiveUserId, recoveryScope); }
    catch (cleanupError) { console.warn('Could not clean up an already delivered vault upload:', cleanupError); }
  }
  records = records.filter((item) => !(item.status === 'completed' && item.deliveredToWorkflow));
}
setStoredItems(records);
const activeRecords = records.filter((item) =>
item.status === 'waiting' || item.status === 'preparing' || item.status === 'processing' ||
(item.status === 'completed' && Boolean(item.extractedText) && !item.deliveredToWorkflow),
);
const latestBatch = activeRecords[0]?.batchId || records[records.length - 1]?.batchId || '';
setActiveBatchId(latestBatch);
setIsRestoring(false);

if (activeRecords.length) {  
      setIsProcessing(true);  
      onProcessingChange?.(true);  
      await processRecords(activeRecords, () => active && mountedRef.current && activeContextRef.current === restoringContextKey);  
      if (!active || activeContextRef.current !== restoringContextKey) return;  
      const refreshed = await getFileBatchItems(effectiveUserId, recoveryScope).catch(() => []);  
      setStoredItems(refreshed);  
    }  

    // Backward compatibility: restore OCR jobs created by older versions  
    // that have no corresponding IndexedDB file record.  
    const latestFileRecords = await getFileBatchItems(effectiveUserId, recoveryScope).catch(() => records);  
    const knownJobIds = new Set(latestFileRecords.map((item) => item.jobId).filter(Boolean));  
    const legacyJobs = getSavedOcrJobs(recoveryScope, effectiveUserId).filter((job) => !knownJobIds.has(job.jobId));  
    if (legacyJobs.length) {  
      setIsProcessing(true);  
      onProcessingChange?.(true);  
      const recoveredNames: string[] = [];  
      let recoveredChars = 0;  
      for (const job of legacyJobs) {  
        if (!active || activeContextRef.current !== restoringContextKey) return;  
        try {  
          const text = await resumeSavedOcrTask(job.jobId, recoveryScope, effectiveUserId);  
          if (!text.trim()) continue;  
          if (activeContextRef.current !== restoringContextKey) return;  
          await onTextExtractedRef.current(text, job.fileName, job.mimeType || undefined);  
          recoveredNames.push(job.fileName);  
          recoveredChars += text.length;  
          acknowledgeSavedOcrJob(recoveryScope, effectiveUserId, job.jobId);  
        } catch (error: any) {  
          if (!error?.savedJobPending) acknowledgeSavedOcrJob(recoveryScope, effectiveUserId, error?.jobId || job.jobId);  
          if (active && activeContextRef.current === restoringContextKey) setWarnings((previous) => [...previous, error?.savedJobPending  
            ? `المهمة القديمة الخاصة بالملف ${job.fileName} ما زالت محفوظة على الخادم.`  
            : `تعذر استعادة المهمة القديمة ${job.fileName}: ${error?.message || 'حدث خطأ.'}`]);  
        }  
      }  
      if (active && recoveredNames.length) setSuccessInfo({ processedCount: recoveredNames.length, totalChars: recoveredChars });  
      if (active) {  
        setIsProcessing(false);  
        onProcessingChange?.(false);  
      }  
    }  
  } catch (error: any) {  
    if (active) {  
      setErrorMsg(error?.message || 'تعذرت استعادة الملفات المحفوظة على هذا الجهاز.');  
      setIsRestoring(false);  
      setIsProcessing(false);  
      onProcessingChange?.(false);  
    }  
  }  
})();  
return () => { active = false; };

}, [effectiveUserId, recoveryScope]);

const processFilesBatch = async (filesList: FileList | File[]) => {
const rawFiles = Array.from(filesList);
if (!rawFiles.length || isProcessing) return;

const filesToStore = rawFiles.slice(0, maxFiles);  
const batchId = createFileBatchId();  
const createdAt = new Date().toISOString();  
const newItems: StoredFileBatchItem[] = filesToStore.map((file, index) => {  
  const mimeType = inferFileMimeType(file);  
  return {  
    id: createFileBatchId(),  
    userId: effectiveUserId,  
    scope: recoveryScope,  
    batchId,  
    order: index,  
    fileName: file.name,  
    mimeType,  
    size: file.size,  
    lastModified: file.lastModified || Date.now(),  
    createdAt,  
    updatedAt: createdAt,  
    status: 'waiting',  
    stageLabel: 'في انتظار بدء المعالجة',  
    retryCount: 0,  
    deliveredToWorkflow: false,  
    blob: file.slice(0, file.size, mimeType),  
  };  
});  

setErrorMsg(null);  
setWarnings(rawFiles.length > maxFiles ? [`تم تحديد أول ${maxFiles} ملفات فقط لتجنب ضغط الذاكرة.`] : []);  
setSuccessInfo(null);  
setActiveBatchId(batchId);  
setIsProcessing(true);  
onProcessingChange?.(true);  

try {  
  // Save the original bytes and their stable order before starting any OCR request.  
  await saveFileBatchItems(newItems);  
  if (mountedRef.current) {  
    setStoredItems((previous) => [...previous, ...newItems].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.batchId.localeCompare(b.batchId) || a.order - b.order));  
  }  
  await processRecords(newItems);  
} catch (error: any) {  
  if (mountedRef.current) {  
    setIsProcessing(false);  
    onProcessingChange?.(false);  
    setErrorMsg(error?.message || 'تعذر حفظ الملفات الأصلية على هذا الجهاز؛ لم تبدأ عملية OCR.');  
  }  
} finally {  
  if (fileInputRef.current) fileInputRef.current.value = '';  
}

};

const handleContinuePending = async () => {
const pending = storedItems.filter((item) => item.status === 'waiting' || item.status === 'preparing' || item.status === 'processing');
if (pending.length) await processRecords(pending);
};

const handleRetryFailed = async () => {
const failed = storedItems.filter((item) => item.status === 'failed');
if (!failed.length) return;
try {
const resetItems: StoredFileBatchItem[] = [];
for (const item of failed) {
const updated = await updateRecord(item.id, {
status: 'waiting',
stageLabel: 'في انتظار إعادة المحاولة',
jobId: undefined,
error: undefined,
serverJobCreated: false,
retryCount: item.retryCount + 1,
deliveredToWorkflow: false,
});
resetItems.push(updated);
}
setWarnings([]);
setErrorMsg(null);
setActiveBatchId(resetItems[0]?.batchId || activeBatchId);
await processRecords(resetItems);
} catch (error: any) {
setErrorMsg(error?.message || 'تعذر تجهيز الملفات الفاشلة لإعادة المحاولة.');
}
};

const handleRemoveStoredItem = async (item: StoredFileBatchItem) => {
const taskKey = makeFileTaskKey(effectiveUserId, recoveryScope, item.id);
CANCELLED_FILE_TASKS.add(taskKey);
try {
await deleteFileBatchItem(item.id, effectiveUserId, recoveryScope);
const activeController = ACTIVE_FILE_TASK_CONTROLLERS.get(taskKey);
activeController?.abort();
if (item.jobId) {
  acknowledgeSavedOcrJob(recoveryScope, effectiveUserId, item.jobId);
  if (!activeController && (item.status === 'preparing' || item.status === 'processing')) {
    await cancelSavedOcrTask(item.jobId);
  }
}
setStoredItems((previous) => previous.filter((record) => record.id !== item.id));
setCurrentFileId((current) => current === item.id ? '' : current);
} catch (error: any) {
CANCELLED_FILE_TASKS.delete(taskKey);
setErrorMsg(error?.message || 'تعذر حذف الملف المحفوظ.');
}
};

const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
if (event.target.files?.length) void processFilesBatch(event.target.files);
};

const handleDragOver = (event: React.DragEvent) => {
event.preventDefault();
setIsDragging(true);
};

const handleDragLeave = (event: React.DragEvent) => {
event.preventDefault();
setIsDragging(false);
};

const handleDrop = (event: React.DragEvent) => {
event.preventDefault();
setIsDragging(false);
if (event.dataTransfer.files?.length) void processFilesBatch(event.dataTransfer.files);
};

const currentBatchItems = useMemo(
() => storedItems.filter((item) => (!activeBatchId || item.batchId === activeBatchId) && !(recoveryScope === 'vault' && item.status === 'completed' && item.deliveredToWorkflow)),
[storedItems, activeBatchId, recoveryScope],
);
const visibleStoredItems = recoveryScope === 'vault'
  ? storedItems.filter((item) => !(item.status === 'completed' && item.deliveredToWorkflow))
  : storedItems;
const completedCount = currentBatchItems.filter((item) => item.status === 'completed').length;
const overallProgress = currentBatchItems.length
? Math.round(currentBatchItems.reduce((sum, item) => sum + statusProgress(item.status), 0) / currentBatchItems.length)
: 0;
const currentItem = storedItems.find((item) => item.id === currentFileId);
const pendingCount = storedItems.filter((item) => item.status === 'waiting' || item.status === 'preparing' || item.status === 'processing').length;
const failedCount = storedItems.filter((item) => item.status === 'failed').length;

return (
<div
onDragOver={handleDragOver}
onDragLeave={handleDragLeave}
onDrop={handleDrop}
className={`rounded-2xl border-2 transition-all p-3.5 my-2.5 ${isDragging ? 'border-amber-400 bg-amber-950/40 shadow-lg shadow-amber-900/30' : isProcessing ? 'border-amber-500/80 bg-slate-900/90' : 'border-dashed border-amber-600/40 bg-slate-900/80 hover:border-[#b45309] hover:bg-slate-900'}`}
>
<input  
ref={fileInputRef}  
type="file"  
multiple  
accept=".pdf,.docx,.doc,.txt,.png,.jpg,.jpeg,.webp,.bmp"  
onChange={handleFileChange}  
className="hidden"  
/>
<div className="flex flex-col sm:flex-row items-center justify-between gap-3 text-right">
<div className="flex items-center gap-3.5 w-full sm:w-auto">
<div className="w-11 h-11 rounded-xl bg-gradient-to-br from-amber-600/20 to-amber-700/30 border border-amber-500/40 flex items-center justify-center text-amber-400 flex-shrink-0 shadow-inner">
{isProcessing ? <Loader2 className="w-5 h-5 animate-spin text-amber-300" /> : <UploadCloud className="w-5 h-5" />}
</div>
<div className="flex-1">
<div className="flex items-center gap-2 flex-wrap">
<h4 className="text-xs sm:text-sm font-bold text-slate-100">{title}</h4>
<div className="flex items-center gap-1">
<span className="text-[10px] bg-amber-500/20 text-amber-300 px-1.5 py-0.5 rounded border border-amber-500/40 font-bold flex items-center gap-1">
<Layers className="w-3 h-3" /> حتى {maxFiles} ملفات
</span>
<span className="text-[10px] bg-blue-950/80 text-blue-300 px-1.5 py-0.5 rounded border border-blue-500/30 font-mono font-bold">وورد</span>
<span className="text-[10px] bg-rose-950/80 text-rose-300 px-1.5 py-0.5 rounded border border-rose-500/30 font-mono font-bold">ملف بي دي إف</span>
<span className="text-[10px] bg-emerald-950/80 text-emerald-300 px-1.5 py-0.5 rounded border border-emerald-500/30 font-mono font-bold">صور / استخراج النص آليًا</span>
</div>
</div>
<p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">{description}</p>
</div>
</div>

<button  
      type="button"  
      onClick={() => fileInputRef.current?.click()}  
      disabled={isProcessing || isRestoring}  
      className="w-full sm:w-auto px-4 py-2.5 bg-gradient-to-r from-[#b45309] to-amber-600 hover:from-amber-600 hover:to-amber-500 text-white rounded-xl text-xs font-bold transition-all shadow-md shadow-amber-950/50 cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2 flex-shrink-0 whitespace-nowrap"  
    >  
      {isProcessing || isRestoring ? <><Loader2 className="w-4 h-4 animate-spin text-amber-200" /><span>{isRestoring ? 'جارٍ استعادة الملفات...' : 'جارٍ المعالجة...'}</span></> : <><UploadCloud className="w-4 h-4" /><span>اختر مستندات</span></>}  
    </button>  
  </div>  

  {isRestoring && (  
    <div className="mt-3 text-[11px] text-slate-300 flex items-center gap-2" role="status">  
      <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400" /> جارٍ قراءة الملفات الأصلية وحالات OCR من التخزين المحلي...  
    </div>  
  )}  

  {currentBatchItems.length > 0 && (  
    <div className="mt-3 p-3 bg-amber-950/50 border border-amber-500/50 rounded-xl space-y-2">  
      <div className="flex items-center justify-between gap-2 text-xs text-amber-200">  
        <span className="font-bold">التقدم الإجمالي لمراحل الملفات</span>  
        <b className="text-white tabular-nums">{overallProgress}%</b>  
      </div>  
      <div className="w-full bg-slate-900 h-2.5 rounded-full overflow-hidden border border-slate-700" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={overallProgress}>  
        <div className="bg-gradient-to-r from-amber-500 to-emerald-500 h-full transition-all duration-300" style={{ width: `${overallProgress}%` }} />  
      </div>  
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-300">  
        <span>مكتمل: <b className="text-emerald-300">{completedCount}</b> من {currentBatchItems.length}</span>  
        {currentItem && <span className="truncate max-w-full">الملف الجاري: <b className="text-white">{currentItem.fileName}</b></span>}  
      </div>  
      <p className="text-[10px] leading-relaxed text-slate-400">  
        النسبة تعكس مراحل الملفات المحفوظة والتجهيز والمعالجة واكتمال الملفات؛ خدمة OCR لا ترسل نسبة داخلية لحظية عن عمل النموذج نفسه.  
      </p>  
    </div>  
  )}  

  {visibleStoredItems.length > 0 && (  
    <div className="mt-3 space-y-2" aria-live="polite">  
      <div className="flex items-center justify-between flex-wrap gap-2">  
        <h5 className="text-xs font-bold text-slate-200">الملفات المحفوظة في هذه الواجهة ({visibleStoredItems.length})</h5>  
        <div className="flex items-center gap-2">  
          {!isProcessing && pendingCount > 0 && (  
            <button type="button" onClick={() => void handleContinuePending()} className="text-[10px] px-2 py-1 rounded-lg border border-amber-600/50 text-amber-200 hover:bg-amber-950/70 flex items-center gap-1">  
              <Clock3 className="w-3 h-3" /> متابعة المعلّق ({pendingCount})  
            </button>  
          )}  
          {!isProcessing && failedCount > 0 && (  
            <button type="button" onClick={() => void handleRetryFailed()} className="text-[10px] px-2 py-1 rounded-lg border border-rose-600/50 text-rose-200 hover:bg-rose-950/70 flex items-center gap-1">  
              <RefreshCw className="w-3 h-3" /> إعادة محاولة الفاشل ({failedCount})  
            </button>  
          )}  
        </div>  
      </div>  
      {visibleStoredItems.map((item) => {  
        const percent = statusProgress(item.status);  
        const isCurrent = item.id === currentFileId;  
        const isBusy = item.status === 'preparing' || item.status === 'processing';  
        return (  
          <div key={item.id} className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 ${isCurrent ? 'border-amber-500/60 bg-amber-950/30' : 'border-slate-700 bg-slate-950/60'}`}>  
            <div className="w-9 h-9 rounded-md overflow-hidden border border-slate-700 bg-slate-900 flex items-center justify-center flex-shrink-0">  
              {isImageFile(item) && previewUrls[item.id]  
                ? <img src={previewUrls[item.id]} alt={`معاينة ${item.fileName}`} className="w-full h-full object-cover" />  
                : isImageFile(item)  
                  ? <ImageIcon className="w-4 h-4 text-slate-500" />  
                  : <FileText className="w-4 h-4 text-slate-400" />}  
            </div>  
            <div className="min-w-0 flex-1 space-y-0.5">  
              <div className="flex items-center justify-between gap-2">  
                <span className="text-[11px] font-bold text-white truncate" title={item.fileName}>{item.order + 1}. {item.fileName}</span>  
                <span className={`text-[10px] font-bold whitespace-nowrap ${item.status === 'completed' ? 'text-emerald-300' : item.status === 'failed' ? 'text-rose-300' : 'text-amber-200'}`}>{statusLabel(item)}{item.status === 'preparing' || item.status === 'processing' ? ` · ${percent}%` : ''}</span>  
              </div>  
              <div className="w-full h-1 rounded-full bg-slate-800 overflow-hidden">  
                <div className={`h-full transition-all duration-300 ${item.status === 'failed' ? 'bg-rose-500' : 'bg-gradient-to-r from-amber-500 to-emerald-500'}`} style={{ width: `${percent}%` }} />  
              </div>  
              {item.error && <p className="text-[10px] text-rose-300 leading-relaxed">{item.error}</p>}  
              {!item.error && <p className="text-[10px] text-slate-500">{(item.size / 1024).toFixed(0)} كيلوبايت · {item.stageLabel || statusLabel(item)}</p>}  
            </div>  
            <button  
              type="button"  
              onClick={() => void handleRemoveStoredItem(item)}  
              aria-label={isBusy ? `إلغاء المعالجة وحذف ${item.fileName}` : `حذف ${item.fileName}`}
              title={isBusy ? 'إلغاء معالجة الملف وحذفه' : 'حذف الملف المحفوظ'}
              className="p-1.5 text-slate-400 hover:text-rose-300 hover:bg-rose-950/40 rounded-md flex-shrink-0"
            >  
              <X className="w-3.5 h-3.5" />  
            </button>  
          </div>  
        );  
      })}  
    </div>  
  )}  

  {successInfo && (  
    <div className="mt-3 p-2.5 bg-emerald-950/80 border border-emerald-600/50 rounded-xl text-emerald-200 text-xs flex items-center justify-between shadow-sm">  
      <div className="flex items-center gap-2">  
        <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />  
        <span>تم استخراج نصوص <b>({successInfo.processedCount})</b> ملفات بنجاح وإدراجها. إجمالي الأحرف: {successInfo.totalChars.toLocaleString('ar-EG')}.</span>  
      </div>  
      <button type="button" onClick={() => setSuccessInfo(null)} className="text-slate-400 hover:text-white p-0.5 rounded"><X className="w-3.5 h-3.5" /></button>  
    </div>  
  )}  

  {warnings.length > 0 && (  
    <div className="mt-2 space-y-1">  
      {warnings.map((warning, index) => (  
        <div key={`${index}-${warning}`} className="p-2 bg-amber-950/60 border border-amber-600/40 rounded-lg text-amber-200 text-[11px] flex items-center justify-between">  
          <div className="flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" /><span>{warning}</span></div>  
          <button type="button" onClick={() => setWarnings((previous) => previous.filter((_, itemIndex) => itemIndex !== index))} className="text-slate-400 hover:text-white p-0.5"><X className="w-3 h-3" /></button>  
        </div>  
      ))}  
    </div>  
  )}  

  {errorMsg && (  
    <div className="mt-3 p-2.5 bg-rose-950/80 border border-rose-600/50 rounded-xl text-rose-200 text-xs flex items-center justify-between shadow-sm">  
      <div className="flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-rose-400 flex-shrink-0" /><span>{errorMsg}</span></div>  
      <button type="button" onClick={() => setErrorMsg(null)} className="text-slate-400 hover:text-white p-0.5 rounded"><X className="w-3.5 h-3.5" /></button>  
    </div>  
  )}  
</div>

);
};
