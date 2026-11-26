/**
 * Shared HTTP boundary for browser-to-server API calls.
 * It preserves status metadata and never retries a mutation automatically.
 */
export class ApiRequestError extends Error {
  readonly statusCode: number;
  readonly retryAfter: string | null;
  readonly payload: unknown;

  constructor(message: string, statusCode: number, retryAfter: string | null = null, payload?: unknown) {
    super(message);
    this.name = 'ApiRequestError';
    this.statusCode = statusCode;
    this.retryAfter = retryAfter;
    this.payload = payload;
  }
}

export interface ApiRequestOptions {
  token?: string;
  fallbackErrorMessage?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function findErrorMessage(value: unknown, fallback: string, depth = 0): string {
  if (depth > 3 || value === null || value === undefined) return fallback;
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (!isRecord(value)) return fallback;

  for (const key of ['message', 'error_description', 'error', 'detail']) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    if (isRecord(candidate)) {
      const nested = findErrorMessage(candidate, '', depth + 1);
      if (nested) return nested;
    }
  }
  return fallback;
}

function isFormDataBody(body: BodyInit | null | undefined): boolean {
  return typeof FormData !== 'undefined' && body instanceof FormData;
}

export async function requestJson<T = Record<string, unknown>>(
  path: string,
  init: RequestInit = {},
  options: ApiRequestOptions = {},
): Promise<T> {
  const fallback = options.fallbackErrorMessage || 'تعذر تنفيذ الطلب.';
  const headers = new Headers(init.headers || {});

  if (!headers.has('Content-Type') && !isFormDataBody(init.body)) {
    headers.set('Content-Type', 'application/json');
  }
  if (options.token?.trim() && !headers.has('Authorization')) {
    headers.set('Authorization', 'Bearer ' + options.token.trim());
  }

  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Number(options.timeoutMs || 0);
  const controller = timeoutMs > 0 ? new AbortController() : null;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let externalAbortHandler: (() => void) | undefined;

  if (controller && init.signal) {
    externalAbortHandler = () => controller.abort(init.signal?.reason);
    if (init.signal.aborted) externalAbortHandler();
    else init.signal.addEventListener('abort', externalAbortHandler, { once: true });
  }

  const requestInit: RequestInit = {
    ...init,
    headers,
    ...(controller ? { signal: controller.signal } : {}),
  };

  try {
    const fetchPromise = fetchImpl(path, requestInit);
    const response = timeoutMs > 0
      ? await Promise.race([
          fetchPromise,
          new Promise<Response>((_resolve, reject) => {
            timeoutId = setTimeout(() => {
              timedOut = true;
              controller?.abort();
              reject(new ApiRequestError('انتهت مهلة الاتصال بالخادم.', 408));
            }, timeoutMs);
          }),
        ])
      : await fetchPromise;

    const rawText = await response.text();
    let payload: unknown = null;
    if (rawText.trim()) {
      try {
        payload = JSON.parse(rawText);
      } catch {
        if (response.ok) {
          throw new ApiRequestError('استجابة الخادم غير صالحة؛ تعذر قراءة بيانات الطلب.', 502, null, rawText.slice(0, 300));
        }
        payload = rawText;
      }
    }

    if (!response.ok) {
      throw new ApiRequestError(
        findErrorMessage(payload, fallback),
        response.status,
        response.headers.get('Retry-After'),
        payload,
      );
    }

    return (payload === null ? {} : payload) as T;
  } catch (error) {
    if (timedOut) {
      throw error instanceof ApiRequestError
        ? error
        : new ApiRequestError('انتهت مهلة الاتصال بالخادم.', 408);
    }
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (externalAbortHandler && init.signal) {
      init.signal.removeEventListener('abort', externalAbortHandler);
    }
  }
}
