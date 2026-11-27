import { ThinkingLevel } from '@google/genai';
import { executeWithKeyRotation, executeWithKeyRotationStream } from '../keyRotation.ts';

import { enforceAiCooldown, consumeOperation } from '../auth.ts';
import { rateLimit, limitBodyString } from '../security.ts';
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


/**
 * Prepare a compact drafting context locally before the first actual drafting
 * request. Do not spend Gemini quota on a separate summarization pass.
 *
 * The local selector is intentionally conservative and deterministic: it
 * preserves exact excerpts, prioritizes lawyer-provided defenses/requests and
 * legally anchored sentences, and keeps source order in the final pack.
 * It does not claim to replace legal judgment; the model must identify any
 * material missing fact rather than inventing it.
 */
function createDraftingContextPack(sources: Array<{ label: string; text: string }>, maxCaseContextChars = 15500): string {
  const vault = sources.find((source) => /خزانة المحامي/.test(source.label));
  const caseSources = sources
    .filter((source) => !/خزانة المحامي/.test(source.label))
    .map((source) => ({ label: source.label, text: String(source.text || '').trim() }))
    .filter((source) => source.text);

  const vaultText = String(vault?.text || '').trim();
  const styleSample = vaultText
    ? `[نموذج أسلوب وبنية من خزانة المحامي — دون وقائع قضية أخرى]\n${vaultText.slice(0, 3000)}`
    : '';
  const MAX_CASE_CONTEXT_CHARS = Math.max(1000, Math.min(15500, Math.floor(maxCaseContextChars)));
  const priorityLabels = /دفوع المحامي|طلبات المحامي|تعليمات المحامي/i;
  const legalAnchor = /(?:\d{1,4}[\/\-]\d{1,4}|\d{4}|\d+(?:[.,]\d+)?\s*(?:جنيه|قرش|متر|سهم|٪|%))|(?:مادة|قانون|طعن|حكم|دعوى|محضر|عقد|إقرار|تقرير|جلسة|مدعى|المدعى|الخصم|دفع|طلب|إثبات|إخطار|إنذار|تاريخ|وفاة|تسليم|استلام|تزوير|بطلان|اختصاص|تقادم|ميعاد|مستند|شاهد|خبير|مصلحة|صفة|ملكية|حيازة|تعويض)/i;

  const candidates: Array<{ sourceIndex: number; sentenceIndex: number; label: string; text: string; score: number }> = [];
  caseSources.forEach((source, sourceIndex) => {
    const parts = source.text
      .replace(/\r/g, '')
      .split(/(?<=[.!؟؛])\s+|\n{1,}/)
      .map((part) => part.trim())
      .filter(Boolean);
    parts.forEach((part, sentenceIndex) => {
      const normalized = part.replace(/\s+/g, ' ');
      if (!normalized) return;
      let score = 0;
      if (priorityLabels.test(source.label)) score += 100;
      if (legalAnchor.test(normalized)) score += 24;
      if (/\d/.test(normalized)) score += 12;
      if (/(?:أولاً|ثانياً|ثالثاً|رابعاً|خامساً|الوقائع|الطلبات|الدفاع|الدفوع|النتيجة|لذلك|بناءً عليه)/i.test(normalized)) score += 10;
      if (normalized.length >= 40 && normalized.length <= 1200) score += 5;
      if (normalized.length > 2200) score -= 8;
      // Preserve the opening and closing context, where case identity and
      // operative requests commonly appear, without taking a large raw block.
      if (sentenceIndex < 3) score += 8;
      if (sentenceIndex >= parts.length - 3) score += 8;
      candidates.push({ sourceIndex, sentenceIndex, label: source.label, text: normalized, score });
    });
  });

  // First reserve explicit lawyer instructions, defenses, and requests.
  const selected = new Map<string, typeof candidates[number]>();
  let used = 0;
  const addCandidate = (candidate: typeof candidates[number], prefix = '') => {
    const key = `${candidate.sourceIndex}:${candidate.sentenceIndex}`;
    if (selected.has(key)) return;
    const text = prefix + candidate.text;
    if (used + text.length + 2 > MAX_CASE_CONTEXT_CHARS) return;
    selected.set(key, candidate);
    used += text.length + 2;
  };

  candidates
    .filter((candidate) => priorityLabels.test(candidate.label))
    .sort((a, b) => b.score - a.score || a.sourceIndex - b.sourceIndex || a.sentenceIndex - b.sentenceIndex)
    .forEach((candidate) => addCandidate(candidate));

  // Then take the strongest anchored excerpts, while retaining representation
  // from each source rather than letting one long attachment consume the pack.
  const bySource = new Map<number, typeof candidates>();
  candidates.forEach((candidate) => {
    const list = bySource.get(candidate.sourceIndex) || [];
    list.push(candidate);
    bySource.set(candidate.sourceIndex, list);
  });
  for (const [sourceIndex, list] of bySource.entries()) {
    list.sort((a, b) => b.score - a.score || a.sentenceIndex - b.sentenceIndex);
    list.slice(0, 8).forEach((candidate) => addCandidate(candidate));
  }
  candidates
    .sort((a, b) => b.score - a.score || a.sourceIndex - b.sourceIndex || a.sentenceIndex - b.sentenceIndex)
    .forEach((candidate) => addCandidate(candidate));

  const excerpts = Array.from(selected.values())
    .sort((a, b) => a.sourceIndex - b.sourceIndex || a.sentenceIndex - b.sentenceIndex);
  const grouped = new Map<string, string[]>();
  excerpts.forEach((excerpt) => {
    const list = grouped.get(excerpt.label) || [];
    list.push(excerpt.text);
    grouped.set(excerpt.label, list);
  });
  const casePack = Array.from(grouped.entries())
    .map(([label, items]) => `[مقتطفات منتقاة محليًا من: ${label}]\n${items.join('\n')}`)
    .join('\n\n');

  const pack = [
    '[العقل القانوني — سياق محلي منتقى من النص الأصلي. المقتطفات ليست تلخيصًا مولدًا من Gemini؛ تحقق من ترابطها، واذكر أي نقص جوهري، ولا تفترض أن الجزء غير المعروض غير موجود.]',
    casePack,
    styleSample,
  ].filter(Boolean).join('\n\n');

  console.info('[counter-brief] local legal context selection ready', {
    sourceCharacters: caseSources.reduce((sum, source) => sum + source.text.length, 0),
    selectedExcerptCount: excerpts.length,
    selectedCaseCharacters: used,
    packedCharacters: pack.length,
    geminiPreparationRequests: 0,
    controller: 'local-select-then-sequential-draft',
  });
  return pack;
}

