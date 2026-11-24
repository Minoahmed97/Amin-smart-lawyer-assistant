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


function splitLegalSourceIntoChunks(source: string, maxChars = 6000): Array<{ text: string; start: number; end: number }> {
  const chunks: Array<{ text: string; start: number; end: number }> = [];
  let start = 0;
  while (start < source.length) {
    let end = Math.min(source.length, start + maxChars);
    if (end < source.length) {
      const floor = start + Math.floor(maxChars * 0.55);
      const positions = ['\n\n', '\n', '۔', '.', '؛'].map((separator) => source.lastIndexOf(separator, end)).filter((position) => position >= floor);
      if (positions.length) end = Math.max(...positions) + 1;
    }
    if (end <= start) end = Math.min(source.length, start + maxChars);
    chunks.push({ text: source.slice(start, end), start, end });
    start = end;
  }
  return chunks;
}

type DraftingLedgerState = {
  version: 1;
  sources: Record<string, { sourceLength: number; chunks: Record<string, string>; reductions: Record<string, string[]> }>;
};

async function buildDraftingEvidenceLedger(
  source: string, sourceLabel: string, deadlineAt: number,
  state: DraftingLedgerState, persist: () => Promise<void>,
): Promise<string> {
  const trimmed = typeof source === 'string' ? source.trim() : '';
  if (!trimmed || trimmed.length <= 6000) return source;
  const chunks = splitLegalSourceIntoChunks(source);
  let sourceState = state.sources[sourceLabel];
  if (!sourceState || sourceState.sourceLength !== source.length) {
    sourceState = { sourceLength: source.length, chunks: {}, reductions: {} };
    state.sources[sourceLabel] = sourceState;
    await persist();
  }
  const ledgerParts: string[] = [];
  console.info('[counter-brief] staged source analysis started', {
    source: sourceLabel, sourceCharacters: source.length, chunkCount: chunks.length,
    completedChunks: Object.keys(sourceState.chunks).length,
    chunkCharacters: chunks.map((chunk) => chunk.text.length),
  });
  for (let index = 0; index < chunks.length; index += 1) {
    const saved = sourceState.chunks[String(index)];
    if (typeof saved === 'string' && saved.trim()) { ledgerParts.push(saved); continue; }
    if (Date.now() >= deadlineAt) {
      const timeoutError: any = new Error('انتهى الوقت المتاح لتحليل أجزاء النص الطويل. ستُستكمل المهمة من آخر جزء محفوظ.');
      timeoutError.statusCode = 504; throw timeoutError;
    }
    const chunk = chunks[index];
    const chunkPrompt =
      '[تحليل مرحلي لمصدر قانوني طويل — الجزء ' + (index + 1) + ' من ' + chunks.length + ']\n' +
      'المصدر: ' + sourceLabel + '\n' +
      'موضع الجزء في النص الأصلي: من الحرف ' + (chunk.start + 1) + ' إلى الحرف ' + chunk.end + '.\n' +
      'حلّل هذا الجزء وحده تحليلاً استخلاصياً شاملاً، ولا تصغ مذكرة ولا تختصر الوقائع الجوهرية. استخرج كل واقعة وادعاء وإقرار، وكل اسم وصفة ورقم ومبلغ وتاريخ ومدة ومكان وتسلسل زمني، وكل مستند أو دليل ومضمونه وما يثبته وما لا يثبته، وكل طلب أو دفع أو دفاع أو حجة أو رد أو تناقض أو فجوة أو معلومة ناقصة. اربط كل نقطة بموضعها في الجزء، وحافظ على الأرقام والتواريخ والعبارات الحاسمة. ميّز بين الثابت والادعاء والاستنتاج والاحتمال والنقص. لا تضف قاعدة قانونية أو واقعة غير موجودة ولا تسقط معلومة قد يكون لها أثر قانوني أو إثباتي.\n' +
      '[النص الأصلي لهذا الجزء — يُحلل كاملاً دون إعادة صياغة مخلّة]\n' + chunk.text + '\n[نهاية الجزء]';
    const extracted = await executeWithKeyRotation(async (ai, _key, model) => {
      console.info('[counter-brief] staged chunk size estimate', {
        source: sourceLabel, chunk: index + 1, totalChunks: chunks.length,
        promptCharacters: chunkPrompt.length, estimatedInputTokens: Math.ceil(chunkPrompt.length / 3),
        tokenCountIsEstimate: true, model,
      });
      const response = await ai.models.generateContent({
        model, contents: chunkPrompt,
        config: { systemInstruction: 'أنت محلل قانوني مصري دقيق. استخرج البيانات من النص دون اختلاق، وحافظ على الإحالات والأرقام والتواريخ.', temperature: 0.1, maxOutputTokens: 8192 },
      });
      const text = typeof response.text === 'string' ? response.text.trim() : '';
      if (!text) { const error: any = new Error('تعذر استخراج سجل الجزء ' + (index + 1) + ' من النص الطويل.'); error.statusCode = 503; throw error; }
      return text;
    }, undefined, undefined, false, { deadlineAt, draftingMode: true });
    const entry = '[سجل المصدر: ' + sourceLabel + ' — الجزء ' + (index + 1) + '/' + chunks.length + ' — الحروف ' + (chunk.start + 1) + '-' + chunk.end + ']\n' + extracted;
    sourceState.chunks[String(index)] = entry;
    ledgerParts.push(entry);
    await persist();
  }
  let reducedParts = ledgerParts;
  let round = 0;
  while (reducedParts.length > 1) {
    round += 1;
    const savedRound = sourceState.reductions[String(round)] || [];
    const nextParts: string[] = [];
    for (let offset = 0; offset < reducedParts.length; offset += 4) {
      const batchIndex = Math.floor(offset / 4);
      const saved = savedRound[batchIndex];
      if (typeof saved === 'string' && saved.trim()) { nextParts.push(saved); continue; }
      if (Date.now() >= deadlineAt) {
        const error: any = new Error('انتهى الوقت المتاح لربط نتائج تحليل النص الطويل. ستُستكمل المهمة من آخر نتيجة دمج محفوظة.');
        error.statusCode = 504; throw error;
      }
      const batch = reducedParts.slice(offset, offset + 4);
      const prompt =
        '[دمج وربط سجلات تحليل مصدر قانوني طويل — الجولة ' + round + ']\n' +
        'ادمج السجلات التالية في ملف وقائع وأدلة موحد ومركز، مع الحفاظ على جميع الوقائع الجوهرية والأسماء والصفات والأرقام والمبالغ والتواريخ والطلبات والدفوع والمستندات والتناقضات ومواطن النقص. احتفظ بإحالات كل معلومة إلى الجزء وموضع الحروف الأصلي. اربط ما بين الأجزاء، واكشف التعارضات العابرة لها، ولا تكرر المعلومة إلا إذا كان التكرار نفسه ذا دلالة. لا تسقط معلومة مؤثرة ولا تختلق واقعة أو سنداً قانونياً. ميّز بين الثابت والادعاء والاستنتاج والاحتمال وما يحتاج تحققاً. هذا سجل تحليلي لا مسودة مستند قضائي.\n\n' +
        batch.join('\n\n[فاصل سجل]\n\n');
      const merged = await executeWithKeyRotation(async (ai, _key, model) => {
        console.info('[counter-brief] staged ledger reduction size estimate', {
          source: sourceLabel, round, batch: batchIndex + 1,
          promptCharacters: prompt.length, estimatedInputTokens: Math.ceil(prompt.length / 3),
          tokenCountIsEstimate: true, model,
        });
        const response = await ai.models.generateContent({
          model, contents: prompt,
          config: { systemInstruction: 'أنت محلل قانوني مصري يربط الأدلة والوقائع بدقة دون اختلاق أو إسقاط.', temperature: 0.1, maxOutputTokens: 4096 },
        });
        const text = typeof response.text === 'string' ? response.text.trim() : '';
        if (!text) { const error: any = new Error('تعذر ربط سجلات تحليل النص الطويل.'); error.statusCode = 503; throw error; }
        return text;
      }, undefined, undefined, false, { deadlineAt, draftingMode: true });
      sourceState.reductions[String(round)] ||= [];
      sourceState.reductions[String(round)][batchIndex] = merged;
      nextParts.push(merged);
      await persist();
    }
    reducedParts = nextParts;
  }
  console.info('[counter-brief] staged source analysis completed', {
    source: sourceLabel, sourceCharacters: source.length, chunkCount: chunks.length,
    ledgerCharacters: reducedParts.reduce((total, part) => total + part.length, 0), reductionRounds: round,
  });
  return '[سجل استخلاص مرحلي كامل من النص الأصلي غير المقتطع. عولجت جميع الأجزاء بالترتيب، والإحالات أدناه تشير إلى مواضعها في النص الأصلي. أعد الربط بين الأجزاء واختبر التناقضات العابرة لها.]\n' + reducedParts.join('\n\n');
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

    const draftingState: DraftingLedgerState = (() => {
      try {
        const parsed = typeof body?._draftingState === 'string' ? JSON.parse(body._draftingState) : null;
        if (parsed && parsed.version === 1 && parsed.sources && typeof parsed.sources === 'object') return parsed;
      } catch {}
      return { version: 1, sources: {} };
    })();
    const jobId = String(body?._jobId || '').trim();
    const jobUserId = String(body?._jobUserId || '').trim();
    const persistDraftingState = async () => {
      if (!/^[0-9a-f-]{36}$/i.test(jobId) || !jobUserId) return;
      const supabaseUrl = (process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
      const supabaseKey = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim();
      if (!supabaseUrl || !supabaseKey) throw new Error('تعذر حفظ تقدم الصياغة المرحلي على الخادم.');
      const checkpointPayload: Record<string, string> = {};
      for (const [key, value] of Object.entries(body || {})) {
        if (typeof value === 'string' && !['_draftingState', '_resumePartialText', '_jobId', '_jobUserId'].includes(key)) checkpointPayload[key] = value;
      }
      checkpointPayload._draftingState = JSON.stringify(draftingState);
      const headers: Record<string, string> = { apikey: supabaseKey, 'Content-Type': 'application/json', Prefer: 'return=minimal' };
      if (!supabaseKey.startsWith('sb_')) headers.Authorization = 'Bearer ' + supabaseKey;
      const response = await fetch(
        supabaseUrl + '/rest/v1/app_ai_generation_jobs?id=eq.' + encodeURIComponent(jobId) + '&user_id=eq.' + encodeURIComponent(jobUserId) + '&status=eq.running',
        { method: 'PATCH', headers, body: JSON.stringify({ payload: checkpointPayload, updated_at: new Date().toISOString() }), signal: AbortSignal.timeout(10000) },
      );
      if (!response.ok) throw new Error('تعذر حفظ نتائج تحليل أجزاء الصياغة في المهمة الدائمة (' + response.status + ').');
    };

    const finalWorkType =
      (customJudicialWorkType && customJudicialWorkType.trim()) ||
      (effectiveWorkType && effectiveWorkType.trim()) ||
      (briefType && briefType.trim()) ||
      '';
    const workTypeInstruction = finalWorkType
      ? `نوع المستند المطلوب من المحامي: ${finalWorkType}. التزم بهذا النوع.`
      : 'نوع المستند غير محدد مسبقاً: حدّد داخلياً أنسب نوع مستند قانوني للرد على المادة المنقولة (مذكرة رد/دفاع، عريضة/صحيفة دعوى، صحيفة طعن، حافظة مستندات، إنذار أو غير ذلك) بناءً على الغرض والطلبات والوقائع، ولا تفترض تلقائياً أنها مذكرة دفاع.';

    const draftingAnalysisDeadline = Date.now() + 210000;
    const draftingFactsContext = await buildDraftingEvidenceLedger(facts, 'وقائع الدعوى والمعلومات الأصلية', draftingAnalysisDeadline, draftingState, persistDraftingState);
    const draftingPriorAnalysisContext = typeof caseAnalysisContext === 'string'
      ? await buildDraftingEvidenceLedger(caseAnalysisContext, 'التحليل القانوني السابق', draftingAnalysisDeadline, draftingState, persistDraftingState)
      : caseAnalysisContext;

    const legalResearch = /(?:بحث\s+(?:قانوني|عن|في)|تحقق\s+(?:من|من صحة)|مصادر\s+(?:رسمية|موثوقة)|أحكام\s+(?:النقض|الإدارية العليا)|المحكمة\s+الإدارية\s+العليا|رقم\s+طعن|رقم\s+الطعن|مبدأ\s+قضائي|سابقة\s+قضائية|نص\s+المادة|المادة\s+رقم|قانون\s+رقم|آخر\s+تعديل|أحدث\s+تعديل)/i.test([facts, defenses, requests, customInstructions].filter(Boolean).join(' '));

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

    const continuationContext = [
      '[سياق استكمال مختصر — مرجع القضية الحالي]',
      workTypeInstruction,
      `المحكمة: ${courtType || ''}؛ الدائرة: ${circuit || ''}؛ الموكل: ${clientName || ''}؛ الصفة: ${clientRole || ''}؛ الخصم: ${opponentName || ''}؛ رقم الدعوى: ${caseNumber || ''}؛ الجلسة: ${sessionDate || ''}`,
      `الوقائع وسجل الأدلة: ${String(draftingFactsContext || '').slice(0, 7000)}`,
      `دفوع المحامي: ${String(defenses || '').slice(0, 1600)}`,
      `طلبات المحامي: ${String(requests || '').slice(0, 1200)}`,
      `تعليمات المحامي: ${String(customInstructions || '').slice(0, 900)}`,
      `التحليل السابق: ${String(draftingPriorAnalysisContext || '').slice(0, 2500)}`,
      `بصمة الخزانة: ${String(vaultContext || '').slice(0, 1800)}`,
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
