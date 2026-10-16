import { GoogleGenAI } from '@google/genai';
import { sanitizeGeminiKey } from './centralKeys.ts';
import fs from 'fs';
import path from 'path';
import { createOpenRouterCompatibleClient, getOpenRouterModels } from './openrouterAdapter.ts';
import { fetchServerCloudGeminiKeys } from './supabaseSync.ts';

export function isValidGeminiApiKey(key: any): boolean {
  if (!key || typeof key !== 'string') return false;
  const clean = sanitizeGeminiKey(key);
  if (
    !clean ||
    clean === 'MY_GEMINI_API_KEY' ||
    clean.includes('MY_GEMINI') ||
    clean.includes('...') ||
    clean === 'undefined' ||
    clean === 'null' ||
    clean.length < 10
  ) {
    return false;
  }
  return true;
}

export const GEMINI_MODELS = [
  // Prefer the current stable Flash model, then stable fallbacks.
  // Gemini 3.7 Flash is deprecated and automatically routed to 3.8 Flash.
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
];

let activeKeyIndex = 0;
const permanentlyInvalidKeys = new Set<string>();
// Do not impose an application-level generation timeout. Long legal documents
// are allowed to finish; Vercel's configured function duration remains the hard platform limit.
function createGeminiClient(apiKey: string, timeoutMs?: number): GoogleGenAI {
  const httpOptions: any = { headers: { 'User-Agent': 'aistudio-build' } };
  if (Number.isFinite(timeoutMs) && Number(timeoutMs) >= 1000) {
    // Keep OCR failover attempts bounded. Other AI features retain their prior timeout behavior.
    httpOptions.timeout = Number(timeoutMs);
    httpOptions.retryOptions = { attempts: 1 };
  }
  return new GoogleGenAI({ apiKey, httpOptions });
}

function getGeminiErrorKind(err: any): 'quota' | 'invalid' | 'temporary' | 'other' {
  const msg = String(err?.message || err?.error?.message || '').toLowerCase();
  const status = Number(err?.status || err?.statusCode || err?.response?.status);
  if (status === 429 || /resource_exhausted|quota exceeded|rate.?limit|too many requests/.test(msg)) return 'quota';
  if (status === 401 || /api key not valid|invalid api key|api_key_invalid|key.*(invalid|revoked|deleted)|credential.*invalid/.test(msg)) return 'invalid';
  if (status === 503 || status === 504 || /timeout|timed out|aborted|high demand|service unavailable|temporarily unavailable|\b503\b/.test(msg)) return 'temporary';
  return 'other';
}

function shouldFallbackFromOpenRouter(error: any): boolean {
  const status = Number(error?.status || error?.statusCode || error?.response?.status);
  const message = String(error?.message || error?.error?.message || '').toLowerCase();
  // Keep the app available through Gemini when OpenRouter credentials, free capacity,
  // or a provider/model endpoint fail. The admin diagnostics report provider failures separately.
  return status === 401 || status === 402 || status === 403 || status === 404 || status === 408 || status === 413 || status === 429 || status >= 500 ||
    (status === 400 && /max_tokens|context.?length|model|unsupported|parameter/.test(message)) ||
    /quota|rate.?limit|free.*(limit|unavailable|exhaust)|no free models|temporarily unavailable|service unavailable|timed out|timeout/.test(message);
}
const KEYS_FILE = path.join(process.cwd(), '.keys_config.json');
let inMemoryDynamicKeys: string[] = [];

export function getFileStoredKeys(): string[] {
  // .keys_config.json is a development-only convenience. Production keys must
  // come from durable Supabase storage or explicitly configured server env vars.
  if (process.env.NODE_ENV === 'production') return [];
  try {
    if (fs.existsSync(KEYS_FILE)) {
      const data = fs.readFileSync(KEYS_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        return parsed.filter((k) => isValidGeminiApiKey(k));
      }
    }
  } catch (e) {
    // ignore
  }
  return inMemoryDynamicKeys;
}

export function saveFileStoredKeys(keys: string[]): void {
  inMemoryDynamicKeys = keys.filter((k) => isValidGeminiApiKey(k));
  try {
    fs.writeFileSync(KEYS_FILE, JSON.stringify(inMemoryDynamicKeys, null, 2), 'utf-8');
  } catch (e) {
    console.warn('Error saving keys config to disk:', e);
  }
}

export function addStoredKey(key: string): boolean {
  if (!isValidGeminiApiKey(key)) return false;
  const current = getFileStoredKeys();
  const clean = key.trim();
  if (!current.includes(clean)) {
    current.push(clean);
    saveFileStoredKeys(current);
  }
  return true;
}