function readDraftingState(value: unknown): { stage: number; initialDraft: string; legalDraft: string } {
  let parsed: any = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { parsed = null; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { stage: 0, initialDraft: '', legalDraft: '' };
  }
  const stage = Math.max(0, Math.min(2, Math.floor(Number(parsed.stage) || 0)));
  return {
    stage,
    initialDraft: typeof parsed.initialDraft === 'string' ? parsed.initialDraft : '',
    legalDraft: typeof parsed.legalDraft === 'string' ? parsed.legalDraft : '',
  };
}

function classifyGeminiFailure(error: any): string {
  const status = Number(error?.statusCode || error?.status || 0);
  const message = String(error?.message || error || '');
  if (status === 429 || /RESOURCE_EXHAUSTED/i.test(message)) {
    if (/TokensPerMinute|token.*per.?minute|TPM/i.test(message)) return 'quota_tokens_per_minute';
    if (/RequestsPerMinute|request.*per.?minute|RPM/i.test(message)) return 'quota_requests_per_minute';
    if (/RequestsPerDay|per.?day|RPD/i.test(message)) return 'quota_requests_per_day';
    return 'quota_or_rate_limit_unspecified';
  }
  if (status === 503 || status === 504 || /deadline|timed?\\s*out|temporarily unavailable/i.test(message)) return 'provider_or_function_timeout';
  if (status === 400 || /INVALID_ARGUMENT/i.test(message)) return 'request_or_context_invalid';
  return 'provider_error_other';
}

