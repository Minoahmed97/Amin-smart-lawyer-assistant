import { getLawyerStyleContext, getAllLawModels } from '../utils/legalVaultService.ts';
import { getSessionToken } from './authService.ts';

// Throttling control to prevent burst requests
let lastRequestTimestamp = 0;
const MIN_REQUEST_INTERVAL_MS = 150;
// Do not abort generation because of an elapsed-time or idle timer. The backend
// sends keepalive events while the model is working; the hosting platform's
// function-duration limit remains the final hard limit.

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
  // Strip leaked provider safety metadata, not legal content or actual safety controls.
  text = text
    .replace(/\b(?:user\s*)?safety\s*:\s*safe\b/gi, '')
    .replace(/\bfinish[_ ]?reason\s*:\s*(?:stop|length|safety|end[_ ]?turn)\b/gi, '')
    .replace(/\[\[AMIN_STREAM_COMPLETE_[A-Z0-9]+\]\]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

async function postAiRequest( url: string, payload: any, maxRetries = 1, onChunk?: (text: string) => void ): Promise<any> {
  let lastError: any = null;

  // Provider/model/key failover is handled server-side. Do not silently repeat
  // the whole legal generation from the browser and unexpectedly consume quota twice.
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let streamStarted = false;
    try {
      const requestPayload = onChunk ? { ...payload, stream: true } : payload;
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
        return await response.json();
      }

      if (response.status === 429 || response.status >= 500) {
        if (attempt < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          continue;
        }
      }

      const errorData = await response.json().catch(() => ({}));
      const responseError: any = new Error(errorData.error || `خطأ استجابة (${response.status})`);
      responseError.retryable = response.status === 429 || response.status >= 500;
      throw responseError;
    } catch (err: any) {
      lastError = err;

      // Do not waste time retrying session/authentication or input errors.
      // Network failures remain retryable; HTTP failures are retried only for 429/5xx.
      if (err?.retryable === false) throw err;

      // Never restart an already visible stream, otherwise the user could see
      // duplicated legal text.
      if (streamStarted) throw err;

      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        continue;
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
    judicialWorkType: params.judicialWorkType,
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
    const data = await postAiRequest('/api/gemini/deconstruct', payload, 1, onChunk);
    return cleanDirectResponse(data.result);
  } catch (err: any) {
    throw new Error(err?.message || 'تعذر إتمام العملية عبر الخادم المركزي.');
  }
}

function draftJobStorageKey(userId?: string): string {
  return `amin_judicial_draft_job_id_${String(userId || 'default')}`;
}

function saveDraftJobId(jobId: string, userId?: string) {
  try { localStorage.setItem(draftJobStorageKey(userId), jobId); } catch {}
}

