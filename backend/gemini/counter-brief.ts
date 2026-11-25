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

  const continuationBasePrompt = String(options.continuationContext || optimizedPrompt);
  const makeContinuationPrompt = () => accumulatedText
    ? continuationBasePrompt + ' [استكمال إلزامي] هذا آخر مقطع من النص السابق للربط؛ ما قبله مكتمل ولا تعِد كتابته: ' +
      accumulatedText.slice(-3000) +
      '\n\nتابع مباشرة من آخر موضع، وأكمل بقية أقسام المستند والطلبات والخاتمة دون تكرار. حافظ على الوقائع والطلبات المحددة وبصمة المحامي. أضف علامة الاكتمال ' +
      completionMarker + ' في نهاية المستند فقط بعد إتمامه بالكامل.'
    : optimizedPrompt;

  if (onChunk) {
    let completed = false;
    while (continuationCount <= maxContinuations && Date.now() < deadlineAt) {
      const segmentPrompt = makeContinuationPrompt();
    assertDraftingInputBudget(segmentPrompt);
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
                maxOutputTokens: DRAFTING_MAX_OUTPUT_TOKENS,
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
    assertDraftingInputBudget(segmentPrompt);
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
            maxOutputTokens: DRAFTING_MAX_OUTPUT_TOKENS,
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

const DRAFTING_INPUT_CHUNK_CHARS = 8000;
const DRAFTING_MAX_INPUT_CHUNKS = 12;
const DRAFTING_MAX_SOURCE_CHARS = DRAFTING_INPUT_CHUNK_CHARS * DRAFTING_MAX_INPUT_CHUNKS;
const DRAFTING_MAX_INPUT_TOKENS = 6000;
const DRAFTING_MAX_OUTPUT_TOKENS = 4096;

function splitDraftingSource(text: string, maxChars = DRAFTING_INPUT_CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of String(text || '').split(/\n{2,}/)) {
    let remaining = paragraph;
    while (remaining.length > maxChars) {
      const boundary = Math.max(
        remaining.lastIndexOf('\n', maxChars),
        remaining.lastIndexOf('。', maxChars),
        remaining.lastIndexOf('.', maxChars),
        remaining.lastIndexOf('؛', maxChars),
        remaining.lastIndexOf(' ', maxChars),
      );
      const cut = boundary > Math.floor(maxChars * 0.6) ? boundary + 1 : maxChars;
      const piece = remaining.slice(0, cut).trim();
      if (piece) chunks.push(piece);
      remaining = remaining.slice(cut).trim();
    }
    if (!remaining) continue;
    const candidate = current ? current + '\n\n' + remaining : remaining;
    if (candidate.length > maxChars) {
      if (current.trim()) chunks.push(current.trim());
      current = remaining;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

async function compactDraftingSource(source: string, label: string, deadlineAt: number): Promise<string> {
  const original = String(source || '');
  if (original.length <= DRAFTING_INPUT_CHUNK_CHARS) return original;
  const chunks = splitDraftingSource(original);
  if (chunks.length > DRAFTING_MAX_INPUT_CHUNKS) {
    const error: any = new Error('هذا النص يحتاج إلى أكثر من 12 جزءاً. قلّل حجمه أو أرسله على مراحل؛ لم تُحذف أي معلومات.');
    error.status = 413;
    error.statusCode = 413;
    throw error;
  }
  const summaries: string[] = [];
  for (let index = 0; index < chunks.length; index++) {
    if (Date.now() >= deadlineAt - 5000) {
      const error: any = new Error('انتهت مهلة تجهيز أجزاء المستند قبل بدء الصياغة.');
      error.status = 504;
      error.statusCode = 504;
      throw error;
    }
    const sourceChunk = chunks[index];
    const summary = await executeWithKeyRotation(async (ai, _key, model) => {
      const response = await ai.models.generateContent({
        model,
        contents: '[مهمة تجهيز مدخلات الصياغة القانونية]\nاستخرج سجلاً مركزاً ودقيقاً من هذا الجزء فقط، في حدود 200 token تقريباً. احتفظ بكل اسم وصفة وتاريخ ورقم ومبلغ وطلب ومستند ودليل وادعاء ونفي وتناقض وتسلسل زمني. ميّز الادعاء عن الثابت، ولا تستنتج ولا تضف قانوناً أو واقعة. لا تسقط معلومة قد تؤثر في النزاع. اكتب بالعربية وبنقاط موجزة. الجزء ' + (index + 1) + ' من ' + chunks.length + ':\n\n' + sourceChunk,
        config: {
          systemInstruction: EGYPTIAN_LEGAL_SYSTEM_INSTRUCTION,
          temperature: 0.1,
          maxOutputTokens: 256,
          thinkingConfig: { thinkingLevel: 'low' },
        },
      });
      const text = typeof response.text === 'string' ? response.text.trim() : '';
      const finishReason = String(response?.candidates?.[0]?.finishReason || '').toUpperCase();
      if (!text || isBlockedFinishReason(finishReason) || finishReason === 'MAX_TOKENS') {
        const error: any = new Error('تعذر استخراج سجل كامل من الجزء ' + (index + 1) + ' من ' + label + '.');
        error.status = 502;
        error.statusCode = 502;
        throw error;
      }
      return text;
    }, undefined, undefined, false, { deadlineAt, draftingMode: true });
    summaries.push('[' + label + ' — الجزء ' + (index + 1) + ']\n' + summary);
    console.info('[counter-brief] source chunk compacted', {
      label,
      chunk: index + 1,
      totalChunks: chunks.length,
      sourceCharacters: sourceChunk.length,
      summaryCharacters: summary.length,
    });
  }
  return summaries.join('\n\n');
}

async function compactDraftingInputs(facts: string, priorAnalysis: string, deadlineAt: number): Promise<{ facts: string; priorAnalysis: string }> {
  const combinedLength = String(facts || '').length + String(priorAnalysis || '').length;
  if (combinedLength > DRAFTING_MAX_SOURCE_CHARS) {
    const error: any = new Error('إجمالي الوقائع والتحليل السابق أكبر من 96,000 حرف. قلّل النص المرسل أو أرفق المستند على أجزاء أصغر حتى لا تُسقط أي واقعة من القضية.');
    error.status = 413;
    error.statusCode = 413;
    throw error;
  }
  const chunksNeeded = Math.ceil(String(facts || '').length / DRAFTING_INPUT_CHUNK_CHARS) +
    Math.ceil(String(priorAnalysis || '').length / DRAFTING_INPUT_CHUNK_CHARS);
  if (chunksNeeded > DRAFTING_MAX_INPUT_CHUNKS) {
    const error: any = new Error('الوقائع والتحليل السابق يحتاجان إلى أكثر من 12 جزءاً (8,000 حرف لكل جزء). لم يبدأ التوليد حتى لا تُحذف معلومات من الملف.');
    error.status = 413;
    error.statusCode = 413;
    throw error;
  }
  return {
    facts: await compactDraftingSource(facts, 'الوقائع', deadlineAt),
    priorAnalysis: await compactDraftingSource(priorAnalysis, 'التحليل السابق', deadlineAt),
  };
}

function assertDraftingInputBudget(prompt: string): void {
  const estimatedTokens = Math.ceil((String(prompt || '').length + EGYPTIAN_LEGAL_SYSTEM_INSTRUCTION.length) / 2.5);
  if (estimatedTokens > DRAFTING_MAX_INPUT_TOKENS) {
    const error: any = new Error('سياق الطلب النهائي أكبر من حد المدخلات الآمن (6,000 token تقريباً). قلّل التعليمات أو سياق الخزانة/التحليل السابق ثم أعد المحاولة؛ لم يُخصم رصيد');
    error.status = 413;
    error.statusCode = 413;
    throw error;
  }
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

    // The caller already supplies the case facts and any prior legal analysis.
    // Send both unchanged to Gemini; do not spend extra requests re-analyzing them.
    const draftingAnalysisDeadline = Date.now() + 210000;
    const compactedDraftingInputs = await compactDraftingInputs(
      String(facts || ''),
      typeof caseAnalysisContext === 'string' ? caseAnalysisContext : '',
      draftingAnalysisDeadline,
    );
    const draftingFactsContext = compactedDraftingInputs.facts;
    const draftingPriorAnalysisContext = compactedDraftingInputs.priorAnalysis;

    const legalResearch = /(?:بحث\s+(?:قانوني|عن|في)|تحقق\s+(?:من|من صحة)|مصادر\s+(?:رسمية|موثوقة)|أحكام\s+(?:النقض|الإدارية العليا)|المحكمة\s+الإدارية\s+العليا|رقم\s+طعن|رقم\s+الطعن|مبدأ\s+قضائي|سابقة\s+قضائية|نص\s+المادة|المادة\s+رقم|قانون\s+رقم|آخر\s+تعديل|أحدث\s+تعديل)/i.test([facts, defenses, requests, customInstructions].filter(Boolean).join(' '));

    const draftingVaultContext = String(vaultContext || '').length > 3500
      ? String(vaultContext).slice(0, 2500) + '\n[اختصار سياق الخزانة للحفاظ على حد المدخلات؛ الأسلوب والبنية فقط]\n' + String(vaultContext).slice(-1000)
      : String(vaultContext || '');

    const prompt = `[مهمة الصياغة القانونية]
اكتب بالعربية القانونية المصرية فقط، ولا تضع كلمات إنجليزية لوصف التنسيق. التزم بنوع المستند الذي حدده المحامي؛ لا تفترض تلقائياً أنه مذكرة دفاع. إذا لم يحدد النوع، استنتج الأنسب من الغرض والمرحلة والوقائع، ونبّه إذا تعذر الحسم.

[بيانات المهمة]
${workTypeInstruction}
المحكمة: ${courtType || 'المحكمة المختصة'} | الدائرة: ${circuit || ''}
الموكل وصفته: ${clientName || 'غير محدد'} — ${clientRole || 'الصفة تحتاج تحديداً إذا لم تحسمها الوقائع'}
الخصم: ${opponentName || 'غير محدد'} | رقم الدعوى: ${caseNumber || ''} | الجلسة: ${sessionDate || ''}

[وقائع القضية وسجل الأدلة الكامل]
${draftingFactsContext}

[دفوع المحامي]
${defenses || 'لم تُدخل دفوع محددة.'}

[طلبات المحامي — التزم بها دون إضافة أو حذف أو توسيع]
${requests || 'لم تُحدد طلبات صراحةً؛ لا تفترض تفويضاً مفتوحاً.'}

[تعليمات المحامي الإضافية]
${customInstructions || 'لا توجد.'}

${draftingPriorAnalysisContext ? `[تحليل سابق مرتبط بالقضية]
${draftingPriorAnalysisContext}
طابقه مع الوقائع الحالية، ولا تنقل منه معلومة أو دفعاً أو طلباً دون التحقق من سنده، وقدّم البيانات الحالية عند التعارض.` : ''}

${vaultContext ? `[مرجع الخزانة — أسلوب وبنية فقط]
${vaultContext}
استخلص منه بصمة المحامي والترويسة وتسلسل الأقسام والعبارات وطريقة الطلبات. لا تنقل وقائع أو أسماء أو تواريخ أو أرقاماً أو دفوعاً أو طلبات تخص النموذج المرجعي.` : ''}

[منهج التنفيذ]
طبّق قواعد العمل القانونية الثابتة في تعليمات النظام على كامل ملف القضية، واختر نوع المستند وهيكله وفق المهمة وبصمة النموذج المرجعي المختار، دون إسقاط واقعة أو إضافة طلب غير مفوض.

[تنسيق الإخراج]
أخرج أولاً توصية مهنية موجزة بين [[AMIN_STRATEGY]] و[[/AMIN_STRATEGY]] تتضمن الإجراء الأنسب وسببه والنقطة الحاسمة والمخاطر والخطوة التالية، دون كشف التفكير الداخلي.
ثم أخرج المستند وحده بين [[AMIN_DOCUMENT]] و[[/AMIN_DOCUMENT]]، وابدأ مباشرة بديباجته المناسبة. لا تخلط التوصية بمتن المستند. أكمل جميع أقسام نوع المستند والطلبات والخاتمة اللازمة، ولا تتوقف عند منتصفه.`;

    assertDraftingInputBudget(prompt);\n\n    const continuationContext = [
      '[سياق استكمال مختصر — مرجع القضية الحالي]',
      workTypeInstruction,
      `المحكمة: ${courtType || ''}؛ الدائرة: ${circuit || ''}؛ الموكل: ${clientName || ''}؛ الصفة: ${clientRole || ''}؛ الخصم: ${opponentName || ''}؛ رقم الدعوى: ${caseNumber || ''}؛ الجلسة: ${sessionDate || ''}`,
      `الوقائع الأصلية كاملة: ${String(draftingFactsContext || '')}`,
      `دفوع المحامي كاملة: ${String(defenses || '')}`,
      `طلبات المحامي كاملة: ${String(requests || '')}`,
      `تعليمات المحامي كاملة: ${String(customInstructions || '')}`,
      `التحليل السابق كاملًا: ${String(draftingPriorAnalysisContext || '')}`,
      `بصمة الخزانة: ${draftingVaultContext}`,
      'التزم بالنوع والطلبات المحددة، ولا تختلق وقائع أو أسانيد. أكمل المستند من حيث انتهى النص السابق وبنفس بصمة المحامي.'
    ].join('\n\n');
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