function redactProviderMessage(value: unknown): string {
  return String(value || 'unknown')
    .replace(/(?:AIza|AQ\\.)[0-9A-Za-z_.-]{20,}/g, '[REDACTED_KEY]')
    .replace(/\\bBearer\\s+[^\\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/https?:\\/\\/[^\\s\"'<>]+/gi, '[REDACTED_URL]')
    .replace(/[\\r\\n\\t]+/g, ' ')
    .slice(0, 500);
}

/** Finish reasons that represent a provider refusal/filter, not a normal continuation point. */
async function logDraftingPromptTokens(_ai: any, model: string, prompt: string, continuationCount: number, accumulatedCharacters: number, systemInstruction = EGYPTIAN_LEGAL_SYSTEM_INSTRUCTION): Promise<void> {
  // The key-rotation adapter exposes generation methods, not the SDK token-count endpoint.
  // Never call ai.models.countTokens here: estimate request size from characters only, non-blockingly.
  const systemCharacters = systemInstruction.length;
  console.info('[counter-brief] Gemini request size estimate', {
    model,
    promptCharacters: prompt.length,
    systemInstructionCharacters: systemCharacters,
    estimatedInputTokens: Math.ceil((prompt.length + systemCharacters) / 2),
    tokenEstimateMethod: 'conservative characters/2 heuristic; not provider token counting',
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

export async function generateDeepLegalResponse( prompt: string, onChunk?: (text: string) => void, options: { legalResearch?: boolean; resumeText?: string; resumeGeminiKey?: string; resumeGeminiModel?: string; continuationContext?: string; deadlineAt?: number; systemInstruction?: string; maxOutputTokens?: number } = {}, ): Promise<string> {
  // Performance-critical path: the previous implementation generated a full
  // hidden audit response and then sent a second full generation request for
  // the final answer. That doubled model latency and was especially noticeable
  // on long legal documents. The system instruction already requires internal
  // verification, so perform the review inside a single generation request.
  const completionMarker = '[[AMIN_STREAM_COMPLETE_9F7C2A]]';
  const systemInstruction = String(options.systemInstruction || EGYPTIAN_LEGAL_SYSTEM_INSTRUCTION);
  const outputTokenLimit = Number.isFinite(Number(options.maxOutputTokens)) && Number(options.maxOutputTokens) > 0
    ? Math.min(32768, Math.floor(Number(options.maxOutputTokens)))
    : (onChunk ? 8192 : 32768);
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

  const continuationBasePrompt = String(options.continuationContext || '');
  const makeContinuationPrompt = () => accumulatedText
    ? '[استكمال مستند قانوني — لا تعِد إرسال أو إعادة تحليل المستندات الأصلية] ' +
      (continuationBasePrompt ? continuationBasePrompt + '\\n' : '') +
      'النص السابق محفوظ بالكامل في المهمة. هذا آخر جزء منه للربط فقط؛ ما قبله مكتمل ولا تعِد كتابته: ' +
      accumulatedText.slice(-8000) +
      '\\n\\nتابع من آخر جملة مباشرة، وأكمل الأقسام والحجج والطلبات والخاتمة التي لم تُكتب بعد. لا تكرر السابق ولا تختصر ما تبقى. التزم بالوقائع والطلبات والأسماء والأرقام التي ظهرت في النص السابق. إذا احتجت إلى معلومة غير موجودة، اذكر أنها تحتاج تحققاً ولا تخترعها. أضف علامة الاكتمال ' +
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

          await logDraftingPromptTokens(ai, model, segmentPrompt, continuationCount, accumulatedText.length, systemInstruction);
          return (async function* () {
            let pendingMarkerTail = '';
            let receivedText = false;
            const stream = await ai.models.generateContentStream({
              model,
              contents: segmentPrompt,
              config: {
                systemInstruction,
                temperature: 0.15,
                maxOutputTokens: outputTokenLimit,
                ...(providerSearchEnabled ? { tools: [{ googleSearch: {} }] } : {}),
                thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
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
        await logDraftingPromptTokens(ai, model, segmentPrompt, continuationCount, accumulatedText.length, systemInstruction);
        const response = await ai.models.generateContent({
          model,
          contents: segmentPrompt,
          config: {
            systemInstruction,
            temperature: 0.15,
            maxOutputTokens: outputTokenLimit,
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

    const draftingAnalysisDeadline = Date.now() + 270000;
    const draftingContextPack = createDraftingContextPack([
      { label: 'وقائع القضية والمستندات', text: facts },
      { label: 'دفوع المحامي', text: defenses || '' },
      { label: 'طلبات المحامي', text: requests || '' },
      { label: 'تعليمات المحامي الإضافية', text: customInstructions || '' },
      { label: 'التحليل القانوني السابق', text: typeof caseAnalysisContext === 'string' ? caseAnalysisContext : '' },
      { label: 'خزانة المحامي — أسلوب وبنية فقط', text: typeof vaultContext === 'string' ? vaultContext : '' },
    ]);
    const draftingFactsContext = draftingContextPack;
    // Selected excerpts from the user-provided sources are incorporated into this bounded pack.
    // Do not resend their raw forms in the final generation or continuation.
    const draftingPriorAnalysisContext = '';
    const draftingDefensesContext = 'تم تضمين دفوع المحامي في حزمة السياق القانوني المختصرة أعلاه.';
    const draftingRequestsContext = 'تم تضمين طلبات المحامي في حزمة السياق القانوني المختصرة أعلاه؛ التزم بها دون إضافة أو حذف.';
    const draftingInstructionsContext = 'تم تضمين تعليمات المحامي في حزمة السياق القانوني المختصرة أعلاه.';

    const legalResearch = /(?:بحث\s+(?:قانوني|عن|في)|تحقق\s+(?:من|من صحة)|مصادر\s+(?:رسمية|موثوقة)|أحكام\s+(?:النقض|الإدارية العليا)|المحكمة\s+الإدارية\s+العليا|رقم\s+طعن|رقم\s+الطعن|مبدأ\s+قضائي|سابقة\s+قضائية|نص\s+المادة|المادة\s+رقم|قانون\s+رقم|آخر\s+تعديل|أحدث\s+تعديل)/i.test([facts, defenses, requests, customInstructions].filter(Boolean).join(' '));

    // Durable legal-brain stages: one Gemini call-chain at a time, with a saved checkpoint between stages.
    // The first pass receives case facts only; lawyer strategy and vault style are deliberately deferred.
    if (body?.stream === true && body?._jobId) {
      const savedState = readDraftingState(body?._draftingState);
      const stage = savedState.stage;
      const caseOnlyPack = createDraftingContextPack([
        { label: 'وقائع القضية والمستندات', text: facts },
      ], 9000);
      const lawyerInstructionPack = createDraftingContextPack([
        { label: 'دفوع المحامي', text: defenses || '' },
        { label: 'طلبات المحامي', text: requests || '' },
        { label: 'تعليمات المحامي الإضافية', text: customInstructions || '' },
        { label: 'التحليل القانوني السابق', text: typeof caseAnalysisContext === 'string' ? caseAnalysisContext : '' },
      ], 4800);
      const vaultStyleSample = String(vaultContext || '').trim().slice(0, 3000);
      const caseMetadata = [
        workTypeInstruction,
        'المحكمة: ' + (courtType || 'المحكمة المختصة') + ' | الدائرة: ' + (circuit || ''),
        'الموكل وصفته: ' + (clientName || 'غير محدد') + ' — ' + (clientRole || 'غير محدد'),
        'الخصم: ' + (opponentName || 'غير محدد') + ' | رقم الدعوى: ' + (caseNumber || '') + ' | الجلسة: ' + (sessionDate || ''),
      ].join('\\n');
      const stageDeadline = draftingAnalysisDeadline;
      const baseDraftSystem = 'أنت محرر قانوني مصري. أنشئ مسودة أولية كاملة من الوقائع والمستندات المعروضة فقط. لا تضف دفوعاً استراتيجية أو تعليمات خاصة غير موجودة في هذه المرحلة، ولا تستخدم نموذج خزانة أو وقائع قضية أخرى. لا تختلق أسماء أو تواريخ أو أرقاماً أو مواد قانونية. إذا كانت معلومة لازمة غير موجودة، ضع تنبيهاً موجزاً داخل المسودة بأنها تحتاج استكمالاً. اكتب المستند المطلوب بالعربية القانونية المصرية، ثم أضف علامة الاكتمال التي يحددها طلب المستخدم في آخر النص.';
      const styleOnlySystem = 'أنت محرر قانوني مصري متخصص في ضبط أسلوب وبناء المستند. لا تغيّر الوقائع أو الأسماء أو التواريخ أو المبالغ أو الأرقام أو الطلبات أو الأسانيد التي سبق تدقيقها. استخدم نموذج الخزانة للأسلوب والبناء فقط، ولا تنقل منه أي بيانات لقضية أخرى. لا تضف معلومة جديدة ولا تحذف نقطة جوهرية. أخرج المستند كاملاً.';
      const yieldAfterCheckpoint = (nextState: { stage: number; initialDraft?: string; legalDraft?: string }) => {
        res.write(JSON.stringify({ type: 'checkpoint', state: nextState }) + '\\n');
        res.write(JSON.stringify({ type: 'yield' }) + '\\n');
        return res.end();
      };

      if (stage === 0) {
        const basePrompt = '[المرحلة الأولى من العقل القانوني — مسودة الوقائع فقط]\\n' +
          '[بيانات القضية]\\n' + caseMetadata +
          '\\n\\n[وقائع القضية والمستندات — مقتطفات محلية منتقاة]\\n' + caseOnlyPack +
          '\\n\\nاكتب المسودة الأولية الكاملة لنوع المستند المطلوب اعتماداً على الوقائع أعلاه وحدها. لا تُدخل في هذه المرحلة دفوعاً أو طلبات أو تعليمات استراتيجية منفصلة، ولا تستخدم التحليل السابق أو الخزانة. احفظ كل واقعة جوهرية وكل اسم وتاريخ ومبلغ ورقم وارد. إذا كان النص كبيراً، نظّم المستند بعناوين واضحة دون تكرار. أخرج المستند فقط بين [[AMIN_DOCUMENT]] و[[/AMIN_DOCUMENT]]، ثم علامة الاكتمال.';
        const initialDraft = await generateDeepLegalResponse(basePrompt, undefined, {
          legalResearch: false,
          systemInstruction: baseDraftSystem,
          maxOutputTokens: 8192,
          deadlineAt: stageDeadline,
          continuationContext: '[استكمال المسودة الأولية من الوقائع فقط. لا تضف دفوعاً أو استراتيجية أو نموذج خزانة. أكمل من آخر جزء دون إعادة السابق.]',
        });
        if (!initialDraft.trim()) throw new Error('لم تُنتج المرحلة الأولى مسودة أولية صالحة.');
        return yieldAfterCheckpoint({ stage: 1, initialDraft });
      }

      if (stage === 1) {
        if (!savedState.initialDraft.trim()) throw new Error('نقطة حفظ المرحلة الأولى مفقودة؛ أعد تشغيل الصياغة من البداية.');
        const legalPrompt = '[المرحلة الثانية من العقل القانوني — تطبيق دفوع وتعليمات المحامي]\\n' +
          '[بيانات القضية]\\n' + caseMetadata +
          '\\n\\n[المسودة الأولية المحفوظة]\\n' + savedState.initialDraft +
          '\\n\\n[دفوع المحامي وطلباته وتعليماته والتحليل السابق — مقتطفات منتقاة]\\n' + lawyerInstructionPack +
          '\\n\\nراجع المسودة كاملةً وطبّق دفوع المحامي وطلباته وتعليماته والاستنتاجات المدعومة من التحليل السابق. اختبر قوة موقف الخصم والتناقضات والنواقص، وصحح ما يلزم دون اختلاق. لا تضف أو تحذف أو توسّع طلباً قضائياً حدده المحامي. لا تستخدم الخزانة في هذه المرحلة. أخرج توصية مهنية موجزة بين [[AMIN_STRATEGY]] و[[/AMIN_STRATEGY]] ثم المستند الكامل بين [[AMIN_DOCUMENT]] و[[/AMIN_DOCUMENT]]، مع علامة الاكتمال في النهاية.';
        const legalDraft = await generateDeepLegalResponse(legalPrompt, undefined, {
          legalResearch,
          systemInstruction: EGYPTIAN_LEGAL_SYSTEM_INSTRUCTION,
          maxOutputTokens: 8192,
          deadlineAt: stageDeadline,
          continuationContext: '[استكمال مرحلة تطبيق الدفوع والتعليمات على المسودة المحفوظة. لا تعِد المسودة من البداية، ولا تستخدم نموذج الخزانة. حافظ على الطلبات المحددة وأكمل المستند كله.]',
        });
        if (!legalDraft.trim()) throw new Error('لم تُنتج المرحلة الثانية نتيجة قانونية صالحة.');
        return yieldAfterCheckpoint({ stage: 2, legalDraft });
      }

      if (!savedState.legalDraft.trim()) throw new Error('نقطة حفظ المرحلة القانونية مفقودة؛ أعد تشغيل الصياغة من البداية.');
      const stylePrompt = '[المرحلة الثالثة من العقل القانوني — ضبط الأسلوب والبنية فقط]\\n' +
        '[المسودة القانونية المدققة من المرحلة السابقة — المرجع الوحيد للوقائع والطلبات]\\n' + savedState.legalDraft +
        '\\n\\n[نموذج أسلوب وبنية من خزانة المحامي — لا تنقل وقائع أو أسماء أو أرقاماً]\\n' + vaultStyleSample +
        '\\n\\nاضبط الصياغة النهائية لتقترب من أسلوب وبناء النموذج الشخصي فقط، مع الحفاظ على مضمون المسودة القانونية المدققة كاملةً. لا تضف أو تحذف دفاعاً أو طلباً أو واقعة أو سنداً. أخرج التوصية المهنية والمستند كاملاً بنفس العلامات [[AMIN_STRATEGY]] و[[AMIN_DOCUMENT]]، وأضف علامة الاكتمال في آخر النص فقط.';
      let finalStreamedAny = false;
      const finalText = await generateDeepLegalResponse(stylePrompt, (text) => {
        if (!text) return;
        finalStreamedAny = true;
        res.write(JSON.stringify({ type: 'chunk', text }) + '\\n');
      }, {
        legalResearch: false,
        systemInstruction: styleOnlySystem,
        maxOutputTokens: 8192,
        resumeText: typeof _resumePartialText === 'string' ? _resumePartialText : '',
        deadlineAt: stageDeadline,
        continuationContext: '[استكمال المرحلة النهائية لضبط الأسلوب فقط. حافظ على النص الذي وصل بالفعل، واستكمل المستند دون تكراره. لا تغير الوقائع أو الطلبات أو الدفوع المدققة. نموذج الأسلوب: ' + vaultStyleSample.slice(0, 1800) + '\\nالمسودة القانونية المرجعية (مقتطف تعريف وربط): ' + savedState.legalDraft.slice(0, 2500) + ']',
      });
      if (!finalText.trim()) throw new Error('لم تُنتج المرحلة النهائية مستنداً صالحاً.');
      await consumeOperation(req, 'gemini-operation');
      res.write(JSON.stringify({ type: 'done' }) + '\\n');
      return res.end();
    }

    const prompt = `[مهمة الصياغة القانونية]
اكتب بالعربية القانونية المصرية فقط، ولا تضع كلمات إنجليزية لوصف التنسيق. التزم بنوع المستند الذي حدده المحامي؛ لا تفترض تلقائياً أنه مذكرة دفاع. إذا لم يحدد النوع، استنتج الأنسب من الغرض والمرحلة والوقائع، ونبّه إذا تعذر الحسم.

[بيانات المهمة]
${workTypeInstruction}
المحكمة: ${courtType || 'المحكمة المختصة'} | الدائرة: ${circuit || ''}
الموكل وصفته: ${clientName || 'غير محدد'} — ${clientRole || 'الصفة تحتاج تحديداً إذا لم تحسمها الوقائع'}
الخصم: ${opponentName || 'غير محدد'} | رقم الدعوى: ${caseNumber || ''} | الجلسة: ${sessionDate || ''}

[مقتطفات منتقاة من الوقائع والمستندات — راجع الترابط ولا تعتبر غير المقتبس غير موجود]
${draftingFactsContext}

[دفوع المحامي]
${draftingDefensesContext}

[طلبات المحامي — التزم بها دون إضافة أو حذف أو توسيع]
${draftingRequestsContext}

[تعليمات المحامي الإضافية]
${draftingInstructionsContext}

${draftingPriorAnalysisContext ? `[تحليل سابق مرتبط بالقضية]
${draftingPriorAnalysisContext}
طابقه مع الوقائع الحالية، ولا تنقل منه معلومة أو دفعاً أو طلباً دون التحقق من سنده، وقدّم البيانات الحالية عند التعارض.` : ''}

[مرجع الخزانة] تم استخلاص الأسلوب والبنية ضمن حزمة السياق المختصرة أعلاه؛ لا تستخدم أي وقائع من قضايا أخرى.

[منهج التنفيذ]
طبّق قواعد العمل القانونية الثابتة في تعليمات النظام على كامل ملف القضية، واختر نوع المستند وهيكله وفق المهمة وبصمة النموذج المرجعي المختار، دون إسقاط واقعة أو إضافة طلب غير مفوض.

[تنسيق الإخراج]
أخرج أولاً توصية مهنية موجزة بين [[AMIN_STRATEGY]] و[[/AMIN_STRATEGY]] تتضمن الإجراء الأنسب وسببه والنقطة الحاسمة والمخاطر والخطوة التالية، دون كشف التفكير الداخلي.
ثم أخرج المستند وحده بين [[AMIN_DOCUMENT]] و[[/AMIN_DOCUMENT]]، وابدأ مباشرة بديباجته المناسبة. لا تخلط التوصية بمتن المستند. أكمل جميع أقسام نوع المستند والطلبات والخاتمة اللازمة، ولا تتوقف عند منتصفه.`;

    const continuationContext = [
      '[سياق استكمال مختصر — مرجع القضية الحالي]',
      workTypeInstruction,
      `المحكمة: ${courtType || ''}؛ الدائرة: ${circuit || ''}؛ الموكل: ${clientName || ''}؛ الصفة: ${clientRole || ''}؛ الخصم: ${opponentName || ''}؛ رقم الدعوى: ${caseNumber || ''}؛ الجلسة: ${sessionDate || ''}`,
      'تم إرسال مقتطفات مختارة من الوقائع والدفوع والطلبات والتحليل ونموذج الأسلوب في الطلب الأول؛ لا تعِد إرسالها أو إعادة تلخيصها.',
      'التزم بطلبات المحامي المحددة في الطلب الأول دون إضافة أو حذف أو توسيع.',
      'التزم بالنوع والطلبات المحددة، ولا تختلق وقائع أو أسانيد. أكمل المستند من حيث انتهى النص السابق وبنفس بصمة المحامي.'
    ].join('\n\n');

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
    console.error('Error in /api/gemini/counter-brief:', JSON.stringify({
      category: classifyGeminiFailure(err),
      status: Number(err?.statusCode || err?.status || 0),
      retryAfter: err?.retryAfter || null,
      providerMessage: redactProviderMessage(err?.message || err),
    }));
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