function clearDraftJobId(userId?: string) {
  try { localStorage.removeItem(draftJobStorageKey(userId)); } catch {}
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDraftJob(jobId: string, userId?: string, onChunk?: (text: string) => void): Promise<string> {
  let deliveredLength = 0;
  let consecutiveNetworkErrors = 0;
  while (true) {
    try {
      const response = await fetch(`/api/gemini/jobs?id=${encodeURIComponent(jobId)}`, {
        method: 'GET',
        headers: getRequestHeaders(),
        cache: 'no-store',
      });
      if (!response.ok) {
        if (response.status >= 500 || response.status === 429) {
          consecutiveNetworkErrors += 1;
          await wait(Math.min(5000, 1200 + consecutiveNetworkErrors * 500));
          continue;
        }
        const errorData = await response.json().catch(() => ({}));
        if (response.status === 404) clearDraftJobId(userId);
        throw new Error(errorData.error || `تعذر استرجاع مهمة الصياغة (${response.status}).`);
      }

      consecutiveNetworkErrors = 0;
      const job = await response.json();
      const partial = typeof job.partialResult === 'string' ? job.partialResult : '';
      if (partial.length > deliveredLength) {
        onChunk?.(partial.slice(deliveredLength));
        deliveredLength = partial.length;
      }

      if (job.status === 'completed') {
        const result = typeof job.result === 'string' && job.result ? job.result : partial;
        if (result.length > deliveredLength) onChunk?.(result.slice(deliveredLength));
        clearDraftJobId(userId);
        return cleanDirectResponse(result);
      }
      if (job.status === 'failed') {
        clearDraftJobId(userId);
        throw new Error(job.error || 'تعذر إكمال الصياغة.');
      }
      await wait(1600);
    } catch (err: any) {
      if (err instanceof TypeError || /failed to fetch|network request failed|networkerror|load failed|fetch failed/i.test(String(err?.message || ''))) {
        consecutiveNetworkErrors += 1;
        await wait(Math.min(6000, 1200 + consecutiveNetworkErrors * 700));
        // Keep polling the same persisted job. Mobile browsers often pause networking
        // while backgrounded; once the app is active again this loop resumes without
        // starting another generation or consuming credits a second time.
        continue;
      }
      throw err;
    }
  }
}

export async function resumeDraftCounterBrief(jobId: string, onChunk?: (text: string) => void, userId?: string): Promise<string> {
  if (!jobId) throw new Error('لا يوجد معرّف مهمة لاستعادتها.');
  saveDraftJobId(jobId, userId);
  return waitForDraftJob(jobId, userId, onChunk);
}

export async function draftCounterBrief(params: { courtType?: string; circuit?: string; briefType?: string; judicialWorkType?: string; customJudicialWorkType?: string; clientRole?: string; clientName?: string; opponentName?: string; caseNumber?: string; sessionDate?: string; facts: string; defenses?: string; requests?: string; customInstructions?: string; userId?: string; }, onChunk?: (text: string) => void ): Promise<string> {
  await throttleRequests();
  const effectiveWorkType = params.customJudicialWorkType?.trim()
    ? params.customJudicialWorkType.trim()
    : params.judicialWorkType || params.briefType || '';
  const personalModels = getAllLawModels(params.userId);
  if (!personalModels.length) {
    throw new Error('خزانة هذا الحساب لا تحتوي على نماذج شخصية محفوظة. لم يبدأ التوليد ولم يُخصم رصيد؛ أضف نموذجاً من مكتبتك أولاً لضمان أن الصياغة تستند إلى أسلوبك لا إلى قالب عام.');
  }
  const lawyerVaultContext = getLawyerStyleContext({
    courtType: params.courtType,
    briefType: params.briefType,
    judicialWorkType: effectiveWorkType,
    factsOrSubject: params.facts,
  }, params.userId);

  try {
    const { userId: _userId, ...requestParams } = params;
    const clientJobId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = Math.random() * 16 | 0;
          return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    // Persist the id before the request so a lost response after server-side
    // job creation can still be recovered without creating a second job.
    saveDraftJobId(clientJobId, params.userId);
    const response = await fetch('/api/gemini/jobs', {
      method: 'POST',
      headers: getRequestHeaders(),
      body: JSON.stringify({ ...requestParams, jobId: clientJobId, effectiveWorkType, vaultContext: lawyerVaultContext }),
    });
    const created = await response.json().catch(() => ({}));
    if (!response.ok || !created.jobId) {
      if (response.status >= 400 && response.status < 500) clearDraftJobId(params.userId);
      throw new Error(created.error || `تعذر بدء مهمة الصياغة (${response.status}).`);
    }
    saveDraftJobId(String(created.jobId), params.userId);
    return await waitForDraftJob(String(created.jobId), params.userId, onChunk);
  } catch (err: any) {
    throw new Error(err?.message || 'تعذر إتمام العملية عبر الخادم المركزي.');
  }
}

export async function qualifyLegalCase( disputeDetails: string, clientGoals?: string, onChunk?: (text: string) => void, userId?: string ): Promise<string> {
  await throttleRequests();
  const lawyerVaultContext = getLawyerStyleContext({
    factsOrSubject: disputeDetails,
  }, userId);

  try {
    const data = await postAiRequest('/api/gemini/qualify', {
      disputeDetails,
      clientGoals: clientGoals || '',
      vaultContext: lawyerVaultContext,
    }, 1, onChunk);
    return cleanDirectResponse(data.result);
  } catch (err: any) {
    throw new Error(err?.message || 'تعذر إتمام العملية عبر الخادم المركزي.');
  }
}

export async function refineDraftText( draftText: string, enhancementType: 'moreDecisive' | 'addPrecedents' | 'addProceduralDefenses' | 'auditCheck', onChunk?: (text: string) => void, userId?: string ): Promise<string> {
  await throttleRequests();
  const lawyerVaultContext = getLawyerStyleContext({
    factsOrSubject: draftText,
  }, userId);

  try {
    const data = await postAiRequest('/api/gemini/refine', {
      draftText,
      enhancementType,
      vaultContext: lawyerVaultContext,
    }, 1, onChunk);
    return cleanDirectResponse(data.result);
  } catch (err: any) {
    throw new Error(err?.message || 'تعذر إتمام العملية عبر الخادم المركزي.');
  }
}
