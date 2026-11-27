import { executeWithKeyRotation, executeWithKeyRotationStream } from '../keyRotation.ts';
import { createHash } from 'node:crypto';

import { enforceAiCooldown, consumeOperation } from '../auth.ts';
import { rateLimit, limitBodyString } from '../security.ts';
import { buildLegalAnchorLedger, prepareLegalStrategy } from './legal-strategy.ts';
export const EGYPTIAN_LEGAL_SYSTEM_INSTRUCTION = `أنت «أمين»، مساعد قانوني مصري مهني للمحامي. حلّل المهمة بحسب نوعها ومرحلتها، ولا تفترض أن كل عمل مذكرة دفاع. التزم بنوع المستند الذي حدده المحامي، أو حدّد الأنسب إذا فوّضك أو لم يحدد النوع.

قواعد العمل:
1) اعتمد على وقائع ومستندات ومدخلات القضية الحالية. ميّز بين الثابت والادعاء والاستنتاج والاحتمال والمعلومة الناقصة.
2) اربط كل دفع أو ثغرة بواقعة أو مستند محدد وبأثره القانوني. لا تنشئ دفوعاً نمطية ولا تفترض بطلاناً أو تزويراً أو فوات ميعاد أو عدم اختصاص دون سند كافٍ.
3) افحص التسلسل الزمني والأرقام والصفات والمصلحة والاختصاص والإجراءات والأدلة والتناقضات والنواقص، بقدر صلتها بالمهمة.
4) اختبر أقوى حجة للخصم والبدائل ذات الأثر، ووازن بين قوة الأدلة ومخاطر كل مسار. لا تعرض سلسلة التفكير الداخلية؛ اعرض النتائج المهنية فقط.
5) لا تختلق واقعة أو مستنداً أو اسماً أو تاريخاً أو مادة قانونية أو حكماً أو رقم طعن أو مصدراً. لا تذكر رقماً قانونياً إلا إذا كان متحققاً؛ وإلا نبّه إلى ضرورة التحقق.
6) التزم حرفياً بطلبات المحامي: لا تضف أو تحذف أو توسّع طلباً قضائياً حدده. أي طلب إضافي محتمل يذكر كتوصية منفصلة ولا يدرج دون تفويض.
7) عند وجود سياق من خزانة المحامي، استخدمه للأسلوب والبناء والترويسة فقط. حافظ على بصمته وترتيب القالب بقدر ملاءمته لنوع العمل، ولا تنقل منه وقائع أو أسماء أو أرقاماً أو دفوعاً أو طلبات تخص قضية أخرى.
8) اجعل التفصيل متناسباً مع أهمية المسألة؛ لا تكرر ولا تحشو ولا تختصر نقطة جوهرية. أخرج العمل كاملاً حتى الطلبات والخاتمة المناسبة.
9) اكتب بالعربية القانونية المصرية الواضحة. لا تضف مقدمات محادثية أو شرحاً عن كونك ذكاءً اصطناعياً. `;

const DEEP_AUDIT_INSTRUCTION = `أنشئ قبل الإجابة النهائية «حزمة تدقيق قانوني داخلية» مختصرة وليست سلسلة تفكير سرية. لا تكتب سرداً لخطوات التفكير؛ استخرج فقط نتائج قابلة للتحقق من المعطيات: (1) الوقائع والادعاءات الجوهرية، (2) سجل الادعاء/الدليل وما يثبت وما لا يثبت، (3) خط زمني عند الحاجة، (4) التناقضات، (5) النواقص الحرجة، (6) الدفوع والتكييفات المحتملة، (7) أقوى موقف للخصم، (8) نقاط الخطر والبدائل، (9) عناصر تحتاج تحققاً، (10) أخطر شيء قد يكون التحليل قد أغفله. لا تختلق أي معلومة قانونية أو واقعية. اجعل الحزمة مركزة حتى يمكن استخدامها كأساس للإجابة النهائية.`;

const FINAL_REVIEW_INSTRUCTION = `هذه المهمة خضعت لتدقيق أولي. قبل الإخراج النهائي استخدم حزمة التدقيق كمدخل مساعد، ثم أعد اختبارها خصمياً: صحح أي استنتاج غير مدعوم، افصل الثابت عن الاستنتاج، لا تضف أي معلومة غير موجودة، وابحث مرة أخيرة عن أقوى حجة معاكسة ومعلومة ناقصة قد تقلب النتيجة. أخرج النتيجة العملية المطلوبة فقط، دون كشف حزمة التدقيق الداخلية أو سلسلة التفكير السرية.`;



const DRAFTING_COMPRESSION_CHUNK = 9000;
const DRAFTING_CHECKPOINT_VERSION = 2;

type DraftingCompressionEntry = {
  sourceHash: string;
  sourceLength: number;
  pass: number;
  workingText: string;
  chunks: string[];
  /** Persist exact chunk boundaries so a failed large chunk can be subdivided safely. */
  sourceChunks?: string[];
};

type DraftingCheckpoint = {
  version: number;
  entries: Record<string, DraftingCompressionEntry>;
};

const DRAFTING_STEP_YIELDED = '__AMIN_DRAFTING_STEP_YIELDED__';

/** Split long legal input at paragraph/sentence boundaries without silently dropping text. */
function splitDraftingInput(source: string, maxChars = DRAFTING_COMPRESSION_CHUNK): string[] {
  const text = String(source || '').replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  const pieces = text.split(/\n\s*\n+/);
  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (piece.length > maxChars) {
      if (current) { chunks.push(current); current = ''; }
      const sentences = piece.split(/(?<=[.!؟?])\s+/);
      for (const sentence of sentences) {
        if (sentence.length > maxChars) {
          for (let i = 0; i < sentence.length; i += maxChars) chunks.push(sentence.slice(i, i + maxChars));
        } else if (current && current.length + sentence.length + 1 > maxChars) {
          chunks.push(current); current = sentence;
        } else current = current ? current + ' ' + sentence : sentence;
      }
    } else if (current && current.length + piece.length + 2 > maxChars) {
      chunks.push(current); current = piece;
    } else current = current ? current + '\n\n' + piece : piece;
  }
  if (current) chunks.push(current);
  return chunks;
}

function getDraftingCheckpoint(raw: unknown): DraftingCheckpoint {
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = null; }
  }
  const value = raw && typeof raw === 'object' ? raw as any : {};
  return {
    version: DRAFTING_CHECKPOINT_VERSION,
    entries: value.version === DRAFTING_CHECKPOINT_VERSION && value.entries && typeof value.entries === 'object'
      ? value.entries
      : {},
  };
}

