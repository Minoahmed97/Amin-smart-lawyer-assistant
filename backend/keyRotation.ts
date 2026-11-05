import { GoogleGenAI } from '@google/genai';
import { sanitizeGeminiKey } from './centralKeys.ts';
import fs from 'fs';
import path from 'path';
import { createOpenRouterCompatibleClient, getOpenRouterModels } from './openrouterAdapter.ts';
import { fetchServerCloudGeminiKeys, fetchServerCloudOCRGeminiKeys, fetchServerCloudOCRGroqFallbackConfig } from './supabaseSync.ts';

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
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
];

let activeKeyIndex = 0;
const permanentlyInvalidKeys = new Set<string>();
const permanentlyInvalidOCRKeys = new Set<string>();
const keyCooldownUntil = new Map<string, number>();
const keyModelCooldownUntil = new Map<string, number>();
const modelCooldownUntil = new Map<string, number>();
const ocrKeyCooldownUntil = new Map<string, number>();
const ocrKeyModelCooldownUntil = new Map<string, number>();
const ocrModelCooldownUntil = new Map<string, number>();
let nextGeneralKeyStart = 0;
let nextOCRKeyStart = 0;
const KEY_QUOTA_COOLDOWN_MS = 60_000;
const MODEL_BUSY_COOLDOWN_MS = 30_000;
const CONNECTION_COOLDOWN_MS = 12_000;
const MODEL_PAIR_COOLDOWN_MS = 15_000;
const MAX_MODELS_PER_KEY_PER_REQUEST = 2;

function rotationPairKey(key: string, model: string): string {
  return `${key}:${model}`;
}

function isCooling(map: Map<string, number>, id: string, now = Date.now()): boolean {
  const until = map.get(id) || 0;
  if (until <= now) {
    if (until) map.delete(id);
    return false;
  }
  return true;
}

function markRotationFailure(key: string, model: string, error: any, pool: 'general' | 'ocr' = 'general'): 'quota' | 'invalid' | 'temporary' | 'other' {
  const keyCooldowns = pool === 'ocr' ? ocrKeyCooldownUntil : keyCooldownUntil;
  const pairCooldowns = pool === 'ocr' ? ocrKeyModelCooldownUntil : keyModelCooldownUntil;
  const invalidKeys = pool === 'ocr' ? permanentlyInvalidOCRKeys : permanentlyInvalidKeys;
  const kind = getGeminiErrorKind(error);
  const status = Number(error?.status || error?.statusCode || error?.response?.status);
  const pair = rotationPairKey(key, model);
  const message = String(error?.message || '').toLowerCase();
  const now = Date.now();
  if (kind === 'invalid') {
    invalidKeys.add(key);
    keyCooldowns.set(key, Number.MAX_SAFE_INTEGER);
  } else if (kind === 'quota' || status === 429) {
    if (pool === 'ocr') keyCooldowns.set(key, now + KEY_QUOTA_COOLDOWN_MS);
    pairCooldowns.set(pair, now + KEY_QUOTA_COOLDOWN_MS);
  } else if (status === 503 || /high demand|service unavailable|temporarily unavailable/.test(message)) {
    pairCooldowns.set(pair, now + MODEL_BUSY_COOLDOWN_MS);
  } else if (kind === 'temporary' || status === 408 || status === 504 || /network|fetch failed|connection|socket|econn|timed out|timeout|aborted/.test(message)) {
    pairCooldowns.set(pair, now + (status === 504 || /timeout|timed out|network|connection|socket|econn|fetch failed/.test(message) ? CONNECTION_COOLDOWN_MS : MODEL_PAIR_COOLDOWN_MS));
  }
  return kind;
}

function reserveStartIndex(count: number, pool: 'general' | 'ocr'): number {
  if (count <= 0) return 0;
  if (pool === 'ocr') {
    const start = nextOCRKeyStart % count;
    nextOCRKeyStart = (start + 1) % count;
    return start;
  }
  const start = nextGeneralKeyStart % count;
  nextGeneralKeyStart = (start + 1) % count;
  return start;
}

function selectModelsForKey( models: string[], key: string, pool: 'general' | 'ocr' = 'general', now = Date.now(), avoidPairs?: Set<string>, ): string[] {
  const pairCooldowns = pool === 'ocr' ? ocrKeyModelCooldownUntil : keyModelCooldownUntil;
  const modelCooldowns = pool === 'ocr' ? ocrModelCooldownUntil : modelCooldownUntil;
  const available = models.filter((model) =>
    !isCooling(modelCooldowns, model, now) &&
    !isCooling(pairCooldowns, rotationPairKey(key, model), now) &&
    !avoidPairs?.has(`${key}::${model}`)
  );
  return available.slice(0, MAX_MODELS_PER_KEY_PER_REQUEST);
}

