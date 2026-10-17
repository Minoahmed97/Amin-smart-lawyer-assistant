import { getLawyerStyleContext } from '../utils/legalVaultService.ts';
import { getSessionToken } from './authService.ts';

// Throttling control to prevent burst requests
let lastRequestTimestamp = 0;
const MIN_REQUEST_INTERVAL_MS = 150;

async function throttleRequests(): Promise<void> {
  const now = Date.now();
  const timeSinceLast = now - lastRequestTimestamp;
  if (timeSinceLast < MIN_REQUEST_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MIN_REQUEST_INTERVAL_MS - timeSinceLast));
  }
  lastRequestTimestamp = Date.now();
}

function getRequestHeaders(): Record<string, string> {
  // Gemini credentials stay exclusively on the central server.
  // The AI endpoints require the user's existing central session token.
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const sessionToken = getSessionToken();
  if (sessionToken) headers.Authorization = `Bearer ${sessionToken}`;
  return headers;
}

export function cleanDirectResponse(rawText: string): string {
  if (!rawText) return '';
  let text = rawText.trim();
  const introPatterns = [
    /^(?:[\s\*\#\-\>]*)(?:أهلاً|مرحباً|عزيزي|المحامي|إليك)[^\n]*\n+/i,
  ];
  for (const pattern of introPatterns) {
    text = text.replace(pattern, '').trim();
  }
  return text;
}

export function formatFriendlyLegalAiError(rawMsg: string): string {
  if (!rawMsg) return 'حدث خطأ غير متوقع...';
  if (rawMsg.includes('413') || rawMsg.includes('Payload Too Large')) {
    return 'حجم الملف كبير جداً، يرجى تقسيمه أو تقليله.';
  }
  return 'تعذر إتمام العملية حالياً، يرجى المحاولة لاحقاً...';
}


type SavedJobType = 'counter-brief' | 'deconstruct' | 'qualify' | 'refine';

function makeJobId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {}
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function jobStorageKey(type: SavedJobType, userId?: string): string {
  const user = String(userId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
  return type === 'counter-brief'
    ? `amin_judicial_draft_job_id_${user}`
    : `amin_ai_job_${type}_${user}`;
}

async function requestSavedJob<T extends Record<string, any>>(
  type: SavedJobType,
  payload: T,
  onChunk?: (text: string) => void,
  userId?: string,
  resumeId?: string,
): Promise<string> {
  const key = jobStorageKey(type, userId);
  const storage = typeof localStorage !== 'undefined' ? localStorage : null;
  const jobId = resumeId || storage?.getItem(key) || makeJobId();
  if (storage) storage.setItem(key, jobId);

  const headers = getRequestHeaders();
  let created = Boolean(resumeId);
  if (!resumeId) {
    let receivedHttpResponse = false;
    try {
      const createResponse = await fetch('/api/gemini/jobs', {
        method: 'POST',
        headers,
        body: JSON.stringify({ taskType: type, payload, jobId }),
      });
      receivedHttpResponse = true;
      if (!createResponse.ok) {
        const error = await createResponse.json().catch(() => ({}));
        if (storage) storage.removeItem(key);
        throw new Error(error?.error || `تعذر حفظ المهمة (${createResponse.status}).`);
      }
      created = true;
    } catch (err: any) {
      // Only a transport failure can mean the server accepted the idempotent POST
      // but its response was lost. HTTP/application errors must be shown immediately.
      if (receivedHttpResponse || !storage?.getItem(key)) throw err;
    }
  }

  let lastText = '';
  let transientFailures = 0;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1000 * 60 * 20) {
    try {
      const response = await fetch(`/api/gemini/jobs?id=${encodeURIComponent(jobId)}`, {
        method: 'GET',
        headers,
        cache: 'no-store',
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        const failure: any = new Error(
          error?.error || (response.status === 404
            ? 'لم يتم العثور على المهمة المحفوظة لهذا الحساب.'
            : `تعذر استرجاع حالة المهمة (${response.status}).`),
        );
        failure.statusCode = response.status;
        throw failure;
      }
      const data = await response.json();
      transientFailures = 0;
      const currentText = String(data?.partialResult || data?.result || '');
      if (currentText.length > lastText.length && currentText.startsWith(lastText)) {
        const delta = currentText.slice(lastText.length);
        if (delta && onChunk) onChunk(delta);
        lastText = currentText;
      } else if (currentText && !lastText) {
        if (onChunk) onChunk(currentText);
        lastText = currentText;
      }

      if (data.status === 'completed') {
        const result = String(data.result || lastText);
        if (storage) storage.removeItem(key);
        return result;
      }
      if (data.status === 'failed') {
        if (storage) storage.removeItem(key);
        const failure: any = new Error(data.error || 'فشلت المهمة المحفوظة.');
        failure.terminalJobError = true;
        throw failure;
      }
    } catch (err: any) {
      const statusCode = Number(err?.statusCode);
      const permanentClientError = statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429;
      if (err?.terminalJobError || permanentClientError || (err?.message && /فشلت المهمة المحفوظة|لم يتم العثور على المهمة/.test(err.message))) {
        if (statusCode === 404 && storage) storage.removeItem(key);
        throw err;
      }
      transientFailures++;
      if (transientFailures >= 8) {
        throw new Error('انقطع الاتصال مؤقتًا. تم الاحتفاظ بمعرّف المهمة؛ ارجع للتطبيق وحاول استعادة نفس المهمة دون بدء توليد جديد.');
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error('المهمة ما زالت قيد المعالجة. ارجع لاحقًا لاستعادة النتيجة المحفوظة دون بدء توليد جديد.');
}

export async function resumeDraftCounterBrief(jobId: string, onChunk?: (text: string) => void, userId?: string): Promise<string> {
  return requestSavedJob('counter-brief', {}, onChunk, userId, jobId);
}


export async function resumeSavedAiTask(type: 'deconstruct' | 'qualify', jobId: string, onChunk?: (text: string) => void, userId?: string): Promise<string> {
  return requestSavedJob(type, {}, onChunk, userId, jobId);
}

async function postWithSilentRetry( url: string, payload: any, maxRetries = 5, onChunk?: (text: string) => void ): Promise<any> {
  let lastError: any = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let streamStarted = false;
    try {
      // Use the stable JSON response path for legal generation. The current mobile
      // WebView intermittently drops long-lived SSE/NDJSON streams and reports
      // a generic network error even when the server-side handler is healthy.
      // Existing handlers support ordinary JSON requests as well.
      const requestPayload = payload;
      const response = await fetch(url, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(requestPayload),
      });

      if (response.ok && onChunk && response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const isSse = (response.headers.get('content-type') || '').toLowerCase().includes('text/event-stream');
        let buffer = '';
        let fullText = '';

        const processEvent = (raw: string) => {
          const lines = raw.split(/\r?\n/);
          const payload = isSse
            ? lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n').trim()
            : raw.trim();
          if (!payload) return;

          let event: any;
          try {
            event = JSON.parse(payload);
          } catch {
            return;
          }

          if (event.type === 'chunk' && typeof event.text === 'string') {
            streamStarted = true;
            fullText += event.text;
            onChunk(event.text);
          } else if (event.type === 'error') {
            throw new Error(event.error || 'فشلت الاستجابة المتدفقة.');
          }
        };

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const separator = isSse ? /\r?\n\r?\n/ : /\r?\n/;
          const parts = buffer.split(separator);
          buffer = parts.pop() || '';
          for (const part of parts) processEvent(part);
        }

        buffer += decoder.decode();
        if (buffer.trim()) processEvent(buffer);

        return { result: fullText };
      }

      if (response.ok) {
        const data = await response.json();
        if (onChunk && typeof data?.result === 'string' && data.result) {
          // Preserve the existing UI callback contract; deliver the completed
          // result once instead of progressive chunks.
          onChunk(data.result);
        }
        return data;
      }

      if (response.status === 429 || response.status >= 500) {
        if (attempt < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
          continue;
        }
      }

      const errorData = await response.json().catch(() => ({}));
      const responseError: any = new Error(errorData.error || `خطأ استجابة (${response.status})`);
      responseError.status = response.status;
      responseError.statusCode = response.status;
      throw responseError;
    } catch (err: any) {
      lastError = err;

      // Never restart an already visible stream, otherwise the user could see
      // duplicated legal text. Do not retry permanent HTTP/client errors such
      // as invalid input, missing session, or access denial.
      if (streamStarted) throw err;
      const status = Number(err?.status || err?.statusCode);
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        throw err;
      }

      // Retry transport failures and transient server/rate-limit responses only.
      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        continue;
      }
      if (!status && (err instanceof TypeError || /network|fetch|timeout|timed out|abort/i.test(String(err?.message || '')))) {
        throw new Error('تعذر الاتصال بالخادم المركزي للذكاء الاصطناعي. تحقق من اتصال الإنترنت ثم حاول مرة أخرى.');
      }
      throw err;
    }
  }

  throw lastError || new Error('فشلت محاولة الاتصال.');
}

const EGYPTIAN_LEGAL_SYSTEM_PROMPT = `أنت «أمين»؛ مساعد قانوني مصري شديد الدقة. اقرأ كامل المعلومات المقدمة قبل الإجابة، وحلل الوقائع والمستندات والتواريخ والطلبات والدفوع والتناقضات ونقاط القوة والضعف والثغرات الظاهرة والخفية. لا تخترع واقعة أو مستنداً أو مادة أو حكماً أو رقم طعن. ميّز بين الثابت والاستنتاج والرأي وما يحتاج تحققاً، واعرض البدائل القانونية عند وجودها. نفّذ مراجعة داخلية نهائية قبل الإخراج، وابدأ مباشرة دون تحية أو مقدمة عامة.`;

async function callDirectGeminiApi(_prompt: string, _systemInstruction = EGYPTIAN_LEGAL_SYSTEM_PROMPT): Promise<string> {
  throw new Error('تعذر الاتصال بالخادم المركزي للذكاء الاصطناعي.');
}

export async function deconstructBrief( params: { opponentBriefText: string; courtType?: string; caseNature?: string; judicialWorkType?: string; ourPosition?: string; additionalFacts?: string; userId?: string; }, onChunk?: (text: string) => void ): Promise<string> {
  await throttleRequests();
  const lawyerVaultContext = getLawyerStyleContext({
    courtType: params.courtType,
    // In smart mode, use the personal vault's rebuttal/response examples as
    // the style reference while leaving the AI free to choose the actual output type.
    judicialWorkType: params.judicialWorkType?.trim() || 'تفنيد مستند أو مذكرة',
    factsOrSubject: params.opponentBriefText,
  }, params.userId);

  const payload = {
    opponentBriefText: params.opponentBriefText,
    courtType: params.courtType || '',
    caseNature: params.caseNature || '',
    judicialWorkType: params.judicialWorkType || '',
    ourPosition: params.ourPosition || '',
    additionalFacts: params.additionalFacts || '',
    vaultContext: lawyerVaultContext,
  };

  try {
    const result = await requestSavedJob('deconstruct', payload, onChunk, params.userId);
    return cleanDirectResponse(result);
  } catch (err: any) {
    throw new Error(err?.message || 'تعذر إتمام العملية عبر الخادم المركزي.');
  }
}

export async function draftCounterBrief(params: { courtType?: string; circuit?: string; briefType?: string; judicialWorkType?: string; customJudicialWorkType?: string; clientRole?: string; clientName?: string; opponentName?: string; caseNumber?: string; sessionDate?: string; facts: string; defenses?: string; requests?: string; customInstructions?: string; userId?: string; }, onChunk?: (text: string) => void ): Promise<string> {
  await throttleRequests();
  const effectiveWorkType =
    params.customJudicialWorkType?.trim()
      ? params.customJudicialWorkType.trim()
      : params.judicialWorkType || params.briefType || '';

  const lawyerVaultContext = getLawyerStyleContext({
    courtType: params.courtType,
    briefType: params.briefType,
    judicialWorkType: effectiveWorkType,
    factsOrSubject: params.facts,
  }, params.userId);

  try {
    const { userId: _userId, ...requestParams } = params;
    const result = await requestSavedJob('counter-brief', {
      ...requestParams,
      effectiveWorkType,
      vaultContext: lawyerVaultContext,
    }, onChunk, params.userId);
    return cleanDirectResponse(result);
  } catch (err: any) {
    throw new Error(err?.message || 'تعذر إتمام العملية عبر الخادم المركزي.');
  }
}

export async function qualifyLegalCase( disputeDetails: string, clientGoals?: string, onChunk?: (text: string) => void, userId?: string ): Promise<string> {
  await throttleRequests();

  try {
    // Legal qualification is an independent legal analysis; do not load or send
    // the lawyer's vault context for this task. Other drafting tasks still use it.
    const result = await requestSavedJob('qualify', {
      disputeDetails,
      clientGoals: clientGoals || '',
    }, onChunk, userId);
    return cleanDirectResponse(result);
  } catch (err: any) {
    throw new Error(err?.message || 'تعذر إتمام العملية عبر الخادم المركزي.');
  }
}

export async function refineDraftText( draftText: string, enhancementType: 'moreDecisive' | 'addPrecedents' | 'addProceduralDefenses' | 'auditCheck', onChunk?: (text: string) => void, userId?: string, styleCriteria?: { courtType?: string; briefType?: string; judicialWorkType?: string }, ): Promise<string> {
  await throttleRequests();
  const lawyerVaultContext = getLawyerStyleContext({
    courtType: styleCriteria?.courtType,
    briefType: styleCriteria?.briefType,
    judicialWorkType: styleCriteria?.judicialWorkType || styleCriteria?.briefType,
    factsOrSubject: draftText,
  }, userId);

  try {
    const result = await requestSavedJob('refine', {
      draftText,
      enhancementType,
      vaultContext: lawyerVaultContext,
    }, onChunk, userId);
    return cleanDirectResponse(result);
  } catch (err: any) {
    throw new Error(err?.message || 'تعذر إتمام العملية عبر الخادم المركزي.');
  }
}