/** Save only the drafting compression ledger into the currently running durable job. */
async function persistDraftingCheckpoint(jobId: string, userId: string, checkpoint: DraftingCheckpoint): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(jobId) || !userId) return;
  const baseUrl = (process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
  const key = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim();
  if (!baseUrl || !key) {
    const error: any = new Error('تعذر حفظ نقطة استكمال ضغط النص؛ إعدادات تخزين المهام غير مكتملة.');
    error.status = 503; error.statusCode = 503; throw error;
  }
  const headers: Record<string, string> = { apikey: key, 'Content-Type': 'application/json' };
  if (!key.startsWith('sb_')) headers.Authorization = 'Bearer ' + key;
  const query = 'id=eq.' + encodeURIComponent(jobId) + '&user_id=eq.' + encodeURIComponent(userId) + '&task_type=eq.counter-brief&status=eq.running&limit=1';
  const read = await fetch(baseUrl + '/rest/v1/app_ai_generation_jobs?select=payload&' + query, {
    headers, signal: AbortSignal.timeout(10000),
  });
  if (!read.ok) {
    const error: any = new Error('تعذر قراءة بيانات مهمة الصياغة لحفظ نقطة الاستكمال (' + read.status + ').');
    error.status = read.status >= 500 ? read.status : 503; error.statusCode = error.status; throw error;
  }
  const rows = await read.json().catch(() => []);
  if (!Array.isArray(rows) || !rows.length) {
    const error: any = new Error('لم تعد مهمة الصياغة في حالة التشغيل لحفظ نقطة الاستكمال.');
    error.status = 503; error.statusCode = 503; throw error;
  }
  const payload = rows[0]?.payload && typeof rows[0].payload === 'object' ? rows[0].payload : {};
  const write = await fetch(baseUrl + '/rest/v1/app_ai_generation_jobs?' + query, {
    method: 'PATCH',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify({ payload: { ...payload, _draftingState: JSON.stringify(checkpoint) }, updated_at: new Date().toISOString() }),
    signal: AbortSignal.timeout(10000),
  });
  if (!write.ok) {
    const error: any = new Error('تعذر حفظ تقدم ضغط النص القانوني (' + write.status + ').');
    error.status = write.status >= 500 ? write.status : 503; error.statusCode = error.status; throw error;
  }
}

/** Compress oversized drafting context, checkpointing every completed chunk for automatic retry. */
async function compressDraftingInput(
  source: string,
  label: string,
  targetChars: number,
  deadlineAt: number,
  styleOnly = false,
  checkpointContext?: { jobId: string; userId: string; checkpoint: DraftingCheckpoint; yieldEachChunk?: boolean },
): Promise<string> {
  const original = String(source || '').replace(/\r\n?/g, '\n').trim();
  if (!original) return '';
  const sourceHash = createHash('sha256').update(original).digest('hex');
  const checkpoint = checkpointContext?.checkpoint;
  const saved = checkpoint?.entries?.[label];
  const entryMatches = Boolean(saved && saved.sourceHash === sourceHash && saved.sourceLength === original.length);
  if (original.length <= targetChars) return original;
  if (entryMatches && saved!.workingText && saved!.workingText.length <= targetChars) return saved!.workingText;

  let current = entryMatches && saved!.workingText ? saved!.workingText : original;
  let pass = entryMatches ? Math.max(0, Number(saved!.pass || 0)) : 0;
  let savedChunks = entryMatches && Array.isArray(saved!.chunks) ? saved!.chunks : [];
  let savedSourceChunks = entryMatches && Array.isArray(saved!.sourceChunks) ? saved!.sourceChunks : [];

  for (; pass < 4 && current.length > targetChars;) {
    const chunks = savedSourceChunks.length && savedSourceChunks.join('') && savedSourceChunks.join('').length <= current.length + 100
      ? [...savedSourceChunks]
      : splitDraftingInput(current, DRAFTING_COMPRESSION_CHUNK);
    const reusableSavedChunks = savedChunks.length === chunks.length ? savedChunks : [];
    const summaries: string[] = Array.from({ length: chunks.length }, (_, index) =>
      typeof reusableSavedChunks[index] === 'string' ? reusableSavedChunks[index] : '');
    for (let i = 0; i < chunks.length; i++) {
      if (summaries[i]) continue;
      if (Date.now() > deadlineAt - 8000) {
        const timeout: any = new Error('انتهى الوقت أثناء تجهيز النص القانوني الطويل؛ حُفظت الأجزاء المكتملة وستُستأنف تلقائياً.');
        timeout.status = 504; timeout.statusCode = 504; throw timeout;
      }
      const task = styleOnly
        ? 'استخرج من هذا الجزء أسلوب المحامي والترويسة العامة وترتيب الأقسام وطريقة عرض الدفوع والطلبات والخاتمة فقط. لا تنقل أي وقائع أو أسماء أو تواريخ أو أرقام أو دفوع أو طلبات تخص قضية النموذج.'
        : 'حوّل هذا الجزء إلى سجل وقائع قانوني محافظ في نقاط واضحة، وليس ملخصاً عاماً. احتفظ بكل واقعة واسم وصفة وتاريخ ومبلغ وعملة ورقم قضية أو مستند أو مادة أو حكم وطلب ودفع ودليل وتناقض ونقص، وانقل الأرقام والمراجع الحساسة حرفياً. ميّز الثابت عن الادعاء وعن الاستنتاج، ولا تختلق أو تدمج معلومات متعارضة أو تحذف أي تفصيل قد يؤثر قانوناً. احذف التكرار اللفظي فقط. يجب أن يكون الناتج مفصلاً بما يكفي لإعادة صياغة المذكرة دون الرجوع إلى هذا الجزء.';
      const chunkPrompt = task + '\nالجزء ' + (i + 1) + '/' + chunks.length + ':\n' + chunks[i];
      const chunkStartedAt = Date.now();
      let summary: string;
      try {
        summary = await executeWithKeyRotation(async (ai, _key, model) => {
        const response = await ai.models.generateContent({
          model, contents: chunkPrompt,
          config: {
            systemInstruction: styleOnly ? 'محرر أسلوب قانوني مصري؛ استخرج الأسلوب والبنية فقط.' : 'مساعد قانوني مصري؛ حافظ على الوقائع والمراجع دون اختلاق.',
            temperature: 0.1, maxOutputTokens: styleOnly ? 900 : 3000,
          },
        });
        const output = typeof response.text === 'string' ? response.text.trim() : '';
        if (!output) throw new Error('لم ينتج ملخص صالح لتجهيز سياق الصياغة.');
        const minimumOutputChars = styleOnly
          ? Math.min(180, Math.max(60, Math.ceil(chunks[i].length * 0.08)))
          : Math.min(500, Math.max(80, Math.ceil(chunks[i].length * 0.12)));
        if (output.length < minimumOutputChars) {
          const shortOutput: any = new Error(`ملخص الجزء ${i + 1} غير كافٍ للحفاظ على التفاصيل (${output.length} حرفاً؛ الحد الأدنى ${minimumOutputChars}). أُرفض الملخص لمنع إسقاط الوقائع.`);
          shortOutput.status = 502; shortOutput.statusCode = 502;
          throw shortOutput;
        }
        return output;
        }, undefined, undefined, false, { deadlineAt, draftingMode: true, minimumAttemptMs: 10000, maxModelAttempts: 3 });
      } catch (providerError: any) {
        const providerStatus = Number(providerError?.status || providerError?.statusCode ||
          providerError?.response?.status || providerError?.response?.statusCode || 0);
        const temporaryProviderFailure = [408, 429, 500, 502, 503, 504].includes(providerStatus) ||
          /high demand|service unavailable|temporarily unavailable|timed out|timeout|network|fetch failed|connection|socket|econn/i.test(String(providerError?.message || ''));

        // Save completed compression chunks and yield the durable job on
        // transient Gemini failures. The worker resumes this exact chunk in a
        // fresh invocation instead of letting the request deadline mask the
        // provider's 503/504 or repeating already-completed work.
        if (checkpoint && checkpointContext) {
          let retrySourceChunks = [...chunks];
          let retrySummaries = [...summaries];
          // A provider 504 on one oversized compression segment must not trap
          // the durable job on the same boundary forever. Split only the
          // failed segment; retain completed summaries and persist boundaries.
          if (temporaryProviderFailure && chunks[i].length > 1800) {
            const failedChunk = chunks[i];
            const midpoint = Math.floor(failedChunk.length / 2);
            const searchRadius = Math.floor(failedChunk.length * 0.2);
            let splitAt = midpoint;
            for (let distance = 0; distance <= searchRadius; distance += 1) {
              const candidates = [midpoint - distance, midpoint + distance];
              const found = candidates.find((position) =>
                position > 0 && position < failedChunk.length &&
                /[\\s،؛:]/.test(failedChunk[position - 1]) &&
                /[\\s،؛:]/.test(failedChunk[position]));
              if (found) { splitAt = found; break; }
            }
            retrySourceChunks.splice(i, 1, failedChunk.slice(0, splitAt), failedChunk.slice(splitAt));
            retrySummaries.splice(i, 1, '', '');
            console.warn('[counter-brief] split failed compression chunk for retry', {
              section: label, pass: pass + 1, failedChunkIndex: i + 1,
              previousChunkCharacters: failedChunk.length,
              nextChunkCharacters: [retrySourceChunks[i].length, retrySourceChunks[i + 1].length],
              providerStatus: providerStatus || 'unknown',
            });
          }
          checkpoint.entries[label] = {
            sourceHash, sourceLength: original.length, pass,
            workingText: current, chunks: retrySummaries, sourceChunks: retrySourceChunks,
          };
          await persistDraftingCheckpoint(checkpointContext.jobId, checkpointContext.userId, checkpoint);
          if (temporaryProviderFailure && checkpointContext.yieldEachChunk) {
            console.warn('[counter-brief] saved drafting compression checkpoint after transient Gemini failure', {
              section: label, pass: pass + 1, chunkIndex: i + 1, chunkCount: retrySourceChunks.length,
              providerStatus: providerStatus || 'unknown', completedChunks: retrySummaries.filter(Boolean).length,
            });
          }
        }
        throw providerError;
      }

      summaries[i] = summary;
      console.info('[counter-brief] drafting compression chunk saved', {
        section: label,
        pass: pass + 1,
        chunkIndex: i + 1,
        chunkCount: chunks.length,
        sourceChunkCharacters: chunks[i].length,
        summaryCharacters: summary.length,
        elapsedMs: Date.now() - chunkStartedAt,
        checkpointEnabled: Boolean(checkpoint),
      });
      const updatedEntry: DraftingCompressionEntry = {
        sourceHash, sourceLength: original.length, pass,
        workingText: current, chunks: summaries, sourceChunks: chunks,
      };
      if (checkpoint) {
        checkpoint.entries[label] = updatedEntry;
        if (checkpointContext) await persistDraftingCheckpoint(checkpointContext.jobId, checkpointContext.userId, checkpoint);
        if (checkpointContext?.yieldEachChunk) return DRAFTING_STEP_YIELDED;
      }
    }
    current = summaries.join('\n\n');
    pass += 1;
    savedChunks = [];
    if (checkpoint) {
      checkpoint.entries[label] = { sourceHash, sourceLength: original.length, pass, workingText: current, chunks: [] };
      if (checkpointContext) await persistDraftingCheckpoint(checkpointContext.jobId, checkpointContext.userId, checkpoint);
    }
  }
  if (current.length > targetChars) {
    const error: any = new Error('تعذر ضغط ' + label + ' إلى الحد الآمن دون احتمال فقد تفاصيل؛ حُفظ التقدم ولم يُخصم رصيد. أعد المحاولة أو قلّل النص.');
    error.status = 413; error.statusCode = 413; throw error;
  }
  return current;
}