function createGeminiClient(apiKey: string, timeoutMs?: number): GoogleGenAI {
  const httpOptions: any = { headers: { 'User-Agent': 'aistudio-build' } };
  if (Number.isFinite(timeoutMs) && Number(timeoutMs) >= 1000) {
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
  return status === 401 || status === 402 || status === 403 || status === 404 || status === 408 || status === 413 || status === 429 || status >= 500 ||
    (status === 400 && /max_tokens|context.?length|model|unsupported|parameter/.test(message)) ||
    /quota|rate.?limit|free.*(limit|unavailable|exhaust)|no free models|temporarily unavailable|service unavailable|timed out|timeout/.test(message);
}

const KEYS_FILE = path.join(process.cwd(), '.keys_config.json');
let inMemoryDynamicKeys: string[] = [];

export function getFileStoredKeys(): string[] {
  if (process.env.NODE_ENV === 'production') return [];
  try {
    if (fs.existsSync(KEYS_FILE)) {
      const data = fs.readFileSync(KEYS_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        return parsed.filter((k) => isValidGeminiApiKey(k));
      }
    }
  } catch (e) {}
  return inMemoryDynamicKeys;
}

export function saveFileStoredKeys(keys: string[]): void {
  inMemoryDynamicKeys = keys.filter((k) => isValidGeminiApiKey(k));
  try {
    fs.writeFileSync(KEYS_FILE, JSON.stringify(inMemoryDynamicKeys, null, 2), 'utf-8');
  } catch (e) {
    console.warn('鬲丨匕賷乇 兀孬賳丕亍 丨賮馗 鬲賰賵賷賳 丕賱賲賮丕鬲賷丨 毓賱賶 丕賱賯乇氐:', e);
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
      message: '賲賮鬲丕丨 Gemini 睾賷乇 氐丕賱丨. 丕賳爻禺 丕賱賲賮鬲丕丨 賰丕賲賱丕賸 賲賳 賲賳氐丞 Google AI Studio 賵兀丿禺賱賴 賰賲丕 賴賵.',
    };
  }

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
          message: `丕賱賲賮鬲丕丨 氐丕賱丨 賵賷賲賰賳賴 丕賱賵氐賵賱 廿賱賶 丕賱賳賲賵匕噩 ${model}.`,
        };
      }

      const status = Number(data?.error?.code || response.status);
      const apiMessage = String(data?.error?.message || '').trim();
      lastFailure = `賮卮賱 賮丨氐 ${model} (${status})${apiMessage ? `: ${apiMessage.slice(0, 240)}` : '.'}`;

      const errorText = `${data?.error?.status || ''} ${apiMessage}`;
      if (status === 401 || /api key not valid|invalid api key|api_key_invalid|key.*(invalid|revoked|deleted)|credential.*invalid/i.test(errorText)) {
        return { success: false, message: `兀賰丿鬲 Google 兀賳 賲賮鬲丕丨 Gemini 睾賷乇 氐丕賱丨 兀賵 賲賱睾賶 (${status}).` };
      }

      if (status === 403 || status === 404 || status === 400) continue;
      if (status === 429) {
        return { success: false, message: `乇賮囟 胤賱亘 賮丨氐 亘賷丕賳丕鬲 丕賱賳賲賵匕噩 亘爻亘亘 丨丿 胤賱亘丕鬲 賵丕噩賴丞 丕賱亘乇賲噩丞 (${status}).` };
      }
    } catch (err: any) {
      lastFailure = controller.signal.aborted ? `丕賳鬲賴鬲 賲賴賱丞 賮丨氐 ${model}.` : `鬲毓匕乇 丕賱丕鬲氐丕賱 亘賭 Gemini 毓亘乇 ${model}.`;
      if (controller.signal.aborted) break;
    } finally {
      clearTimeout(timeout);
    }
  }

  return { success: false, message: lastFailure || '鬲毓匕乇 丕賱鬲丨賯賯 賲賳 賲賮鬲丕丨 Gemini 兀賵 丕賱賵氐賵賱 廿賱賶 兀賷 賳賲賵匕噩 賲鬲丕丨.' };
}

let dedicatedOCRActiveKey = '';

