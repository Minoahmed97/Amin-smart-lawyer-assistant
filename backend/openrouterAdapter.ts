/** OpenRouter adapter exposing the small GoogleGenAI-compatible surface used by this project. */
type Part = { text?: string; inlineData?: { mimeType?: string; data?: string } };

function normalizeMessages(contents: any, systemInstruction?: any) {
  const messages: any[] = [];
  const systemText = typeof systemInstruction === 'string'
    ? systemInstruction
    : Array.isArray(systemInstruction) ? systemInstruction.map((x: any) => x?.text || '').join('\n') : '';
  if (systemText) messages.push({ role: 'system', content: systemText });

  const addParts = (parts: Part[]) => {
    const content: any[] = [];
    for (const part of parts || []) {
      if (typeof part?.text === 'string') content.push({ type: 'text', text: part.text });
      const data = part?.inlineData?.data;
      const mime = part?.inlineData?.mimeType || 'application/octet-stream';
      if (data) {
        const dataUrl = `data:${mime};base64,${data}`;
        if (mime === 'application/pdf') {
          content.push({ type: 'file', file: { filename: 'document.pdf', file_data: dataUrl } });
        } else if (mime.startsWith('image/')) {
          content.push({ type: 'image_url', image_url: { url: dataUrl } });
        } else {
          content.push({ type: 'text', text: `[ملف مرفق من نوع ${mime} لم يتم تحويله إلى صورة.]` });
        }
      }
    }
    return content.length === 1 && content[0].type === 'text' ? content[0].text : content;
  };

  if (typeof contents === 'string') {
    messages.push({ role: 'user', content: contents });
  } else if (Array.isArray(contents)) {
    // Gemini SDK accepts either an array of parts or an array of role/content messages.
    if (contents.every((x: any) => x && typeof x === 'object' && ('parts' in x || 'role' in x))) {
      for (const item of contents) {
        const role = item.role === 'model' ? 'assistant' : (item.role === 'system' ? 'system' : 'user');
        const parts = Array.isArray(item.parts) ? item.parts : (Array.isArray(item.content) ? item.content : []);
        messages.push({ role, content: addParts(parts) });
      }
    } else {
      messages.push({ role: 'user', content: addParts(contents) });
    }
  } else if (contents && typeof contents === 'object') {
    const role = contents.role === 'model' ? 'assistant' : 'user';
    messages.push({ role, content: addParts(Array.isArray(contents.parts) ? contents.parts : []) });
  }
  return messages;
}

function buildPayload(options: any, model: string, stream: boolean) {
  const config = options?.config || {};
  return {
    model,
    messages: normalizeMessages(options?.contents, config.systemInstruction),
    temperature: typeof config.temperature === 'number' ? config.temperature : 0.3,
    // The provider requires a numeric cap; use the request's own limit when supplied.
    // Otherwise use a configurable ceiling, while the legal generator continues output
    // automatically when a model ends early. Providers/models may enforce lower limits.
    max_tokens: Math.max(1024, Math.min(
      typeof config.maxOutputTokens === 'number' ? config.maxOutputTokens : 16384,
      Number(process.env.OPENROUTER_MAX_OUTPUT_TOKENS) > 0
        ? Math.min(32768, Number(process.env.OPENROUTER_MAX_OUTPUT_TOKENS))
        : 16384,
    )),
    stream,
  };
}

type OpenRouterRequest = {
  response: Response;
  timeoutMs: () => number;
  clearTimeout: () => void;
  resetTimeout: (timeoutMs?: number) => void;
  didTimeout: () => boolean;
};

function createTimeoutError(timeoutMs: number, beforeFirstText = false) {
  const error: any = new Error(beforeFirstText
    ? `لم يصل أول جزء من النص عبر OpenRouter خلال ${Math.ceil(timeoutMs / 1000)} ثانية.`
    : `انتهت مهلة طلب OpenRouter بعد ${Math.ceil(timeoutMs / 1000)} ثانية دون تحديث.`);
  error.status = 504;
  error.statusCode = 504;
  return error;
}