function assertDraftingInputBudget(prompt: string): void {
  const estimatedTokens = Math.ceil((prompt.length + EGYPTIAN_LEGAL_SYSTEM_INSTRUCTION.length) / 3);
  console.info('[counter-brief] final prompt budget check', { promptCharacters: prompt.length, estimatedInputTokens: estimatedTokens, tokenCountIsEstimate: true });
  if (estimatedTokens > 7500) {
    const error: any = new Error('سياق الصياغة القانونية أكبر من الحد الآمن (7,500 token تقديري). تم حفظ المهمة؛ قلّل سياق القضية أو الخزانة ثم أعد المحاولة؛ لم يُخصم رصيد');
    error.status = 413; error.statusCode = 413; throw error;
  }
}

/** Finish reasons that represent a provider refusal/filter, not a normal continuation point. */
async function logDraftingPromptTokens(_ai: any, model: string, prompt: string, continuationCount: number, accumulatedCharacters: number): Promise<void> {
  // The key-rotation adapter exposes generation methods, not the SDK token-count endpoint.
  // Never call ai.models.countTokens here: estimate request size from characters only, non-blockingly.
  const systemCharacters = EGYPTIAN_LEGAL_SYSTEM_INSTRUCTION.length;
  console.info('[counter-brief] Gemini request size estimate', {
    model,
    promptCharacters: prompt.length,
    systemInstructionCharacters: systemCharacters,
    estimatedInputTokens: Math.ceil((prompt.length + systemCharacters) / 3),
    tokenCountIsEstimate: true,
    continuationCount,
    accumulatedCharacters,
  });
}

function isBlockedFinishReason(reason: unknown): boolean {
  const normalized = String(reason || '').trim().toUpperCase();
  return ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'CONTENT_FILTER'].includes(normalized);
}

function mergeContinuation(previous: string, next: string): string {
  if (!next) return '';
  if (!previous) return next;
  if (next.startsWith(previous)) return next.slice(previous.length);
  if (previous.startsWith(next)) return '';
  const maxOverlap = Math.min(previous.length, next.length, 6000);
  for (let overlap = maxOverlap; overlap >= 80; overlap -= 1) {
    if (previous.slice(-overlap) === next.slice(0, overlap)) return next.slice(overlap);
  }
  return next;
}