export async function checkDedicatedOCRGeminiReadiness(totalTimeoutMs = 9000): Promise<{ ready: boolean; keyCount: number; checkedKeys: number; message: string }> {
  let keys: string[];
  try {
    keys = await fetchServerCloudOCRGeminiKeys(Math.min(5000, totalTimeoutMs));
  } catch (error: any) {
    return { ready: false, keyCount: 0, checkedKeys: 0, message: error?.message || '鬲毓匕乇 賯乇丕亍丞 賲噩賲賵毓丞 賲賮丕鬲賷丨 丕賱氐賵乇 賵丕賱賲爻鬲賳丿丕鬲.' };
  }
  if (!keys.length) {
    return { ready: false, keyCount: 0, checkedKeys: 0, message: '賱丕 鬲賵噩丿 賲賮丕鬲賷丨 賲禺氐氐丞 賱賱氐賵乇 賵丕賱賲爻鬲賳丿丕鬲 賵丕賱禺丕氐丞 (OCR).' };
  }

  const deadlineAt = Date.now() + Math.max(1000, totalTimeoutMs);
  let checkedKeys = 0;
  let lastFailure = '';
  for (const key of keys) {
    const remaining = deadlineAt - Date.now();
    if (remaining < 700) break;
    checkedKeys++;
    const result = await testGeminiKey(key, Math.min(2200, remaining));
    if (result.success) {
      return { ready: true, keyCount: keys.length, checkedKeys, message: `賲噩賲賵毓丞 OCR 噩丕賴夭丞 (${keys.length} 賲賮鬲丕丨 賲爻噩賱).` };
    }
    lastFailure = result.message || '';
    if (Date.now() >= deadlineAt) break;
  }
  return { ready: false, keyCount: keys.length, checkedKeys, message: `鬲賵噩丿 ${keys.length} 賲賮丕鬲賷丨 賮賷 賲噩賲賵毓丞 OCR貙 賱賰賳 鬲毓匕乇 丕賱鬲丨賯賯 賲賳 賵氐賵賱 兀賷 賳賲賵匕噩. 丌禺乇 賳鬲賷噩丞: ${lastFailure}` };
}

/** * 丿丕賱丞 丕爻鬲禺乇丕噩 丕賱賳氐 丕賱禺丕氐丞 亘賭 Groq 丕賱丕丨鬲賷丕胤賷 丕賱賲亘丕卮乇 (丕賱賲噩丕賳賷) 毓賳丿賲丕 鬲賮卮賱 賲丨丕賵賱丕鬲 Gemini */
async function executeGroqOCRFallback(action: (ai: GoogleGenAI, key: string, model: string) => Promise<any>, deadlineAt = Date.now() + 90000): Promise<any> {
  const fallbackConfig = await fetchServerCloudOCRGroqFallbackConfig();
  if (!fallbackConfig.enabled || !fallbackConfig.apiKey) {
    throw new Error('丕丨鬲賷丕胤賷 Groq 賱賭 OCR 睾賷乇 賲賮毓賱 兀賵 賱賲 賷鬲賲 丨賮馗 賲賮鬲丕丨賴.');
  }

  console.log('馃攧 噩丕乇賷 鬲卮睾賷賱 亘丿賷賱 Groq 丕賱賲亘丕卮乇 賱賭 OCR...');
  
  const remainingMs = Math.max(1000, deadlineAt - Date.now());
  
  // 丕賱丕鬲氐丕賱 丕賱賲亘丕卮乇 亘禺賵丕丿賲 Groq 賱賲賳毓 兀禺胤丕亍 丕賱賭 402 丕賱禺丕氐丞 亘賭 OpenRouter
  const client = createOpenRouterCompatibleClient(
    Math.min(60000, remainingMs), 
    deadlineAt, 
    'https://api.groq.com/openai/v1', 
    fallbackConfig.apiKey
  );
  
  const modelToUse = fallbackConfig.model || 'meta-llama/llama-3.2-11b-vision-preview';
  
  return await action(client as unknown as GoogleGenAI, fallbackConfig.apiKey, modelToUse);
}