async function request(options: any, model: string, stream: boolean): Promise<OpenRouterRequest> {
  const apiKey = String(options?.providerApiKey || process.env.OPENROUTER_API_KEY || '').trim();
  const providerBaseUrl = String(options?.providerBaseUrl || 'https://openrouter.ai/api/v1').replace(/\\/$/, '');
  const isOpenRouter = /openrouter\\.ai\\/api\\/v1$/i.test(providerBaseUrl);
  if (!apiKey) {
    const error: any = new Error('اتصال الذكاء الاصطناعي غير مضبوط. أضف OPENROUTER_API_KEY إلى متغيرات البيئة في Vercel.');
    error.statusCode = 503;
    throw error;
  }
  const requestedTimeout = Number(options?.requestTimeoutMs);
  const baseTimeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout >= 1000
    ? Math.min(requestedTimeout, 285000)
    : (stream ? 60000 : 120000);
  const requestDeadlineAt = Number(options?.requestDeadlineAt);
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeTimeoutMs = baseTimeoutMs;
  const resetTimeout = (timeoutOverrideMs?: number) => {
    if (timer) clearTimeout(timer);
    const remainingMs = Number.isFinite(requestDeadlineAt) ? requestDeadlineAt - Date.now() : Number.POSITIVE_INFINITY;
    const requestedMs = Number.isFinite(timeoutOverrideMs) && Number(timeoutOverrideMs) >= 1000
      ? Number(timeoutOverrideMs)
      : baseTimeoutMs;
    activeTimeoutMs = Math.max(1000, Math.min(requestedMs, remainingMs));
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, activeTimeoutMs);
  };
  const clearRequestTimeout = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  resetTimeout();
  let response: Response;
  try {
    response = await fetch(`${providerBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(isOpenRouter ? {
          'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'https://amin-smart-lawyer-assistant.vercel.app',
          'X-Title': 'Amin Smart Lawyer Assistant',
        } : {}),
      },
      body: JSON.stringify(buildPayload(options, model, stream)),
      signal: controller.signal,
    });
  } catch (error: any) {
    clearRequestTimeout();
    if (timedOut) {
      throw createTimeoutError(activeTimeoutMs, stream);
    }
    throw error;
  }
  if (!response.ok) {
    let body = '';
    try {
      body = await response.text();
    } catch {
      clearRequestTimeout();
      if (timedOut) throw createTimeoutError(activeTimeoutMs, stream);
    }
    clearRequestTimeout();
    const providerName = isOpenRouter ? 'OpenRouter' : 'مزود الذكاء الاصطناعي الاحتياطي';
    const error: any = new Error(`${providerName} request failed (${response.status}): ${body.slice(0, 1200) || response.statusText}`);
    error.status = response.status;
    error.statusCode = response.status;
    throw error;
  }
  return {
    response,
    timeoutMs: () => activeTimeoutMs,
    clearTimeout: clearRequestTimeout,
    resetTimeout,
    didTimeout: () => timedOut,
  };
}

export function createOpenRouterCompatibleClient(
  defaultTimeoutMs = 120000,
  requestDeadlineAt?: number,
  providerBaseUrl = 'https://openrouter.ai/api/v1',
  providerApiKey?: string,
) {
  const applyDefaultTimeout = (options: any) => ({
    ...options,
    requestTimeoutMs: Number(options?.requestTimeoutMs) >= 1000
      ? options.requestTimeoutMs
      : defaultTimeoutMs,
    ...(Number.isFinite(requestDeadlineAt) ? { requestDeadlineAt } : {}),
    providerBaseUrl,
    ...(providerApiKey ? { providerApiKey } : {}),
  });
  return {
    models: {
      generateContent: async (options: any) => {
        const timedOptions = applyDefaultTimeout(options);
        let pending: OpenRouterRequest | null = null;
        try {
          pending = await request(timedOptions, timedOptions.model, false);
          const data: any = await pending.response.json();
          const text = data?.choices?.[0]?.message?.content;
          const finishReason = data?.choices?.[0]?.finish_reason;
          const normalizedText = typeof text === 'string' ? text : Array.isArray(text) ? text.map((p: any) => p?.text || '').join('') : '';
          if (!normalizedText.trim()) {
            const emptyError: any = new Error(`OpenRouter model ${timedOptions.model} returned no text (finish_reason: ${finishReason || 'UNKNOWN'}).`);
            emptyError.status = 503;
            emptyError.statusCode = 503;
            throw emptyError;
          }
          return {
            text: normalizedText,
            candidates: finishReason ? [{ finishReason: String(finishReason).toUpperCase() }] : [],
          };
        } catch (error: any) {
          if (pending?.didTimeout()) throw createTimeoutError(pending.timeoutMs());
          throw error;
        } finally {
          pending?.clearTimeout();
        }
      },
      generateContentStream: async (options: any) => {
        const timedOptions = applyDefaultTimeout(options);
        const pending = await request(timedOptions, timedOptions.model, true);
        const response = pending.response;
        if (!response.body) {
          pending.clearTimeout();
          throw new Error('OpenRouter لم يُرجع تدفق استجابة.');
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        return (async function* () {
          let buffer = '';
          let firstTextSeen = false;
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const events = buffer.split('\n');
              buffer = events.pop() || '';
              for (const line of events) {
                if (!line.startsWith('data:')) continue;
                const raw = line.slice(5).trim();
                if (!raw || raw === '[DONE]') continue;
                let data: any;
                try { data = JSON.parse(raw); } catch { continue; }
                const choice = data?.choices?.[0];
                const text = choice?.delta?.content;
                const finishReason = choice?.finish_reason;
                const normalizedText = typeof text === 'string' ? text : Array.isArray(text) ? text.map((p: any) => p?.text || '').join('') : '';
                if (normalizedText) {
                  firstTextSeen = true;
                  // After the first visible token, allow a longer gap between
                  // chunks; the shorter initial timeout prevents long silent waits.
                  pending.resetTimeout(90000);
                }
                yield {
                  text: normalizedText,
                  candidates: finishReason ? [{ finishReason: String(finishReason).toUpperCase() }] : [],
                };
              }
            }
            // Process a final SSE event even if the connection closes without a trailing newline.
            if (buffer.startsWith('data:')) {
              const raw = buffer.slice(5).trim();
              if (raw && raw !== '[DONE]') {
                try {
                  const data: any = JSON.parse(raw);
                  const choice = data?.choices?.[0];
                  const text = choice?.delta?.content;
                  const finishReason = choice?.finish_reason;
                  const normalizedText = typeof text === 'string' ? text : Array.isArray(text) ? text.map((p: any) => p?.text || '').join('') : '';
                  if (normalizedText) {
                    firstTextSeen = true;
                    pending.resetTimeout(90000);
                  }
                  yield {
                    text: normalizedText,
                    candidates: finishReason ? [{ finishReason: String(finishReason).toUpperCase() }] : [],
                  };
                } catch { /* ignore malformed final SSE event */ }
              }
            }
            if (!firstTextSeen && !pending.didTimeout()) {
              const emptyError: any = new Error(`OpenRouter model ${timedOptions.model} closed its stream before returning text.`);
              emptyError.status = 503;
              emptyError.statusCode = 503;
              throw emptyError;
            }
          } catch (error: any) {
            if (pending.didTimeout()) throw createTimeoutError(pending.timeoutMs(), !firstTextSeen);
            throw error;
          } finally {
            pending.clearTimeout();
            if (pending.didTimeout()) await reader.cancel().catch(() => undefined);
            reader.releaseLock();
          }
        })();
      },
    },
  };
}

export function getOpenRouterModels(): string[] {
  const configured = (process.env.OPENROUTER_MODELS || '')
    .split(/[;,\n]/)
    .map((x) => x.trim().replace(/^['\"]|['\"]$/g, ''))
    .filter(Boolean);

  // Keep this fallback free-only. In particular, reject the paid slug
  // "qwen/qwen3.8-27b" and accept it only if the free variant is explicitly named.
  const configuredFree = configured.filter((model) =>
    model === 'openrouter/free' || /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*:free$/i.test(model)
  );
  const knownFreeFallbacks = [
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'nvidia/nemotron-3.5-lightning:free',
    'qwen/qwen3.8-27b:free',
  ];

  // The dynamic router selects from currently available free models, avoiding
  // reliance on one hard-coded slug when provider availability changes.
  return [...new Set(['openrouter/free', ...(configuredFree.length ? configuredFree.filter((m) => m !== 'openrouter/free') : knownFreeFallbacks)])];
}