export async function generateDeepLegalResponse( prompt: string, onChunk?: (text: string) => void, options: { legalResearch?: boolean; resumeText?: string; resumeGeminiKey?: string; resumeGeminiModel?: string; continuationContext?: string; deadlineAt?: number } = {}, ): Promise<string> {
  // Performance-critical path: the previous implementation generated a full
  // hidden audit response and then sent a second full generation request for
  // the final answer. That doubled model latency and was especially noticeable
  // on long legal documents. The system instruction already requires internal
  // verification, so perform the review inside a single generation request.
  const completionMarker = '[[AMIN_STREAM_COMPLETE_9F7C2A]]';
  const researchInstruction = options.legalResearch ? '\n\n[بحث قانوني موثق إلزامي] استخدم أداة البحث المتاحة للبحث عن المصادر المصرية الأولية والرسمية ذات الصلة بالمهمة الحالية. أعط الأولوية لمواقع الجهات الرسمية والتشريعات المنشورة والأحكام المنشورة من مصادر قضائية موثوقة. لا تعتبر مقتطف نتيجة البحث نصاً كاملاً للحكم أو القانون. لا تذكر إلا ما تدعمه المصادر التي وصلت إليها فعلاً، وأدرج روابط مباشرة للمصادر بجوار الادعاءات القانونية المستندة إليها. إذا لم تجد مصدراً موثوقاً أو تعذر التحقق من نص أو رقم حكم أو طعن، فصرح بذلك ولا تختلقه. افصل بوضوح بين النص الرسمي، والشرح، والاستنتاج القانوني.\n' : '';
  const optimizedPrompt = `${prompt}${researchInstruction} [تعليمات كفاءة الإخراج] أنجز المطلوب في طلب توليد واحد قدر الإمكان. لا تكرر التحليل أو تعيد صياغة الفكرة نفسها في أكثر من موضع، ولا تضف مقدمات أو خاتمات إنشائية أو عناوين مكررة. اجعل كل فقرة تضيف حجة أو واقعة أو تطبيقاً أو طلباً جديداً، مع الحفاظ على جميع النقاط القانونية الجوهرية وعدم اختصار ما يؤثر في النتيجة. راجع الوقائع والطلبات ومخاطر الاختلاق داخلياً مراجعة مركزة، ولا تعرض خطوات التفكير. أخرج المستند المطلوب مباشرة. [علامة اكتمال داخلية إلزامية] بعد إتمام جميع أجزاء النتيجة المطلوبة بالكامل، وفي آخر النص فقط، أضف هذه العلامة حرفياً: ${completionMarker}. لا تضف العلامة قبل اكتمال المستند. لا تشرح العلامة ولا تجعلها جزءاً من المحتوى القانوني.`;

  const maxContinuations = 5;
  // Keep the last successful Gemini connection preferred while continuing this document.
  const deadlineAt = Number(options.deadlineAt || (Date.now() + 270000));
  let accumulatedText = typeof options.resumeText === 'string' ? options.resumeText : '';
  let continuationCount = 0;
  let lastError: any = null;
  let previousPair = '';
  let continuationGeminiStartKey = String(options.resumeGeminiKey || '');
  let continuationGeminiStartModel = String(options.resumeGeminiModel || '');
  const attemptedGeminiPairs = new Set<string>();

  // This shared generator is also used by deconstruct/refine. The legal-drafting
  // budget is enforced by the counter-brief handler on its assembled prompt;
  // applying it here incorrectly blocks other task types with a drafting error.
  const continuationBasePrompt = String(options.continuationContext || optimizedPrompt);
  const makeContinuationPrompt = () => accumulatedText
    ? continuationBasePrompt + ' [استكمال إلزامي] هذا آخر مقطع من النص السابق للربط؛ ما قبله مكتمل ولا تعِد كتابته: ' +
      accumulatedText.slice(-1400) +
      '\n\nتابع مباشرة من آخر موضع، وأكمل بقية أقسام المستند والطلبات والخاتمة دون تكرار. حافظ على الوقائع والطلبات المحددة وبصمة المحامي. أضف علامة الاكتمال ' +
      completionMarker + ' في نهاية المستند فقط بعد إتمامه بالكامل.'
    : optimizedPrompt;

  if (onChunk) {
    let completed = false;
    while (continuationCount <= maxContinuations && Date.now() < deadlineAt) {
      const segmentPrompt = makeContinuationPrompt();
      const segmentBaseText = accumulatedText;
      let segmentBuffer = '';
      let segmentPrefixResolved = !segmentBaseText.length;
      let segmentCompleted = false;
      let activePair = '';
      let activePairLabel = '';
      let finishReason = '';
      let segmentError: any = null;

      try {
        await executeWithKeyRotationStream(async (ai, key, model) => {
          activePair = `${key}::${model}`;
          activePairLabel = `Gemini / ${model}`;
          const providerSearchEnabled = options.legalResearch && process.env.GEMINI_ENABLE_GOOGLE_SEARCH === 'true';

          await logDraftingPromptTokens(ai, model, segmentPrompt, continuationCount, accumulatedText.length);
          return (async function* () {
            let pendingMarkerTail = '';
            let receivedText = false;
            const stream = await ai.models.generateContentStream({
              model,
              contents: segmentPrompt,
              config: {
                systemInstruction: EGYPTIAN_LEGAL_SYSTEM_INSTRUCTION,
                temperature: 0.15,
                maxOutputTokens: 32768,
                ...(providerSearchEnabled ? { tools: [{ googleSearch: {} }] } : {}),
                thinkingConfig: { thinkingLevel: 'low' },
              },
            });

            try {
              for await (const chunk of stream) {
                const candidateReason = chunk?.candidates?.[0]?.finishReason;
                if (candidateReason) finishReason = String(candidateReason).toUpperCase();
                const chunkText = typeof chunk?.text === 'string' ? chunk.text : '';
                if (!chunkText) continue;
                receivedText = true;
                const candidateText = pendingMarkerTail + chunkText;
                const markerIndex = candidateText.indexOf(completionMarker);
                if (markerIndex >= 0) {
                  const visibleText = candidateText.slice(0, markerIndex);
                  pendingMarkerTail = '';
                  segmentCompleted = true;
                  if (visibleText) yield { text: visibleText };
                  break;
                }
                const keepLength = completionMarker.length - 1;
                const splitAt = Math.max(0, candidateText.length - keepLength);
                const visibleText = candidateText.slice(0, splitAt);
                pendingMarkerTail = candidateText.slice(splitAt);
                if (visibleText) yield { text: visibleText };
              }
            } catch (error) {
              if (pendingMarkerTail) yield { text: pendingMarkerTail };
              pendingMarkerTail = '';
              throw error;
            }

            if (!segmentCompleted && pendingMarkerTail) yield { text: pendingMarkerTail };
            if (!receivedText) {
              const emptyError: any = new Error(`لم يصل نص من النموذج (finishReason: ${finishReason || 'UNKNOWN'}).`);
              emptyError.status = 503;
              emptyError.statusCode = 503;
              throw emptyError;
            }
            if (isBlockedFinishReason(finishReason)) {
              const blockedError: any = new Error(`توقف النموذج بسبب قيد محتوى (finishReason: ${finishReason}).`);
              blockedError.status = 502;
              blockedError.statusCode = 502;
              blockedError.blockedResponse = true;
              throw blockedError;
            }
          })();
        }, (text) => {
          if (!text) return;
          segmentBuffer += text;
          if (segmentPrefixResolved) {
            accumulatedText += text;
            onChunk(text);
            return;
          }
          if (segmentBaseText.startsWith(segmentBuffer) && segmentBuffer.length < segmentBaseText.length) return;
          const overlapWindow = Math.min(segmentBaseText.length, 6000);
          if (segmentBuffer.length < overlapWindow) return;
          const addition = mergeContinuation(segmentBaseText, segmentBuffer);
          if (addition) {
            accumulatedText += addition;
            onChunk(addition);
          }
          segmentPrefixResolved = true;
        }, undefined, undefined, false, {
          deadlineAt,
          startKey: continuationGeminiStartKey || undefined,
          startModel: continuationGeminiStartModel || undefined,
          draftingMode: true,
          attemptedPairs: attemptedGeminiPairs,
          maxModelAttempts: 4,
        });
      } catch (error: any) {
        segmentError = error;
        lastError = error;
      }

      // Resume from the last pair that actually produced document text.
      // A request that failed before its first chunk must not replace the
      // previously successful key/model preference.
      if (activePair && (!segmentError || segmentBuffer.length > 0)) {
        continuationGeminiStartKey = activePair.split('::')[0];
        continuationGeminiStartModel = activePair.split('::')[1] || '';
      }
      if (segmentError) {
        console.warn('[counter-brief] segment failed; retaining partial output for Gemini continuation', {
          reason: String(segmentError?.message || segmentError).slice(0, 500),
          providerModel: activePairLabel || 'unknown',
          partialCharacters: segmentBuffer.length,
          accumulatedCharacters: accumulatedText.length,
          continuationCount,
          willResume: Boolean(accumulatedText.trim()),
        });
        if (segmentError.partialCharacters === undefined) segmentError.partialCharacters = segmentBuffer.length;
      }
      if (!segmentPrefixResolved && segmentBuffer) {
        const addition = mergeContinuation(segmentBaseText, segmentBuffer);
        if (addition) {
          accumulatedText += addition;
          onChunk(addition);
        }
        segmentPrefixResolved = true;
      }

      if (segmentCompleted) {
        completed = true;
        break;
      }
      if (!segmentBuffer.trim() || accumulatedText.length === segmentBaseText.length) {
        throw segmentError || new Error('لم يصل نص جديد أثناء محاولة استكمال المستند.');
      }
      if (continuationCount >= maxContinuations) {
        const incompleteError: any = new Error(`لم تكتمل الإجابة بعد ${maxContinuations} محاولات استكمال؛ لم تصل علامة اكتمال المستند.`);
        incompleteError.status = 502;
        incompleteError.statusCode = 502;
        incompleteError.cause = lastError;
        throw incompleteError;
      }

      console.info('[counter-brief] continuing incomplete output', {
        finishReason: finishReason || 'UNKNOWN',
        generatedCharacters: accumulatedText.length,
        continuationCount: continuationCount + 1,
        providerModel: activePairLabel || 'unknown',
        changedConnection: Boolean(previousPair && activePair && previousPair !== activePair),
        previousRequestFailed: Boolean(segmentError),
      });
      previousPair = activePair;
      continuationCount += 1;
    }

    if (!completed) {
      const incompleteError: any = new Error('انتهى الوقت المتاح قبل اكتمال المستند القانوني.');
      incompleteError.status = 504;
      incompleteError.statusCode = 504;
      throw incompleteError;
    }
    return accumulatedText.trim();
  }

  while (continuationCount <= maxContinuations && Date.now() < deadlineAt) {
    const segmentPrompt = makeContinuationPrompt();
    let activePair = '';
    let activePairLabel = '';
    let segmentResult: any;
    try {
      segmentResult = await executeWithKeyRotation(async (ai, key, model) => {
        activePair = `${key}::${model}`;
        activePairLabel = `Gemini / ${model}`;
        const providerSearchEnabled = options.legalResearch && process.env.GEMINI_ENABLE_GOOGLE_SEARCH === 'true';
        await logDraftingPromptTokens(ai, model, segmentPrompt, continuationCount, accumulatedText.length);
        const response = await ai.models.generateContent({
          model,
          contents: segmentPrompt,
          config: {
            systemInstruction: EGYPTIAN_LEGAL_SYSTEM_INSTRUCTION,
            temperature: 0.15,
            maxOutputTokens: 32768,
            ...(providerSearchEnabled ? { tools: [{ googleSearch: {} }] } : {}),
          },
        });
        const rawText = typeof response.text === 'string' ? response.text : '';
        const finishReason = String(response?.candidates?.[0]?.finishReason || '').toUpperCase();
        if (!rawText.trim()) {
          const emptyError: any = new Error(`أعاد مزود الذكاء الاصطناعي نصاً فارغاً (finishReason: ${finishReason || 'UNKNOWN'}).`);
          emptyError.status = 503;
          emptyError.statusCode = 503;
          throw emptyError;
        }
        if (isBlockedFinishReason(finishReason)) {
          const blockedError: any = new Error(`توقف النموذج بسبب قيد محتوى (finishReason: ${finishReason}).`);
          blockedError.status = 502;
          blockedError.statusCode = 502;
          blockedError.blockedResponse = true;
          throw blockedError;
        }
        const markerIndex = rawText.indexOf(completionMarker);
        return {
          text: markerIndex >= 0 ? rawText.slice(0, markerIndex) : rawText,
          completed: markerIndex >= 0,
          finishReason,
        };
      }, undefined, undefined, false, {
        deadlineAt,
        startKey: continuationGeminiStartKey || undefined,
        startModel: continuationGeminiStartModel || undefined,
        draftingMode: true,
        maxModelAttempts: 4,
      });
    } catch (error: any) {
      lastError = error;
      throw error;
    }

    if (activePair) {
      continuationGeminiStartKey = activePair.split('::')[0];
      continuationGeminiStartModel = activePair.split('::')[1] || '';
    }
    const addition = mergeContinuation(accumulatedText, segmentResult.text || '');
    accumulatedText += addition;
    if (segmentResult.completed) return accumulatedText.trim();
    if (!addition.trim()) throw new Error(`لم يصل نص جديد أثناء الاستكمال (finishReason: ${segmentResult.finishReason || 'UNKNOWN'}).`);
    if (continuationCount >= maxContinuations) {
      const incompleteError: any = new Error(`لم تكتمل الإجابة بعد ${maxContinuations} محاولات استكمال؛ لم تصل علامة اكتمال المستند.`);
      incompleteError.status = 502;
      incompleteError.statusCode = 502;
      incompleteError.cause = lastError;
      throw incompleteError;
    }
    console.info('[counter-brief] continuing incomplete output', {
      finishReason: segmentResult.finishReason || 'UNKNOWN',
      generatedCharacters: accumulatedText.length,
      continuationCount: continuationCount + 1,
      providerModel: activePairLabel || 'unknown',
      changedConnection: Boolean(previousPair && activePair && previousPair !== activePair),
    });
    previousPair = activePair;
    continuationCount += 1;
  }

  const incompleteError: any = new Error('انتهى الوقت المتاح قبل اكتمال المستند القانوني.');
  incompleteError.status = 504;
  incompleteError.statusCode = 504;
  throw incompleteError;
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }


  try {
    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {}
    }
    const {
      courtType,
      circuit,
      briefType,
      judicialWorkType,
      customJudicialWorkType,
      effectiveWorkType,
      clientRole,
      clientName,
      opponentName,
      caseNumber,
      sessionDate,
      facts,
      defenses,
      requests,
      customInstructions,
      caseAnalysisContext,
      caseContext,
      vaultContext,
      _resumePartialText,
      _jobId,
      _jobUserId,
      _draftingState,
    } = body || {};

    if (!facts || !facts.trim()) {
      return res.status(400).json({ error: 'يرجى كتابة وقائع الدعوى.' });
    }

    rateLimit(req, 'gemini-counter-brief', 8, 10 * 60 * 1000);
    await enforceAiCooldown(req);

    limitBodyString(facts, 900000, 'الوقائع');
    limitBodyString(vaultContext, 30000, 'سياق الخزانة');
    limitBodyString(caseAnalysisContext, 150000, 'سياق التحليل القانوني السابق');
    if (typeof vaultContext !== 'string' || !vaultContext.includes('[بصمة أسلوب المحامي')) {
      const err: any = new Error('لم يتم العثور على نموذج شخصي من خزانة هذا الحساب. لم يبدأ التوليد ولم يُخصم رصيد؛ أضف أو استعد نماذجك الشخصية أولاً.');
      err.statusCode = 400;
      throw err;
    }

    const finalWorkType =
      (customJudicialWorkType && customJudicialWorkType.trim()) ||
      (effectiveWorkType && effectiveWorkType.trim()) ||
      (briefType && briefType.trim()) ||
      '';
    const workTypeInstruction = finalWorkType
      ? `نوع المستند المطلوب من المحامي: ${finalWorkType}. التزم بهذا النوع.`
      : 'نوع المستند غير محدد مسبقاً: حدّد داخلياً أنسب نوع مستند قانوني للرد على المادة المنقولة (مذكرة رد/دفاع، عريضة/صحيفة دعوى، صحيفة طعن، حافظة مستندات، إنذار أو غير ذلك) بناءً على الغرض والطلبات والوقائع، ولا تفترض تلقائياً أنها مذكرة دفاع.';

    // The caller already supplies the case facts and any prior legal analysis.
    // Send both unchanged to Gemini; do not spend extra requests re-analyzing them.
    // Keep the source in the persisted form/job payload. Remove only exact
    // duplicate paragraphs from the model-facing copy; unique information stays.
    const seenSourceParagraphs = new Set<string>();
    let draftingFactsContext = String(facts || '')
      .replace(/\r\n?/g, '\n')
      .split(/\n\s*\n+/)
      .map((paragraph) => paragraph.trim())
      .filter((paragraph) => {
        if (!paragraph) return false;
        const key = paragraph.replace(/[\t ]+/g, ' ').trim();
        if (seenSourceParagraphs.has(key)) return false;
        seenSourceParagraphs.add(key);
        return true;
      })
      .join('\n\n');
    let draftingPriorAnalysisContext = typeof caseAnalysisContext === 'string'
      ? caseAnalysisContext
          .replace(/\r\n?/g, '\n')
          .split(/\n\s*\n+/)
          .map((paragraph) => paragraph.trim())
          .filter((paragraph) => {
            if (!paragraph) return false;
            const key = paragraph.replace(/[\t ]+/g, ' ').trim();
            if (seenSourceParagraphs.has(key)) return false;
            seenSourceParagraphs.add(key);
            return true;
          })
          .join('\n\n')
      : '';
    const draftingAnalysisDeadline = Date.now() + 210000;
    const draftingCheckpoint = getDraftingCheckpoint(_draftingState);
    const draftingCheckpointContext = { jobId: String(_jobId || ''), userId: String(_jobUserId || ''), checkpoint: draftingCheckpoint, yieldEachChunk: Boolean(body?.stream === true && _jobId && _jobUserId) };

    // Compress only the legal-drafting payload. Source text remains in the
    // persisted job; model calls receive bounded, labeled context instead.
    const compressStep = async (source: string, label: string, target: number, styleOnly = false): Promise<string | null> => {
      const result = await compressDraftingInput(source, label, target, draftingAnalysisDeadline, styleOnly, draftingCheckpointContext);
      if (result === DRAFTING_STEP_YIELDED) {
        res.write(JSON.stringify({ type: 'yield' }) + '\n');
        res.end();
        return null;
      }
      return result;
    };
    const compressedFacts = await compressStep(draftingFactsContext, 'وقائع القضية', 8000);
    if (compressedFacts === null) return;
    draftingFactsContext = compressedFacts;
    const compressedAnalysis = await compressStep(draftingPriorAnalysisContext, 'التحليل السابق', 650);
    if (compressedAnalysis === null) return;
    draftingPriorAnalysisContext = compressedAnalysis;
    const compressedVault = await compressStep(String(vaultContext || ''), 'خزانة أسلوب المحامي', 500, true);
    if (compressedVault === null) return;
    const draftingVaultContext = compressedVault;
    const compressedDefenses = await compressStep(String(defenses || ''), 'دفوع المحامي', 650);
    if (compressedDefenses === null) return;
    const draftingDefensesContext = compressedDefenses;
    const compressedRequests = await compressStep(String(requests || ''), 'طلبات المحامي', 900);
    if (compressedRequests === null) return;
    const draftingRequestsContext = compressedRequests;
    const compressedInstructions = await compressStep(String(customInstructions || ''), 'تعليمات المحامي', 500);
    if (compressedInstructions === null) return;
    const draftingCustomInstructionsContext = compressedInstructions;

    const draftingStrategy = prepareLegalStrategy({
      task: 'drafting', courtType, circuit, opponentName,
      judicialWorkType: finalWorkType, selectedDocumentType: finalWorkType,
      clientRole, clientGoals: String(caseContext?.clientGoals || ''),
      sessionDate, caseNumber, facts: draftingFactsContext, defenses: draftingDefensesContext, requests: draftingRequestsContext,
      customInstructions: draftingCustomInstructionsContext, priorAnalysis: draftingPriorAnalysisContext,
      proceduralStage: String(caseContext?.proceduralStage || ''),
      proceduralStageSource: caseContext?.proceduralStageSource,
    });
    const draftingAnchorLedger = buildLegalAnchorLedger({
      task: 'drafting', courtType, circuit, clientName, clientRole, opponentName,
      caseNumber, sessionDate, judicialWorkType: finalWorkType,
      selectedDocumentType: finalWorkType, facts: draftingFactsContext,
      defenses: draftingDefensesContext, requests: draftingRequestsContext, customInstructions: draftingCustomInstructionsContext, priorAnalysis: draftingPriorAnalysisContext,
    }).slice(0, 1600);

    const legalResearch = /(?:بحث\s+(?:قانوني|عن|في)|تحقق\s+(?:من|من صحة)|مصادر\s+(?:رسمية|موثوقة)|أحكام\s+(?:النقض|الإدارية العليا)|المحكمة\s+الإدارية\s+العليا|رقم\s+طعن|رقم\s+الطعن|مبدأ\s+قضائي|سابقة\s+قضائية|نص\s+المادة|المادة\s+رقم|قانون\s+رقم|آخر\s+تعديل|أحدث\s+تعديل)/i.test([facts, defenses, requests, customInstructions].filter(Boolean).join(' '));

    const prompt = `[لغة الإخراج والتنسيق الإلزامية — أولوية قصوى]: اكتب المستند القانوني كله باللغة العربية فقط، بما في ذلك العناوين والديباجة وأي ملاحظات تحريرية. يُحظر إدراج كلمات أو تعليمات تنسيق باللغة الإنجليزية داخل المستند، مثل Centered Title أو Center Align أو Heading أو Bold أو Justify أو أي وصف لطريقة التنسيق. لا تكتب تعليمات التنسيق كنص؛ طبّق شكل العناوين وترتيبها مباشرةً باستخدام النص العربي وحده. احتفظ بالمصطلح الأجنبي فقط إذا كان اسماً رسمياً أو اختصاراً ضرورياً ورد في وقائع القضية، وليس لوصف التنسيق. لا تغيّر الديباجة العربية أو أسلوبها المستخلص من خزنة المحامي؛ المطلوب تنسيقها بالعربية لا ترجمتها أو شرحها. [مهمة إعداد وصياغة قانونية شاملة]: ${workTypeInstruction} المحكمة: ${courtType || 'المحكمة المختصة'} الدائرة: ${circuit || ''} الصفة التي حددها المحامي: ${clientRole || 'غير محددة صراحةً؛ لا تفترض أن الموكل هو المدعى عليه، واستدل من الوقائع فقط إذا كانت واضحة، وإلا نبّه إلى ضرورة تحديد الصفة'} (${clientName ? `السيد / ${clientName}` : 'الموكل'}) الخصم: ${opponentName || 'الخصم'} رقم الدعوى: ${caseNumber || ''} الجلسة: ${sessionDate || ''} الوقائع والمعلومات الحالية: ${draftingFactsContext}\n\n${draftingPriorAnalysisContext ? `[التحليل القانوني السابق للقضية الحالية]:\\n${draftingPriorAnalysisContext}\\n` : ''} ${defenses ? `أوجه الدفاع والدفوع التي أدخلها المحامي:\n${draftingDefensesContext}\n` : ''} ${requests ? `الطلبات التي أدخلها المحامي:\n${draftingRequestsContext}\n` : ''} ${customInstructions ? `[تعليمات إضافية]:\n${draftingCustomInstructionsContext}\n` : ''} ${vaultContext ? `\n[خزانة المحامي — أسلوب وبنية فقط، لا تستورد منها وقائع أو أرقاماً]:\n${draftingVaultContext}\n` : ''} قبل الصياغة نفّذ داخلياً: - فحص اكتمال الوقائع وتحديد أي معلومات جوهرية ناقصة. - تحديد نوع المستند القانوني المطلوب أو الأنسب أولاً، وعدم افتراض أن كل رد يجب أن يكون مذكرة دفاع. - تحديد التكييف القانوني الأرجح وأي تكييف بديل ذي أثر. - استخراج أقوى الدفوع والأسانيد المرتبطة بالوقائع. - فحص الصفة والمصلحة والاختصاص والإجراءات والمواعيد متى كانت ذات صلة. - مطابقة كل دفع مع الواقعة والمستند/الدليل المتاح. - تحديد التناقضات أو نقاط الضعف إن وجدت. - ترتيب النقاط بحسب أثرها القانوني والإثباتي: معالجة الجوهرية، ودمج المساندة، وعدم إنشاء رد مستقل على الهامشية إلا إذا كان لها أثر حقيقي. - بناء الطلبات الختامية من النتيجة التي انتهى إليها التحليل فقط، ومطابقة كل طلب صراحةً مع طلبات المحامي ووقائع القضية والدفوع والأسباب والنتيجة النهائية. - الالتزام الصارم بنطاق الطلبات التي أدخلها المحامي: لا تضف أو تحذف أو تستبدل أو توسّع طلباً قضائياً من تلقاء نفسك. يجوز تحسين الصياغة وترتيب الطلبات المحددة فقط مع الحفاظ على مضمونها. - إذا ظهر طلب إضافي قد يكون مهماً، فاذكره في تنبيه منفصل للمحامي ولا تدرجه في الطلبات الختامية إلا إذا فوّضك صراحةً في تحديد الطلبات أو وافق عليه. - إذا لم يحدد المحامي طلباته وتركها للنظام صراحةً، فاقترح الطلبات الضرورية فقط التي تسندها الوقائع والمستندات والتكييف القانوني، ولا تفترض تفويضاً لم يمنحه. - راجع أن كل طلب ختامي يطابق طلباً حدده المحامي أو تفويضاً صريحاً منه، وأنه لم يُحذف أي طلب أدخله. لا تعتبر احتمال أهمية طلب إضافي إذناً بإدراجه تلقائياً. [أولوية نوع المستند وبصمة المحامي — أولوية قصوى]: حدد أولاً نوع المستند المطلوب كما طلبه المحامي، ثم التزم بالبنية والأقسام والبيانات الإجرائية التي يقتضيها هذا النوع وفق الفرع القانوني وجهة القضاء. لا تسمح لنموذج من نوع مختلف بتغيير نوع المستند أو المحكمة المختصة أو هيكله؛ فمثلاً لا تُنشئ صحيفة دعوى مدنية في صورة دعوى إدارية لمجرد أن النموذج المتاح إداري. إذا توفر نموذج من النوع نفسه، استفد من بنيته المناسبة. وإذا لم يتوفر، أنشئ البنية القانونية الصحيحة من الصفر وفق المتعارف عليه، واستفد من بقية نماذج الخزانة لاستخلاص أسلوب المحامي وصوته المهني وطريقة صياغته وعرضه للوقائع والحجج فقط، لا لاستعارة هيكل مستند مختلف. حافظ على بصمة المحامي في الحالتين، مع تقديم صحة نوع المستند على التشابه الشكلي مع أي نموذج. تعامل مع وقائع الدعوى الحالية والطلبات والدفوع التي أدخلها المحامي باعتبارها مصدر المحتوى الموضوعي. [Zero Chatter — منع الثرثرة]: أخرج المستند القانوني وحده، وابدأ فوراً من أول سطر في الديباجة القانونية كما ورد نمطها في القالب؛ ممنوع أي مقدمة أو تحية أو تمهيد أو شرح لطريقة العمل أو عبارة مثل «إليك الصياغة» أو أي خاتمة محادثية. لا تضع ملاحظات خارج المستند إلا عند ضرورة تحقق قانوني محددة، وعندها افصلها بوضوح عن نص المستند ولا تخلطها بالديباجة أو الطلبات الختامية. استخلص الدفوع والتحليل للقضية الحالية استقلالاً، ولا تنقل وقائع القضية المرجعية أو أسماء أطرافها أو أرقامها أو تواريخها أو طلباتها الخاصة. يجوز استخدام اسم المكتب والترويسة والتوقيع الثابت الوارد في النموذج المرجعي إذا كان واضحاً، مع عدم اختراع بيانات أو نقل بيانات القضية القديمة. لا تدّعِ أن المرجع غير موجود؛ النص المرجعي مرفق داخل سياق الخزانة. اعتمد في مضمون المستند حصراً على مدخلات القضية الحالية ومستنداتها والطلبات التي حددها المستخدم. لا تفرض هيكل نوع مستند آخر؛ التزم حرفياً بنوع العمل القضائي المطلوب حالياً، سواء كان صحيفة دعوى أو مذكرة أو إعادة إعلان أو إنذاراً أو غير ذلك. إذا لم يوجد في الخزنة نموذج من النوع نفسه، استخدم أقرب مرجع اختير وفق نوع المستند والفرع القانوني وجهة القضاء، مع الاقتداء بأسلوب المحامي وترويسته وبنائه العام وتكييف هيكل المستند ليتفق مع نوع العمل الحالي. لا تذكر للمستخدم أنك استخدمت الخزنة أو تشرح آلية استخلاص البصمة. لا تختصر نقطة مؤثرة، ولا تُطِل في نقطة لا تحتاج إلى تفصيل؛ اجعل التفصيل تابعاً لحاجة القضية. لا تفصل «الأسانيد القانونية» كقسم مستقل؛ ضع القاعدة القانونية داخل سياق الحجة في موضعها الطبيعي. لا تضف واقعة أو مستنداً أو اسماً أو تاريخاً غير موجود. إذا كانت نقطة جوهرية تحتاج تحققاً، ضع تنبيهاً واضحاً للمحامي بدلاً من اختلاقها. لا تذكر حكماً أو رقم طعن أو مادة قانونية إلا إذا كانت موثوقة في السياق المتاح؛ وإلا اذكر أن التحقق مطلوب. وفي النهاية راجع المسودة داخلياً مرة أخرى بحثاً عن أي واقعة أو مستند أو دفع أو طلب أو تناقض تم إغفاله قبل إخراج النص النهائي. لا تعتبر المذكرة مكتملة إذا انتهى الإخراج قبل إتمام بنيتها المطلوبة؛ أكمل جميع الأقسام اللازمة لنوع المستند، ولا تتوقف عند الملخص أو منتصف الحجة أو قبل الطلبات الختامية. إذا كان النص طويلاً، حافظ على نفس مستوى التحليل وأكمل حتى النهاية بدلاً من اختزال الأجزاء الأخيرة.`;

    // Continuations receive a compact strategy/anchor ledger, not the full
    // original prompt again. The original remains in the persisted task payload.
    const continuationContext = [
      '[سياق استكمال مضغوط — مرجع للقضية الحالية]',
      workTypeInstruction,
      `بيانات القضية: المحكمة ${courtType || ''}؛ الدائرة ${circuit || ''}؛ الموكل ${clientName || ''}؛ الصفة ${clientRole || ''}؛ الخصم ${opponentName || ''}؛ الدعوى ${caseNumber || ''}؛ الجلسة ${sessionDate || ''}`,
      '[مراسي الوقائع والأرقام والمراجع — فهرس تحقق لا يحل محل الأصل]',
      draftingAnchorLedger,
      '[ركائز الاستراتيجية القانونية]',
      draftingStrategy.context,
      '[دفوع المحامي المحددة]', draftingDefensesContext.slice(0, 1200),
      '[طلبات المحامي المحددة — لا تغيّر]', draftingRequestsContext.slice(0, 1400),
      '[تعليمات المحامي]', draftingCustomInstructionsContext.slice(0, 1200),
      '[التحليل السابق — مقتطف توجيهي]', String(draftingPriorAnalysisContext || '').slice(0, 1200),
      '[بصمة المحامي — أسلوب وبناء فقط]', String(draftingVaultContext || '').slice(0, 1200),
      'المصدر الأصلي محفوظ في بيانات المهمة. هذا الفهرس ليس حصراً لكل معلومة؛ عند الحاجة إلى نص أو رقم غير ظاهر، ارجع إلى المصدر الأصلي ولا تخمّن. أكمل من آخر موضع دون تكرار النص المكتمل، مع الحفاظ على التكييف والدفوع والطلبات والهدف النهائي.'
    ].join('\n\n').slice(0, 7500);
    console.info('[counter-brief] final prompt section sizes', {
      facts: draftingFactsContext.length,
      anchorLedger: draftingAnchorLedger.length,
      strategy: draftingStrategy.context.slice(0, 1400).length,
      defenses: draftingDefensesContext.slice(0, 650).length,
      requests: draftingRequestsContext.slice(0, 900).length,
      instructions: draftingCustomInstructionsContext.slice(0, 500).length,
      priorAnalysis: String(draftingPriorAnalysisContext || '').slice(0, 650).length,
      vaultStyle: String(draftingVaultContext || '').slice(0, 500).length,
    });
    assertDraftingInputBudget(prompt);
    assertDraftingInputBudget(continuationContext);

    if (body?.stream === true) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      // Keep the Vercel stream active while Gemini prepares its first token.
      // Otherwise a slow first token can surface in the browser as
      // "Failed to fetch" when the upstream connection is terminated.
      res.write(JSON.stringify({ type: 'start' }) + '\n');
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) {
          res.write(JSON.stringify({ type: 'keepalive' }) + '\n');
        }
      }, 5000);

      let streamedAny = false;
      const writeChunk = (text: string) => {
        if (text) {
          streamedAny = true;
          res.write(JSON.stringify({ type: 'chunk', text }) + '\n');
        }
      };
      try {
        // Forward actual model chunks as they arrive. The generator keeps
        // handling continuation internally while the client sees live output.
        await generateDeepLegalResponse(prompt, writeChunk, { legalResearch, resumeText: typeof _resumePartialText === 'string' ? _resumePartialText : '', continuationContext, deadlineAt: draftingAnalysisDeadline });
        if (!streamedAny) throw new Error('لم تُنتج خدمة الذكاء الاصطناعي نتيجة صالحة.');
        await consumeOperation(req, 'gemini-operation');
        res.write(JSON.stringify({ type: 'done' }) + '\n');
        return res.end();
      } catch (streamErr: any) {
        if (!res.writableEnded) {
          res.write(JSON.stringify({ type: 'error', error: streamErr?.message || 'فشلت الاستجابة المتدفقة.' }) + '\n');
          return res.end();
        }
        return;
      } finally {
        clearInterval(heartbeat);
      }
    }

    const resultText = await generateDeepLegalResponse(prompt, undefined, { legalResearch, resumeText: typeof _resumePartialText === 'string' ? _resumePartialText : '', continuationContext, deadlineAt: draftingAnalysisDeadline });
    if (!resultText.trim()) throw new Error('لم تُنتج خدمة الذكاء الاصطناعي نتيجة صالحة.');
    const usage = await consumeOperation(req, 'gemini-operation');
    return res.json({ result: resultText, remainingCredits: usage.remainingCredits, trialRemaining: usage.trialRemaining });
  } catch (err: any) {
    console.error('Error in /api/gemini/counter-brief:', err);
    const statusCode = Number(err?.statusCode);
    const status = Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600
      ? statusCode
      : 500;
    if (!res.headersSent) {
      if (err?.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
      return res.status(status).json({ error: err.message || 'فشلت الصياغة.' });
    }
    if (!res.writableEnded) {
      res.write(JSON.stringify({ type: 'error', error: err.message || 'فشلت الصياغة.' }) + '\n');
      return res.end();
    }
  }
}