/** 鬲丿賵賷乇 OCR 丕賱賲賰孬賮 毓亘乇 賲賮丕鬲賷丨 Gemini 兀賵賱丕賸貙 賵毓賳丿 賮卮賱賴丕 賷鬲賲 丕賱丕賳鬲賯丕賱 丕賱鬲賱賯丕卅賷 賱賭 Groq 丕賱賲亘丕卮乇 */
export async function executeWithDedicatedOCRKeyRotation<T>(
  action: (ai: GoogleGenAI, key: string, model: string) => Promise<T>,
  preferredModels: string[] = GEMINI_MODELS,
  timeoutMs = 240000,
): Promise<T> {
  const deadlineAt = Date.now() + Math.max(15000, timeoutMs);
  let keys: string[] = [];
  try {
    keys = await fetchServerCloudOCRGeminiKeys(Math.min(8000, Math.max(1000, deadlineAt - Date.now() - 2000)));
  } catch (error: any) {
    console.warn('鬲毓匕乇 噩賱亘 賲賮丕鬲賷丨 OCR 賲賳 Supabase:', error?.message);
  }

  let lastError: any = null;
  const overallStart = Date.now();
  const totalBudget = Math.max(0, deadlineAt - overallStart);

  for (let round = 0; round < 2; round++) {
    const roundStart = overallStart + Math.floor(totalBudget * round / 2);
    const roundEnd = overallStart + Math.floor(totalBudget * (round + 1) / 2);
    const geminiDeadlineAt = roundStart + Math.floor((roundEnd - roundStart) * 0.55);
    if (round > 0) await new Promise((r) => setTimeout(r, 1000));

    if (keys.length > 0) {
      const usableOCRKeys = keys.filter((candidate) => !permanentlyInvalidOCRKeys.has(candidate));
      const rememberedKeyIndex = dedicatedOCRActiveKey ? usableOCRKeys.indexOf(dedicatedOCRActiveKey) : -1;
      const startIndex = rememberedKeyIndex >= 0 &&
        !isCooling(ocrKeyCooldownUntil, dedicatedOCRActiveKey) &&
        !permanentlyInvalidOCRKeys.has(dedicatedOCRActiveKey)
          ? rememberedKeyIndex
          : (usableOCRKeys.length ? reserveStartIndex(usableOCRKeys.length, 'ocr') : 0);

      ocrKeyLoop: for (let offset = 0; offset < usableOCRKeys.length; offset++) {
        const keyIndex = (startIndex + offset) % usableOCRKeys.length;
        const key = usableOCRKeys[keyIndex];
        if (isCooling(ocrKeyCooldownUntil, key) || permanentlyInvalidOCRKeys.has(key)) continue;
        const keyModels = selectModelsForKey(preferredModels, key, 'ocr');

        for (let modelIndex = 0; modelIndex < keyModels.length; modelIndex++) {
          const remainingMs = geminiDeadlineAt - Date.now();
          if (remainingMs < 10000) break ocrKeyLoop;
          const model = keyModels[modelIndex];
          try {
            const ai = withAdaptiveAnswerLength(createGeminiClient(key, Math.min(18000, remainingMs)));
            const result = await action(ai, key, model);
            if (Date.now() >= geminiDeadlineAt) throw Object.assign(new Error('丕賳鬲賴鬲 賲賴賱丞 賲丨丕賵賱丞 OCR 毓亘乇 Gemini.'), { status: 504, statusCode: 504 });
            dedicatedOCRActiveKey = key;
            return result;
          } catch (error: any) {
            lastError = error;
            markRotationFailure(key, model, error, 'ocr');
          }
        }
      }
    }

    console.warn(`鈿狅笍 賮卮賱鬲 賲丨丕賵賱丕鬲 Gemini 賱賭 OCR 賮賷 丕賱噩賵賱丞 ${round + 1}. 噩丕乇賷 鬲噩乇亘丞 Groq 丕賱賲亘丕卮乇 丕賱丕丨鬲賷丕胤賷...`);
    try {
      if (roundEnd - Date.now() < 10000) {
        lastError = lastError || new Error('賱賲 賷鬲亘賯 賵賯鬲 賰丕賮 賱鬲噩乇亘丞 Groq 賮賷 賴匕賴 丕賱噩賵賱丞.');
        continue;
      }
      const groqResult = await executeGroqOCRFallback(action, roundEnd);
      if (groqResult) {
        console.log(`鉁� 鬲賲 廿鬲賲丕賲 丕爻鬲禺乇丕噩 丕賱賳氐 亘賳噩丕丨 毓亘乇 Groq 丕賱賲亘丕卮乇 賮賷 丕賱噩賵賱丞 ${round + 1}!`);
        return groqResult;
      }
      lastError = new Error('兀毓丕丿 Groq 賳鬲賷噩丞 賮丕乇睾丞 賱丕爻鬲禺乇丕噩 丕賱賳氐.');
    } catch (groqError: any) {
      lastError = groqError;
      console.error(`鉂� 賮卮賱 Groq 丕賱賲亘丕卮乇 賮賷 丕賱噩賵賱丞 ${round + 1}:`, groqError?.message);
    }

    if (Date.now() >= deadlineAt || deadlineAt - Date.now() < 10000) break;
  }

  const finalError: any = new Error(`賮卮賱鬲 賲丨丕賵賱鬲丕賳 賰丕賲賱鬲丕賳 賱丕爻鬲禺乇丕噩 丕賱賳氐: Gemini 亘賲賮丕鬲賷丨 賵賳賲丕匕噩 孬賲 Groq. ${String(lastError?.message || '')}`);
  finalError.status = lastError?.status || lastError?.statusCode || 503;
  finalError.statusCode = finalError.status;
  finalError.cause = lastError;
  throw finalError;
}

