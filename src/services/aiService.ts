import { getLawyerStyleContext } from '../utils/legalVaultService.ts';
import { getSessionToken } from './authService.ts';

// Throttling control to prevent burst requests
let lastRequestTimestamp = 0;
const MIN_REQUEST_INTERVAL_MS = 150;
const AI_REQUEST_TIMEOUT_MS = 120_000;
const AI_STREAM_IDLE_TIMEOUT_MS = 45_000;

async function readWithIdleTimeout<T>(reader: ReadableStreamDefaultReader<T>): Promise<ReadableStreamReadResult<T>> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('توقف تدفق رد الذكاء الاصطناعي لمدة 45 ثانية. يرجى إعادة المحاولة.')), AI_STREAM_IDLE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

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

async function postWithSilentRetry( url: string, payload: any, maxRetries = 5, onChunk?: (text: string) => void ): Promise<any> {
  let lastError: any = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let streamStarted = false;
    let requestTimeout: ReturnType<typeof setTimeout> | undefined;
    let requestController: AbortController | undefined;
    try {
      requestController = new AbortController();
      requestTimeout = setTimeout(() => requestController?.abort(), AI_REQUEST_TIMEOUT_MS);
      const requestPayload = onChunk ? { ...payload, stream: true } : payload;
      const response = await fetch(url, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(requestPayload),
        signal: requestController.signal,
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
          const { value, done } = await readWithIdleTimeout(reader);
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
      lastError = requestController?.signal.aborted
        ? new Error('انتهت مهلة طلب الذكاء الاصطناعي بعد دقيقتين. يرجى المحاولة مرة أخرى.')
        : err;
      if (requestController?.signal.aborted) {
        throw lastError;
      }

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
    } finally {
      if (requestTimeout) clearTimeout(requestTimeout);
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
    const data = await postWithSilentRetry('/api/gemini/deconstruct', payload, 2, onChunk);
    return cleanDirectResponse(data.result);
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
    const data = await postWithSilentRetry('/api/gemini/counter-brief', {
      ...requestParams,
      effectiveWorkType,
      vaultContext: lawyerVaultContext,
    }, 2, onChunk);
    return cleanDirectResponse(data.result);
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
    const data = await postWithSilentRetry('/api/gemini/qualify', {
      disputeDetails,
      clientGoals: clientGoals || '',
      vaultContext: lawyerVaultContext,
    }, 2, onChunk);
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
    const data = await postWithSilentRetry('/api/gemini/refine', {
      draftText,
      enhancementType,
      vaultContext: lawyerVaultContext,
    }, 2, onChunk);
    return cleanDirectResponse(data.result);
  } catch (err: any) {
    throw new Error(err?.message || 'تعذر إتمام العملية عبر الخادم المركزي.');
  }
}