export function removeStoredKey(indexOrKey: number | string): boolean {
  const current = getFileStoredKeys();
  if (typeof indexOrKey === 'number') {
    if (indexOrKey >= 0 && indexOrKey < current.length) {
      current.splice(indexOrKey, 1);
      saveFileStoredKeys(current);
      return true;
    }
  } else {
    const updated = current.filter((k) => k !== indexOrKey);
    saveFileStoredKeys(updated);
    return true;
  }
  return false;
}

export async function testGeminiKey(apiKey: string, timeoutMs = 15000): Promise<{ success: boolean; message: string }> {
  const cleanKey = sanitizeGeminiKey(apiKey);
  if (!isValidGeminiApiKey(cleanKey)) {
    return {
      success: false,
      message: '賲賮鬲丕丨 Gemini 睾賷乇 氐丕賱丨 卮賰賱賷丕賸. 丕賱氐賯 丕賱賲賮鬲丕丨 賰丕賲賱丕賸 賲賳 Google AI Studio 賰賲丕 賴賵貙 賵賷噩亘 兀賳 賷亘丿兀 亘賭 AQ. 兀賵 AIza.',
    };
  }

  // Validate the credential and model access without calling generateContent.
  // This prevents adding a key or opening the admin panel from consuming text-generation quota.
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  let lastFailure = '';

  for (const model of GEMINI_MODELS) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      lastFailure = '丕賳鬲賴鬲 丕賱賲賴賱丞 丕賱賲丨丿丿丞 賱賮丨氐 賲賮鬲丕丨 Gemini.';
      break;
    }

    const controller = new AbortController();
    const attemptTimeoutMs = Math.min(5000, remainingMs);
    const timeout = setTimeout(() => controller.abort(), attemptTimeoutMs);
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`,
        {
          method: 'GET',
          headers: { 'x-goog-api-key': cleanKey },
          signal: controller.signal,
        },
      );
      const raw = await response.text();
      let data: any = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch {}

      if (response.ok && data?.name) {
        return {
          success: true,
          message: `鬲賲 丕賱鬲丨賯賯 賲賳 丕賱賲賮鬲丕丨 賵丕賱賵氐賵賱 廿賱賶 亘賷丕賳丕鬲 丕賱賳賲賵匕噩 ${model}. 賴匕丕 丕賱賮丨氐 賱丕 賷賵賱賾丿 賳氐賵氐丕賸 賵賱丕 賷爻鬲賴賱賰 丨氐丞 鬲賵賱賷丿 丕賱賲丨鬲賵賶.`,
        };
      }

      const status = Number(data?.error?.code || response.status);
      const apiMessage = String(data?.error?.message || '').trim();
      lastFailure = `賮卮賱 賮丨氐 ${model} (${status})${apiMessage ? `: ${apiMessage.slice(0, 240)}` : '.'}`;

      const errorText = `${data?.error?.status || ''} ${apiMessage}`;
      if (status === 401 || /api key not valid|invalid api key|api_key_invalid|key.*(invalid|revoked|deleted)|credential.*invalid/i.test(errorText)) {
        return { success: false, message: `兀賰丿鬲 Google 兀賳 賲賮鬲丕丨 Gemini 睾賷乇 氐丕賱丨 兀賵 賲賱睾賶 (${status}). 兀賳卮卅 賲賮鬲丕丨丕賸 噩丿賷丿丕賸.` };
      }

      // Try the next configured model if this model is unavailable or access is restricted.
      if (status === 403 || status === 404 || status === 400) continue;
      if (status === 429) {
        return {
          success: false,
          message: `鬲賲 乇賮囟 胤賱亘 賮丨氐 亘賷丕賳丕鬲 丕賱賳賲賵匕噩 亘爻亘亘 丨丿賾 胤賱亘丕鬲 API (${status}). 賱賲 賷鬲賲 鬲賵賱賷丿 兀賷 賳氐 賵賱賲 鬲購爻鬲賴賱賰 丨氐丞 鬲賵賱賷丿 丕賱賲丨鬲賵賶.`,
        };
      }
    } catch (err: any) {
      lastFailure = controller.signal.aborted
        ? `丕賳鬲賴鬲 賲賴賱丞 賮丨氐 ${model}.`
        : `鬲毓匕乇 丕賱丕鬲氐丕賱 亘賭Gemini 毓亘乇 ${model}: ${err?.message || '禺胤兀 賮賷 丕賱卮亘賰丞.'}`;
      if (controller.signal.aborted) break;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    success: false,
    message: lastFailure || '鬲毓匕乇 丕賱鬲丨賯賯 賲賳 賲賮鬲丕丨 Gemini 兀賵 丕賱賵氐賵賱 廿賱賶 兀賷 賳賲賵匕噩 賲鬲丕丨.',
  };
}

export function getVercelGeminiKeys(_ignoredClientFallbackKey?: string): string[] {
  const keys: string[] = [];
  const addKey = (k: any) => {
    if (!k || typeof k !== 'string') return;
    for (const part of k.split(/[\n,;]+/)) {
      const clean = sanitizeGeminiKey(part.trim());
      if (isValidGeminiApiKey(clean) && !keys.includes(clean)) keys.push(clean);
    }
  };

  // Explicit Gemini variables only. Never scan arbitrary process.env values:
  // Supabase/service-role secrets must never be treated as Gemini credentials.
  for (let i = 1; i <= 50; i++) {
    addKey(process.env[`GEMINI_API_KEY_${i}`]);
    addKey(process.env[`GEMINI_KEY_${i}`]);
  }
  addKey(process.env.GEMINI_API_KEYS);
  addKey(process.env.GEMINI_API_KEY);
  addKey(process.env.GOOGLE_GENAI_API_KEY);
  addKey(process.env.GOOGLE_API_KEY);

  // Keys added from the server-side admin panel are stored locally for
  // development and must participate in the same AI key rotation path.
  for (const storedKey of getFileStoredKeys()) addKey(storedKey);

  return keys;
}

/** * Use both server environment keys and keys saved through the existing admin * panel in Supabase. Keep credentials server-side and preserve key order. */
async function getAvailableGeminiKeys(timeoutMs?: number): Promise<string[]> {
  const keys = getVercelGeminiKeys();
  try {
    for (const key of await fetchServerCloudGeminiKeys(timeoutMs)) {
      if (isValidGeminiApiKey(key) && !keys.includes(key)) keys.push(key);
    }
  } catch (error) {
    // If environment keys exist, a temporary Supabase read failure must not
    // prevent the existing configured provider from working.
    if (keys.length === 0) throw error;
    console.error('[Gemini key rotation] Could not load admin-managed Gemini keys; using configured environment keys.');
  }
  return keys;
}

export function getActiveGeminiKey(): string {
  const keys = getVercelGeminiKeys();
  if (keys.length === 0) return '';
  if (activeKeyIndex >= keys.length) activeKeyIndex = 0;
  return keys[activeKeyIndex];
}

export function rotateToNextGeminiKey(): string {
  const keys = getVercelGeminiKeys();
  if (keys.length <= 1) return keys[0] || '';
  activeKeyIndex = (activeKeyIndex + 1) % keys.length;
  return keys[activeKeyIndex];
}

export async function getManagedGeminiKeyByIndex(index: number): Promise<string> {
  if (!Number.isInteger(index) || index < 0) throw new Error('乇賯賲 丕賱賲賮鬲丕丨 睾賷乇 氐丨賷丨.');
  const keys = await getAvailableGeminiKeys();
  const key = keys[index];
  if (!key) throw new Error('丕賱賲賮鬲丕丨 睾賷乇 賲賵噩賵丿 賮賷 廿毓丿丕丿丕鬲 Gemini 丕賱丨丕賱賷丞.');
  return key;
}

export function getKeysStatus() {
  const keys = getVercelGeminiKeys();
  const maskedList = keys.map((k, idx) => ({
    index: idx,
    id: `key_${idx + 1}`,
    name: idx === 0 ? '賲賮鬲丕丨 乇卅賷爻賷' : `賲賮鬲丕丨 鬲丿賵賷乇 (${idx + 1})`,
    masked: k.length > 8 ? `${k.slice(0, 4)}...${k.slice(-4)}` : '****',
    prefix: k.slice(0, 2),
    isActive: idx === activeKeyIndex,
  }));
  return {
    isConfigured: keys.length > 0,
    totalCount: keys.length,
    activeIndex: activeKeyIndex,
    keys: maskedList,
    rotationEnabled: keys.length > 1,
  };
}

/** Add guidance to let the model choose answer length based on the legal task, without a fixed word count. */
function withAdaptiveAnswerLength(ai: any): any {
  const instruction = '丕禺鬲乇 胤賵賱 丕賱廿噩丕亘丞 亘賳賮爻賰 賵賮賯丕賸 賱胤亘賷毓丞 丕賱胤賱亘 賵鬲毓賯賷丿賴: 賱丕 鬲賱鬲夭賲 亘毓丿丿 賰賱賲丕鬲 孬丕亘鬲 賵賱丕 鬲禺鬲氐乇 賱賲噩乇丿 丕賱丕禺鬲氐丕乇. 賯丿賾賲 廿噩丕亘丞 賯丕賳賵賳賷丞 賲賰鬲賲賱丞 賵賲賮氐賱丞 亘丕賱賯丿乇 丕賱賱丕夭賲貙 賲毓 丕賱賵賯丕卅毓 賵丕賱鬲丨賱賷賱 賵丕賱兀爻丕賳賷丿 賵丕賱禺胤賵丕鬲 丕賱毓賲賱賷丞 毓賳丿 丕賱丨丕噩丞. 鬲噩賳亘 丕賱鬲賰乇丕乇 賵丕賱丨卮賵貙 賵賱丕 鬲禺鬲乇毓 賳氐賵氐丕賸 兀賵 兀丨賰丕賲丕賸 兀賵 賵賯丕卅毓 睾賷乇 賲鬲丨賯賯 賲賳賴丕貙 賵氐乇賾丨 亘賲丕 賷丨鬲丕噩 廿賱賶 鬲丨賯賯. 廿匕丕 胤賱亘 丕賱賲爻鬲禺丿賲 丕賱廿賷噩丕夭 氐乇丕丨丞賸貙 丕賱鬲夭賲 亘胤賱亘賴.';
  const adaptOptions = (options: any) => {
    const { skipAdaptiveAnswerLength, ...apiOptions } = options || {};
    // OCR must preserve its literal-extraction prompt without unrelated legal-drafting instructions.
    if (skipAdaptiveAnswerLength === true) return apiOptions;
    const config = { ...(apiOptions?.config || {}) };
    const current = config.systemInstruction;
    if (typeof current === 'string' && current.trim()) {
      config.systemInstruction = `${current}\n\n${instruction}`;
    } else if (Array.isArray(current)) {
      config.systemInstruction = [...current, { text: instruction }];
    } else if (current && typeof current === 'object') {
      config.systemInstruction = { ...current, parts: [...(Array.isArray(current.parts) ? current.parts : []), { text: instruction }] };
    } else {
      config.systemInstruction = instruction;
    }
    return { ...apiOptions, config };
  };
  return {
    models: {
      generateContent: (options: any) => ai.models.generateContent(adaptOptions(options)),
      generateContentStream: (options: any) => ai.models.generateContentStream(adaptOptions(options)),
    },
  };
}

type KeyRotationExecutionOptions = {
  /** OCR uses a bounded, vision-aware provider path; all other callers keep the standard rotation. */
  ocrMode?: boolean;
  deadlineAt?: number;
  previousProviderError?: string;
};

export async function executeWithKeyRotation<T>(
  action: (ai: GoogleGenAI, key: string, model: string) => Promise<T>,
  preferredModels: string[] = GEMINI_MODELS,
  _ignoredClientFallbackKey?: string,
  _forceGeminiFallback = false,
  executionOptions?: KeyRotationExecutionOptions
): Promise<T> {
  if (executionOptions?.ocrMode && !executionOptions.deadlineAt) {
    executionOptions = { ...executionOptions, deadlineAt: Date.now() + 75000 };
  }
  // OpenRouter is primary unless explicitly forced to use the Gemini fallback.
  if (!_forceGeminiFallback) {
    // Generic AI tasks keep their configured model rotation. OCR uses only the router first,
    // then tries Gemini on any failure instead of spending 4 sequential waits on free models.
    const models = executionOptions?.ocrMode ? ['openrouter/free'] : getOpenRouterModels();
    let lastError: any = null;
    if (!process.env.OPENROUTER_API_KEY?.trim()) {
      lastError = Object.assign(new Error('OPENROUTER_API_KEY 睾賷乇 賲囟亘賵胤.'), { status: 503, statusCode: 503 });
    }
    for (const model of (process.env.OPENROUTER_API_KEY?.trim() ? models : [])) {
      try {
        return await action(withAdaptiveAnswerLength(createOpenRouterCompatibleClient()) as unknown as GoogleGenAI, 'openrouter', model);
      } catch (error: any) {
        lastError = error;
        const status = Number(error?.status || error?.statusCode);
        const message = String(error?.message || '').toLowerCase();
        if (status === 401 || status === 403) break;
        if (status === 402 || status === 429 || /no free models|free.*(limit|unavailable|exhaust)|quota exhausted/.test(message)) {
          // A single model/provider may be out of capacity while another configured
          // fallback is still available. Try the remaining models before Gemini fallback.
          continue;
        }
        const canRetry = status === 400 || status === 401 || status === 404 || status === 408 || status === 413 || status >= 500 || /timeout|rate.?limit|quota|unavailable|model.*not found/.test(message);
        if (!canRetry && !executionOptions?.ocrMode) throw error;
      }
    }
    if (executionOptions?.ocrMode || shouldFallbackFromOpenRouter(lastError)) {
      const providerMessage = String(lastError?.message || '鬲毓匕乇 丕賱丕鬲氐丕賱 亘賲爻丕乇 OpenRouter.').slice(0, 220);
      console.warn(executionOptions?.ocrMode
        ? 'OCR OpenRouter attempt failed; switching to bounded server-side Gemini fallback.'
        : 'OpenRouter free route unavailable; retrying this operation through server-side Gemini fallback.');
      return executeWithKeyRotation(action, preferredModels, _ignoredClientFallbackKey, true, {
        ...executionOptions,
        previousProviderError: executionOptions?.ocrMode ? providerMessage : executionOptions?.previousProviderError,
      });
    }
    const status = Number(lastError?.status || lastError?.statusCode);
    if (status === 402 || status === 429) throw new Error('鬲毓匕乇 丕賱丕鬲氐丕賱 亘賳賲丕匕噩 OpenRouter 丕賱賲鬲丕丨丞 亘爻亘亘 丨丿賵丿 丕賱丕爻鬲禺丿丕賲 兀賵 賳賮丕丿 丕賱乇氐賷丿/丕賱丨氐丞. 乇丕噩毓 乇氐賷丿 OpenRouter 兀賵 噩乇賾亘 賱丕丨賯丕賸貙 賵鬲兀賰丿 賲賳 廿毓丿丕丿 賲賮鬲丕丨 Gemini 丕賱丕丨鬲賷丕胤賷 廿賳 賰賳鬲 鬲爻鬲禺丿賲賴.');
    throw lastError || new Error('鬲毓匕賾乇 丕賱丕鬲氐丕賱 亘噩賲賷毓 賳賲丕匕噩 OpenRouter 丕賱賲鬲丕丨丞.');
  }
  // Preserve the legacy function signature for compatibility, but never use a client-provided key.
  // Gemini fallback credentials are read server-side from Vercel environment variables
  // and the existing admin-managed Supabase key store.
  let availableKeys: string[];
  try {
    availableKeys = await getAvailableGeminiKeys(executionOptions?.ocrMode ? 8000 : undefined);
  } catch (keyLoadError: any) {
    if (executionOptions?.ocrMode && executionOptions.previousProviderError) {
      throw new Error(`賮卮賱 賲爻丕乇 OpenRouter 兀賵賱丕賸 (${executionOptions.previousProviderError})貙 賵鬲毓匕乇 鬲丨賲賷賱 賲賮丕鬲賷丨 Gemini 丕賱丕丨鬲賷丕胤賷丞 賲賳 丕賱禺丕丿賲: ${String(keyLoadError?.message || '禺胤兀 賮賷 丕賱丕鬲氐丕賱 亘丕賱禺丕丿賲 丕賱賲乇賰夭賷').slice(0, 180)}`);
    }
    throw keyLoadError;
  }
  const keys = availableKeys.filter((key) => !permanentlyInvalidKeys.has(key));

  if (keys.length === 0) {
    if (executionOptions?.ocrMode && executionOptions.previousProviderError) {
      throw new Error(`鬲毓匕乇 丕爻鬲禺乇丕噩 丕賱賳氐 毓亘乇 OpenRouter (${executionOptions.previousProviderError})貙 賵賱丕 賷賵噩丿 賲賮鬲丕丨 Gemini 丕丨鬲賷丕胤賷 氐丕賱丨 賮賷 廿毓丿丕丿丕鬲 丕賱禺丕丿賲.`);
    }
    throw new Error('賱賲 賷鬲賲 丕賱毓孬賵乇 毓賱賶 賲賮鬲丕丨 Gemini 氐丕賱丨 賮賷 賲鬲睾賷乇丕鬲 丕賱亘賷卅丞 兀賵 賱賵丨丞 廿丿丕乇丞 丕賱賲賮丕鬲賷丨.');
  }

  if (activeKeyIndex >= keys.length) activeKeyIndex = 0;
  // Sweep all configured keys/models once per server request. The caller may retry
  // a transient request failure, but repeating a full sweep here multiplies latency.
  // This does NOT reduce the number of distinct keys or fallback models tried.
  const MAX_ROTATION_CYCLES = 1;
  let lastError: any = null;

  for (let cycle = 0; cycle < MAX_ROTATION_CYCLES; cycle++) {
    const startIdx = activeKeyIndex;
    geminiKeyLoop: for (let offset = 0; offset < keys.length; offset++) {
      const currentKeyIndex = (startIdx + offset) % keys.length;
      const currentKey = keys[currentKeyIndex];

      for (let m = 0; m < preferredModels.length; m++) {
        if (executionOptions?.ocrMode && Date.now() >= Number(executionOptions.deadlineAt)) break geminiKeyLoop;
        const model = preferredModels[m];
        const remainingMs = executionOptions?.ocrMode
          ? Math.max(1000, Number(executionOptions.deadlineAt) - Date.now())
          : undefined;
        const attemptTimeoutMs = executionOptions?.ocrMode && remainingMs !== undefined
          ? Math.min(18000, remainingMs)
          : undefined;
        const ai = withAdaptiveAnswerLength(createGeminiClient(currentKey, attemptTimeoutMs));
        try {
          const result = await action(ai, currentKey, model);
          activeKeyIndex = currentKeyIndex;
          return result;
        } catch (err: any) {
          lastError = err;
          console.error('[Gemini key rotation] attempt failed', {
            model,
            keyIndex: currentKeyIndex + 1,
            status: Number(err?.status || err?.statusCode || err?.response?.status) || undefined,
            code: typeof err?.code === 'string' ? err.code : undefined,
            message: String(err?.message || 'Unknown Gemini error').slice(0, 300),
          });
          const kind = getGeminiErrorKind(err);
          if (kind === 'invalid') permanentlyInvalidKeys.add(currentKey);
          // A 503/high-demand response is usually model-specific and transient.
          // Try the next configured Gemini model with the same key before rotating keys.
          if (kind === 'temporary' && m < preferredModels.length - 1) continue;
          if (kind === 'quota' || kind === 'temporary' || kind === 'invalid') {
            activeKeyIndex = keys.length > 1 ? (currentKeyIndex + 1) % keys.length : currentKeyIndex;
            break;
          }
          const msg = String(err?.message || '').toLowerCase();
          const isModelUnavailable = err?.status === 404 || err?.status === 'NOT_FOUND' ||
            /not found|no longer available|model not found|unsupported model/.test(msg);
          if (isModelUnavailable && m < preferredModels.length - 1) continue;
          if (keys.length > 1) {
            activeKeyIndex = (currentKeyIndex + 1) % keys.length;
            break;
          }
        }
      }
    }
    if (cycle < MAX_ROTATION_CYCLES - 1) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  const finalKind = getGeminiErrorKind(lastError);
  if (executionOptions?.ocrMode && executionOptions.previousProviderError) {
    if (finalKind === 'quota') throw new Error('賮卮賱 OCR 毓亘乇 OpenRouter 孬賲 鬲毓匕乇 Gemini 亘爻亘亘 亘賱賵睾 丨丿賵丿 丕賱丕爻鬲禺丿丕賲. 鬲丨賯賯 賲賳 乇氐賷丿/丨氐丞 丕賱賲夭賵丿賷賳 賵噩乇亘 賱丕丨賯賸丕.');
    if (finalKind === 'temporary') throw new Error('賮卮賱 OCR 毓亘乇 OpenRouter 孬賲 丕賳鬲賴鬲 賲賴賱丞/鬲毓匕乇 丕鬲氐丕賱 Gemini. 噩乇賾亘 氐賵乇丞 賵丕丨丿丞貨 賵廿匕丕 鬲賰乇乇 丕賱禺胤兀 乇丕噩毓 爻噩賱 /api/ocr.');
    throw new Error(`賮卮賱 丕爻鬲禺乇丕噩 丕賱賳氐: 鬲毓胤賱 OpenRouter (${executionOptions.previousProviderError}) 孬賲 鬲毓匕乇 Gemini (${String(lastError?.message || '賱賲 鬲購乇噩毓 丕賱禺丿賲丞 賳鬲賷噩丞 氐丕賱丨丞').slice(0, 180)}).`);
  }
  if (finalKind === 'quota') throw new Error('鬲毓匕賾乇 鬲賳賮賷匕 丕賱胤賱亘: 丨氐氐 賲賮丕鬲賷丨 Gemini 丕賱賲鬲丕丨丞 賲爻鬲賳賮丿丞 兀賵 鬲賲 亘賱賵睾 丨丿 丕賱丕爻鬲禺丿丕賲. 丕賳鬲馗乇 鬲噩丿丿 丕賱丨氐丞 兀賵 兀囟賮 賲賮鬲丕丨賸丕 賲鬲丕丨賸丕.');
  if (finalKind === 'temporary') throw new Error('禺丿賲丞 Gemini 賲卮睾賵賱丞 賲丐賯鬲賸丕 兀賵 鬲兀禺乇 丕賱丕鬲氐丕賱. 噩乇賾亘 賲乇丞 兀禺乇賶 亘毓丿 賯賱賷賱.');
  if (keys.every((key) => permanentlyInvalidKeys.has(key))) throw new Error('賲賮丕鬲賷丨 Gemini 丕賱賲鬲丕丨丞 睾賷乇 氐丕賱丨丞. 丨丿賾孬 丕賱賲賮丕鬲賷丨 賲賳 賱賵丨丞 丕賱廿丿丕乇丞.');
  throw lastError || new Error('賮卮賱鬲 噩賲賷毓 賲丨丕賵賱丕鬲 丕賱鬲丿賵賷乇.');
}


export async function executeWithKeyRotationStream( action: (ai: GoogleGenAI, key: string, model: string) => Promise<AsyncIterable<any>>, onChunk: (text: string) => void, preferredModels: string[] = GEMINI_MODELS, _ignoredClientFallbackKey?: string, _forceGeminiFallback = false ): Promise<void> {
  if (!_forceGeminiFallback) {
    const models = getOpenRouterModels();
    let lastError: any = null;
    if (!process.env.OPENROUTER_API_KEY?.trim()) {
      lastError = Object.assign(new Error('OPENROUTER_API_KEY 睾賷乇 賲囟亘賵胤.'), { status: 503, statusCode: 503 });
    }
    for (const model of (process.env.OPENROUTER_API_KEY?.trim() ? models : [])) {
      let emitted = false;
      try {
        const stream = await action(withAdaptiveAnswerLength(createOpenRouterCompatibleClient()) as unknown as GoogleGenAI, 'openrouter', model);
        for await (const chunk of stream) {
          const chunkText = typeof chunk?.text === 'string' ? chunk.text : '';
          if (chunkText) { emitted = true; onChunk(chunkText); }
        }
        return;
      } catch (error: any) {
        lastError = error;
        // Never restart on another model after visible output, as that duplicates or corrupts legal text.
        if (emitted) throw error;
        const status = Number(error?.status || error?.statusCode);
        const message = String(error?.message || '').toLowerCase();
        if (status === 401 || status === 403) break;
        if (status === 402 || status === 429 || /no free models|free.*(limit|unavailable|exhaust)|quota exhausted/.test(message)) {
          // Keep trying remaining configured models before using the Gemini fallback.
          continue;
        }
        const canRetry = status === 400 || status === 401 || status === 404 || status === 408 || status === 413 || status >= 500 || /timeout|rate.?limit|quota|unavailable|model.*not found/.test(message);
        if (!canRetry) throw error;
      }
    }
    if (shouldFallbackFromOpenRouter(lastError)) {
      console.warn('OpenRouter free route unavailable before stream output; retrying through server-side Gemini fallback.');
      return executeWithKeyRotationStream(action, onChunk, preferredModels, _ignoredClientFallbackKey, true);
    }
    const status = Number(lastError?.status || lastError?.statusCode);
    if (status === 402 || status === 429) throw new Error('鬲毓匕乇 丕賱丕鬲氐丕賱 亘賳賲丕匕噩 OpenRouter 丕賱賲鬲丕丨丞 亘爻亘亘 丨丿賵丿 丕賱丕爻鬲禺丿丕賲 兀賵 賳賮丕丿 丕賱乇氐賷丿/丕賱丨氐丞. 乇丕噩毓 乇氐賷丿 OpenRouter 兀賵 噩乇賾亘 賱丕丨賯丕賸貙 賵鬲兀賰丿 賲賳 廿毓丿丕丿 賲賮鬲丕丨 Gemini 丕賱丕丨鬲賷丕胤賷 廿賳 賰賳鬲 鬲爻鬲禺丿賲賴.');
    throw lastError || new Error('鬲毓匕賾乇 丕賱丕鬲氐丕賱 亘噩賲賷毓 賳賲丕匕噩 OpenRouter 丕賱賲鬲丕丨丞.');
  }
  // Preserve the legacy function signature for compatibility, but never use a client-provided key.
  // Streaming fallback also uses server-side environment and admin-managed keys.
  const keys = (await getAvailableGeminiKeys()).filter((key) => !permanentlyInvalidKeys.has(key));

  if (keys.length === 0) {
    throw new Error('賱賲 賷鬲賲 丕賱毓孬賵乇 毓賱賶 賲賮鬲丕丨 Gemini 氐丕賱丨 賮賷 賲鬲睾賷乇丕鬲 丕賱亘賷卅丞 兀賵 賱賵丨丞 廿丿丕乇丞 丕賱賲賮丕鬲賷丨.');
  }

  if (activeKeyIndex >= keys.length) activeKeyIndex = 0;
  // Sweep all configured keys/models once per server request. The caller may retry
  // a transient request failure, but repeating a full sweep here multiplies latency.
  // This does NOT reduce the number of distinct keys or fallback models tried.
  const MAX_ROTATION_CYCLES = 1;
  let lastError: any = null;

  for (let cycle = 0; cycle < MAX_ROTATION_CYCLES; cycle++) {
    const startIdx = activeKeyIndex;

    for (let offset = 0; offset < keys.length; offset++) {
      const currentKeyIndex = (startIdx + offset) % keys.length;
      const currentKey = keys[currentKeyIndex];
      const ai = withAdaptiveAnswerLength(createGeminiClient(currentKey));

      for (let m = 0; m < preferredModels.length; m++) {
        let emittedAnyChunk = false;
        try {
          const stream = await action(ai, currentKey, preferredModels[m]);
          for await (const chunk of stream) {
            const text = typeof chunk?.text === 'string' ? chunk.text : '';
            if (text) {
              emittedAnyChunk = true;
              onChunk(text);
            }
          }
          activeKeyIndex = currentKeyIndex;
          return;
        } catch (err: any) {
          lastError = err;
          console.error('[Gemini stream key rotation] attempt failed', {
            model: preferredModels[m],
            keyIndex: currentKeyIndex + 1,
            emittedAnyChunk,
            status: Number(err?.status || err?.statusCode || err?.response?.status) || undefined,
            code: typeof err?.code === 'string' ? err.code : undefined,
            message: String(err?.message || 'Unknown Gemini stream error').slice(0, 300),
          });

          // Once Gemini has started streaming, the response may already be visible
          // to the user, so do not silently restart and duplicate the answer.
          if (emittedAnyChunk) {
            throw err;
          }

          const kind = getGeminiErrorKind(err);
          if (kind === 'invalid') permanentlyInvalidKeys.add(currentKey);
          // If Gemini is overloaded (503/504), try another model before moving
          // to another key. Never restart after visible output (handled above).
          if (kind === 'temporary' && m < preferredModels.length - 1) continue;
          if (kind === 'quota' || kind === 'temporary' || kind === 'invalid') {
            activeKeyIndex = keys.length > 1 ? (currentKeyIndex + 1) % keys.length : currentKeyIndex;
            break;
          }
          const msg = String(err?.message || '').toLowerCase();
          const isModelUnavailable = err?.status === 404 || err?.status === 'NOT_FOUND' ||
            /not found|no longer available|model not found|unsupported model/.test(msg);
          if (isModelUnavailable && m < preferredModels.length - 1) continue;
          if (keys.length > 1) {
            activeKeyIndex = (currentKeyIndex + 1) % keys.length;
            break;
          }
        }
      }
    }

    if (cycle < MAX_ROTATION_CYCLES - 1) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  const finalKind = getGeminiErrorKind(lastError);
  if (finalKind === 'quota') throw new Error('鬲毓匕賾乇 鬲賳賮賷匕 丕賱胤賱亘: 丨氐氐 賲賮丕鬲賷丨 Gemini 丕賱賲鬲丕丨丞 賲爻鬲賳賮丿丞 兀賵 鬲賲 亘賱賵睾 丨丿 丕賱丕爻鬲禺丿丕賲. 丕賳鬲馗乇 鬲噩丿丿 丕賱丨氐丞 兀賵 兀囟賮 賲賮鬲丕丨賸丕 賲鬲丕丨賸丕.');
  if (finalKind === 'temporary') throw new Error('禺丿賲丞 Gemini 賲卮睾賵賱丞 賲丐賯鬲賸丕 兀賵 鬲兀禺乇 丕賱丕鬲氐丕賱. 噩乇賾亘 賲乇丞 兀禺乇賶 亘毓丿 賯賱賷賱.');
  if (keys.every((key) => permanentlyInvalidKeys.has(key))) throw new Error('賲賮丕鬲賷丨 Gemini 丕賱賲鬲丕丨丞 睾賷乇 氐丕賱丨丞. 丨丿賾孬 丕賱賲賮丕鬲賷丨 賲賳 賱賵丨丞 丕賱廿丿丕乇丞.');
  throw lastError || new Error('賮卮賱鬲 噩賲賷毓 賲丨丕賵賱丕鬲 丕賱鬲丿賵賷乇.');
}

export default function handler(req: any, res: any) {
  return res.status(200).json({ ok: true, activeKeys: getKeysStatus().totalCount });
}