export function getVercelGeminiKeys(): string[] {
  const keys: string[] = [];
  const addKey = (k: any) => {
    if (!k || typeof k !== 'string') return;
    for (const part of k.split(/[\n,;]+/)) {
      const clean = sanitizeGeminiKey(part.trim());
      if (isValidGeminiApiKey(clean) && !keys.includes(clean)) keys.push(clean);
    }
  };

  for (let i = 1; i <= 50; i++) {
    addKey(process.env[`GEMINI_API_KEY_${i}`]);
    addKey(process.env[`GEMINI_KEY_${i}`]);
  }
  addKey(process.env.GEMINI_API_KEYS);
  addKey(process.env.GEMINI_API_KEY);
  addKey(process.env.GOOGLE_GENAI_API_KEY);
  addKey(process.env.GOOGLE_API_KEY);

  for (const storedKey of getFileStoredKeys()) addKey(storedKey);

  return keys;
}

async function getAvailableGeminiKeys(timeoutMs?: number): Promise<string[]> {
  const keys = getVercelGeminiKeys();
  try {
    for (const key of await fetchServerCloudGeminiKeys(timeoutMs)) {
      if (isValidGeminiApiKey(key) && !keys.includes(key)) keys.push(key);
    }
  } catch (error) {
    if (keys.length === 0) throw error;
  }
  return keys;
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
    name: idx === 0 ? '丕賱賲賮鬲丕丨 丕賱乇卅賷爻賷' : `賲賮鬲丕丨 丕賱鬲丿賵賷乇 (${idx + 1})`,
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

function withAdaptiveAnswerLength(ai: any): any {
  const instruction = '丕禺鬲乇 胤賵賱 丕賱廿噩丕亘丞 賵賮賯丕賸 賱胤亘賷毓丞 丕賱胤賱亘 賵鬲毓賯賷丿賴貨 賱丕 鬲賱鬲夭賲 亘毓丿丿 賰賱賲丕鬲 孬丕亘鬲 賵賱丕 鬲禺鬲氐乇 賱賲噩乇丿 丕賱丕禺鬲氐丕乇.';
  const adaptOptions = (options: any) => {
    const { skipAdaptiveAnswerLength, ...apiOptions } = options || {};
    if (skipAdaptiveAnswerLength === true) return apiOptions;
    const config = { ...(apiOptions?.config || {}) };
    const current = config.systemInstruction;
    if (typeof current === 'string' && current.trim()) {
      config.systemInstruction = `${current}\n\n${instruction}`;
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
  ocrMode?: boolean;
  deadlineAt?: number;
  previousProviderError?: string;
  providerAttempt?: 'gemini-primary' | 'openrouter-fallback';
  /** Previously used key/model pairs are avoided first during continuation. */
  avoidPairs?: string[];
};

export async function executeWithKeyRotation<T>(
  action: (ai: GoogleGenAI, key: string, model: string) => Promise<T>,
  preferredModels: string[] = GEMINI_MODELS,
  _ignoredClientFallbackKey?: string,
  _forceGeminiFallback = false,
  executionOptions?: KeyRotationExecutionOptions
): Promise<T> {
  if (!executionOptions?.deadlineAt) {
    executionOptions = { ...executionOptions, deadlineAt: Date.now() + (executionOptions?.ocrMode ? 240000 : 270000) };
  }
  const deadlineAt = Number(executionOptions.deadlineAt);
  const timeoutError = () => Object.assign(
    new Error('丕賳鬲賴鬲 丕賱賲賴賱丞 丕賱賲鬲丕丨丞 賱鬲賵賱賷丿 丕賱賳鬲賷噩丞 賯亘賱 丕賰鬲賲丕賱賴丕.'),
    { status: 504, statusCode: 504 },
  );

  if (!_forceGeminiFallback && !executionOptions?.ocrMode && !executionOptions?.providerAttempt) {
    const overallStart = Date.now();
    const totalBudget = Math.max(0, deadlineAt - overallStart);
    let lastProviderError: any = null;

    for (let round = 0; round < 2; round++) {
      const roundStart = overallStart + Math.floor(totalBudget * round / 2);
      const roundEnd = overallStart + Math.floor(totalBudget * (round + 1) / 2);
      const geminiDeadlineAt = roundStart + Math.floor((roundEnd - roundStart) * 0.55);
      if (deadlineAt - Date.now() < 10000) break;
      try {
        return await executeWithKeyRotation(action, preferredModels, _ignoredClientFallbackKey, true, {
          ...executionOptions,
          deadlineAt: geminiDeadlineAt,
          providerAttempt: 'gemini-primary',
        });
      } catch (geminiError: any) {
        lastProviderError = geminiError;
      }
      if (roundEnd - Date.now() < 10000) break;
      try {
        return await executeWithKeyRotation(action, preferredModels, _ignoredClientFallbackKey, false, {
          ...executionOptions,
          deadlineAt: roundEnd,
          providerAttempt: 'openrouter-fallback',
          previousProviderError: String(lastProviderError?.message || '鬲毓匕乇 丕爻鬲禺丿丕賲 Gemini.'),
        });
      } catch (openRouterError: any) {
        lastProviderError = openRouterError;
      }
    }
    const combined: any = new Error('鬲毓匕乇 鬲賳賮賷匕 丕賱胤賱亘 亘毓丿 賲丨丕賵賱鬲賷賳 賰丕賲賱鬲賷賳: Gemini 兀賵賱丕賸 孬賲 OpenRouter 賮賷 賰賱 賲丨丕賵賱丞.');
    combined.status = 503;
    combined.statusCode = 503;
    combined.cause = lastProviderError;
    throw combined;
  }

  if (!_forceGeminiFallback) {
    const availableModels = executionOptions?.ocrMode ? ['openrouter/free'] : getOpenRouterModels();
    const avoidedPairs = new Set(executionOptions?.avoidPairs || []);
    const preferredModelsForAttempt = availableModels.filter((model) => !avoidedPairs.has(`openrouter::${model}`));
    const models = preferredModelsForAttempt.length ? preferredModelsForAttempt : availableModels;
    let lastError: any = null;
    if (!process.env.OPENROUTER_API_KEY?.trim()) {
      lastError = Object.assign(new Error('賲賮鬲丕丨 OpenRouter 睾賷乇 賲囟亘賵胤.'), { status: 503, statusCode: 503 });
    }
    for (const model of (process.env.OPENROUTER_API_KEY?.trim() ? models : [])) {
      try {
        const result = await action(
          withAdaptiveAnswerLength(createOpenRouterCompatibleClient(12000, deadlineAt)) as unknown as GoogleGenAI,
          'openrouter',
          model,
        );
        if (Date.now() >= deadlineAt) throw timeoutError();
        return result;
      } catch (error: any) {
        lastError = error;
      }
    }
    if ((executionOptions?.ocrMode || shouldFallbackFromOpenRouter(lastError)) && executionOptions?.providerAttempt !== 'openrouter-fallback') {
      if (deadlineAt - Date.now() < 10000) throw timeoutError();
      return executeWithKeyRotation(action, preferredModels, _ignoredClientFallbackKey, true, executionOptions);
    }
    throw lastError || new Error('鬲毓匕乇 丕賱丕鬲氐丕賱 亘賳賳賲丕匕噩 OpenRouter.');
  }

  const keys = (await getAvailableGeminiKeys()).filter((key) => !permanentlyInvalidKeys.has(key));
  if (keys.length === 0) {
    throw new Error('賱賲 賷鬲賲 丕賱毓孬賵乇 毓賱賶 賲賮鬲丕丨 Gemini 氐丕賱丨 賮賷 廿毓丿丕丿丕鬲 丕賱禺丕丿賲.');
  }

  if (activeKeyIndex >= keys.length) activeKeyIndex = 0;

  const MAX_ROTATION_CYCLES = 1;
  let lastError: any = null;
  let attemptedModelCount = 0;
  const avoidedPairs = new Set(executionOptions?.avoidPairs || []);
  const keyFailureKinds = new Map<string, string>();

  for (let cycle = 0; cycle < MAX_ROTATION_CYCLES; cycle++) {
    if (cycle > 0) {
      await new Promise((r) => setTimeout(r, 2000));
    }

    const startIdx = reserveStartIndex(keys.length, 'general');
    geminiKeyLoop: for (let offset = 0; offset < keys.length; offset++) {
      const currentKeyIndex = (startIdx + offset) % keys.length;
      const currentKey = keys[currentKeyIndex];
      if (isCooling(keyCooldownUntil, currentKey) || permanentlyInvalidKeys.has(currentKey)) continue;
      const keyModels = selectModelsForKey(preferredModels, currentKey, 'general', Date.now(), avoidedPairs);

      for (let m = 0; m < keyModels.length; m++) {
        attemptedModelCount += 1;
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs < 10000) {
          lastError = timeoutError();
          break geminiKeyLoop;
        }
        const model = keyModels[m];
        const ai = withAdaptiveAnswerLength(createGeminiClient(currentKey, Math.min(30000, remainingMs)));
        try {
          const result = await action(ai, currentKey, model);
          if (Date.now() >= deadlineAt) throw timeoutError();
          activeKeyIndex = currentKeyIndex;
          return result;
        } catch (err: any) {
          lastError = err;
          const kind = markRotationFailure(currentKey, model, err, 'general');
          keyFailureKinds.set(currentKey, kind);
          activeKeyIndex = keys.length > 1 ? (currentKeyIndex + 1) % keys.length : currentKeyIndex;
          if (permanentlyInvalidKeys.has(currentKey)) break;
        }
      }
    }
  }

  if (attemptedModelCount === 0 && avoidedPairs.size > 0 && Date.now() < deadlineAt) {
    if (executionOptions?.providerAttempt === 'gemini-primary') {
      throw Object.assign(new Error('賱丕 鬲賵噩丿 兀夭賵丕噩 賲賮鬲丕丨/賳賲賵匕噩 睾賷乇 賲爻鬲禺丿賲丞 賲鬲丕丨丞 賱賱丕爻鬲賰賲丕賱 毓亘乇 Gemini.'), { status: 503, statusCode: 503 });
    }
    return executeWithKeyRotation(action, preferredModels, _ignoredClientFallbackKey, true, {
      ...executionOptions,
      avoidPairs: undefined,
    });
  }

  const finalKind = getGeminiErrorKind(lastError);
  if (finalKind === 'quota') {
    const quotaError: any = new Error('鬲毓匕乇 鬲賳賮賷匕 丕賱胤賱亘: 丕爻鬲賳賮丿鬲 丨氐氐 賲賮丕鬲賷丨 Gemini 丕賱賲鬲丕丨丞 兀賵 鬲賲 亘賱賵睾 丨丿 丕賱丕爻鬲禺丿丕賲.');
    quotaError.allGeminiQuotasExhausted = keys.length > 0 && keys.every((key) => keyFailureKinds.get(key) === 'quota');
    throw quotaError;
  }
  throw lastError || new Error('賮卮賱鬲 噩賲賷毓 賲丨丕賵賱丕鬲 鬲丿賵賷乇 丕賱賲賮丕鬲賷丨.');
}

export async function executeWithKeyRotationStream( action: (ai: GoogleGenAI, key: string, model: string) => Promise<AsyncIterable<any>>, onChunk: (text: string) => void, preferredModels: string[] = GEMINI_MODELS, _ignoredClientFallbackKey?: string, _forceGeminiFallback = false, executionOptions?: KeyRotationExecutionOptions ): Promise<void> {
  if (!executionOptions?.deadlineAt) {
    executionOptions = { ...executionOptions, deadlineAt: Date.now() + 270000 };
  }
  const deadlineAt = Number(executionOptions.deadlineAt);
  const timeoutError = () => Object.assign(new Error('丕賳鬲賴鬲 丕賱賲賴賱丞 丕賱賲鬲丕丨丞 賱賱鬲賵賱賷丿.'), { status: 504, statusCode: 504 });

  if (!_forceGeminiFallback && !executionOptions?.ocrMode && !executionOptions?.providerAttempt) {
    const overallStart = Date.now();
    const totalBudget = Math.max(0, deadlineAt - overallStart);
    let lastProviderError: any = null;
    for (let round = 0; round < 2; round++) {
      const roundStart = overallStart + Math.floor(totalBudget * round / 2);
      const roundEnd = overallStart + Math.floor(totalBudget * (round + 1) / 2);
      const geminiDeadlineAt = roundStart + Math.floor((roundEnd - roundStart) * 0.55);
      if (deadlineAt - Date.now() < 10000) break;
      let anyProviderEmittedText = false;
      try {
        await executeWithKeyRotationStream(action, (chunk) => {
          if (chunk) anyProviderEmittedText = true;
          onChunk(chunk);
        }, preferredModels, _ignoredClientFallbackKey, true, {
          ...executionOptions,
          deadlineAt: geminiDeadlineAt,
          providerAttempt: 'gemini-primary',
        });
        return;
      } catch (geminiError: any) {
        lastProviderError = geminiError;
        if (anyProviderEmittedText) throw geminiError;
      }
      if (roundEnd - Date.now() < 10000) break;
      try {
        await executeWithKeyRotationStream(action, (chunk) => {
          if (chunk) anyProviderEmittedText = true;
          onChunk(chunk);
        }, preferredModels, _ignoredClientFallbackKey, false, {
          ...executionOptions,
          deadlineAt: roundEnd,
          providerAttempt: 'openrouter-fallback',
          previousProviderError: String(lastProviderError?.message || '鬲毓匕乇 丕爻鬲禺丿丕賲 Gemini.'),
        });
        return;
      } catch (openRouterError: any) {
        lastProviderError = openRouterError;
        if (anyProviderEmittedText) throw openRouterError;
      }
    }
    const combined: any = new Error('鬲毓匕乇 鬲賳賮賷匕 丕賱胤賱亘 亘毓丿 賲丨丕賵賱鬲賷賳 賰丕賲賱鬲賷賳: Gemini 兀賵賱丕賸 孬賲 OpenRouter 賮賷 賰賱 賲丨丕賵賱丞.');
    combined.status = 503;
    combined.statusCode = 503;
    combined.cause = lastProviderError;
    throw combined;
  }

  if (!_forceGeminiFallback && executionOptions?.providerAttempt === 'openrouter-fallback' && !executionOptions?.ocrMode) {
    const availableModels = getOpenRouterModels();
    const avoidedPairs = new Set(executionOptions?.avoidPairs || []);
    const preferredModelsForAttempt = availableModels.filter((model) => !avoidedPairs.has(`openrouter::${model}`));
    const models = preferredModelsForAttempt.length ? preferredModelsForAttempt : availableModels;
    let lastOpenRouterError: any = null;

    if (!process.env.OPENROUTER_API_KEY?.trim()) {
      const missingKeyError: any = new Error('賲賮鬲丕丨 OpenRouter 睾賷乇 賲囟亘賵胤.');
      missingKeyError.status = 503;
      missingKeyError.statusCode = 503;
      throw missingKeyError;
    }

    for (const model of models) {
      if (deadlineAt - Date.now() < 10000) break;
      let emittedOpenRouterText = false;
      try {
        const ai = withAdaptiveAnswerLength(
          createOpenRouterCompatibleClient(12000, deadlineAt),
        ) as unknown as GoogleGenAI;
        const stream = await action(ai, 'openrouter', model);
        for await (const chunk of stream) {
          const text = typeof chunk?.text === 'string' ? chunk.text : '';
          if (text) {
            emittedOpenRouterText = true;
            onChunk(text);
          }
        }
        if (!emittedOpenRouterText) {
          const emptyError: any = new Error(`兀毓丕丿 賲賵丿賷賱 OpenRouter (${model}) 丕爻鬲噩丕亘丞 賮丕乇睾丞.`);
          emptyError.status = 503;
          emptyError.statusCode = 503;
          throw emptyError;
        }
        return;
      } catch (error: any) {
        if (emittedOpenRouterText) throw error;
        lastOpenRouterError = error;
      }
    }

    throw lastOpenRouterError || new Error('鬲毓匕乇 丕賱丨氐賵賱 毓賱賶 賳鬲賷噩丞 賲賳 賳賲丕匕噩 OpenRouter 丕賱丕丨鬲賷丕胤賷丞.');
  }

  const keys = (await getAvailableGeminiKeys()).filter((key) => !permanentlyInvalidKeys.has(key));
  if (keys.length === 0) throw new Error('賱賲 賷鬲賲 丕賱毓孬賵乇 毓賱賶 賲賮鬲丕丨 Gemini 氐丕賱丨.');

  const avoidedPairs = new Set(executionOptions?.avoidPairs || []);
  let attemptedModelCount = 0;
  for (let cycle = 0; cycle < 1; cycle++) {
    const startIdx = reserveStartIndex(keys.length, 'general');
    for (let offset = 0; offset < keys.length; offset++) {
      const currentKeyIndex = (startIdx + offset) % keys.length;
      const currentKey = keys[currentKeyIndex];
      const keyModels = selectModelsForKey(preferredModels, currentKey, 'general', Date.now(), avoidedPairs);

      for (let m = 0; m < keyModels.length; m++) {
        attemptedModelCount += 1;
        const ai = withAdaptiveAnswerLength(createGeminiClient(currentKey, 18000));
        let emittedAnyChunk = false;
        try {
          const stream = await action(ai, currentKey, keyModels[m]);
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
          markRotationFailure(currentKey, keyModels[m], err, 'general');
          if (emittedAnyChunk) {
            activeKeyIndex = keys.length > 1 ? (currentKeyIndex + 1) % keys.length : currentKeyIndex;
            throw err;
          }
          if (permanentlyInvalidKeys.has(currentKey)) break;
        }
      }
    }
  }
  if (attemptedModelCount === 0 && avoidedPairs.size > 0 && Date.now() < deadlineAt) {
    if (executionOptions?.providerAttempt === 'gemini-primary') {
      throw Object.assign(new Error('賱丕 鬲賵噩丿 兀夭賵丕噩 賲賮鬲丕丨/賳賲賵匕噩 睾賷乇 賲爻鬲禺丿賲丞 賲鬲丕丨丞 賱賱丕爻鬲賰賲丕賱 毓亘乇 Gemini.'), { status: 503, statusCode: 503 });
    }
    return executeWithKeyRotationStream(action, onChunk, preferredModels, _ignoredClientFallbackKey, true, {
      ...executionOptions,
      avoidPairs: undefined,
    });
  }
  throw new Error('賮卮賱鬲 噩賲賷毓 賲丨丕賵賱丕鬲 鬲丿賵賷乇 丕賱亘孬.');
}

export default function handler(req: any, res: any) {
  return res.status(200).json({ ok: true, activeKeys: getKeysStatus().totalCount });
}
