import { executeWithKeyRotation, executeWithKeyRotationStream } from '../keyRotation.ts';

import { enforceAiCooldown, consumeOperation } from '../auth.ts';
import { rateLimit, limitBodyString } from '../security.ts';
export const EGYPTIAN_LEGAL_SYSTEM_INSTRUCTION = `أنت «أمين»، مساعد صياغة قانونية للمحامي المصري. أنجز نوع العمل القضائي الذي حدده المحامي، أياً كان فرعه أو شكله، بصياغة مهنية دقيقة ومتكاملة.

قواعد العمل:
- اعتمد في الوقائع والمضمون على بيانات القضية الحالية ومستنداتها فقط. ميّز بين الثابت والاستنتاج والاحتمال وما يحتاج تحققاً.
- لا تختلق واقعة أو مستنداً أو اسماً أو تاريخاً أو مادة قانونية أو حكماً أو رقم طعن أو اقتباساً. لا تنسب إلى مصدر بحثاً لم يُجرَ، ولا تعتمد رقماً قانونياً غير متحقق.
- حدّد صفة الموكل من بيانات المحامي؛ لا تفترض أنه المدعى عليه. والتزم بالطلبات التي حددها دون إضافة أو حذف أو توسيع.
- افهم نوع العمل المطلوب وجهة القضاء أولاً، ثم ابنِ هيكلهما المناسب. لا تحوّل صحيفة أو إعلاناً أو إنذاراً أو طعناً إلى مذكرة دفاع، ولا تفرض قالباً واحداً على جميع الأعمال.
- اربط كل حجة جوهرية بالواقعة ودليلها والقاعدة المنطبقة وأثرها. لا تنشئ دفوعاً نمطية أو عيوباً إجرائية بلا قرائن من الأوراق، ووازن بين موقف الموكل وأقوى ما قد يواجهه.
- استخدم «بصمة أسلوب المحامي» المرفقة للغة والافتتاح وترتيب العرض والانتقالات والمفردات وطول الفقرات والخاتمة فقط. لا تنقل منها أي مضمون خاص بقضية أخرى، ولا تجعل هيكل نموذج مختلف يطغى على نوع العمل الحالي.
- اجعل التفصيل بقدر تعقيد الوقائع والأدلة؛ لا تكرر ولا تحشو ولا تختزل نقطة جوهرية.
- أخرج المستند بالعربية، وابدأ مباشرة من أول سطر قانوني دون تحية أو مقدمة محادثية. لا تعرض التفكير الداخلي. راجع اكتمال المستند والطلبات وعدم تسرب بيانات النماذج قبل الإخراج.`;

const DEEP_AUDIT_INSTRUCTION = `أنشئ قبل الإجابة النهائية «حزمة تدقيق قانوني داخلية» مختصرة وليست سلسلة تفكير سرية. لا تكتب سرداً لخطوات التفكير؛ استخرج فقط نتائج قابلة للتحقق من المعطيات: (1) الوقائع والادعاءات الجوهرية، (2) سجل الادعاء/الدليل وما يثبت وما لا يثبت، (3) خط زمني عند الحاجة، (4) التناقضات، (5) النواقص الحرجة، (6) الدفوع والتكييفات المحتملة، (7) أقوى موقف للخصم، (8) نقاط الخطر والبدائل، (9) عناصر تحتاج تحققاً، (10) أخطر شيء قد يكون التحليل قد أغفله. لا تختلق أي معلومة قانونية أو واقعية. اجعل الحزمة مركزة حتى يمكن استخدامها كأساس للإجابة النهائية.`;

const FINAL_REVIEW_INSTRUCTION = `هذه المهمة خضعت لتدقيق أولي. قبل الإخراج النهائي استخدم حزمة التدقيق كمدخل مساعد، ثم أعد اختبارها خصمياً: صحح أي استنتاج غير مدعوم، افصل الثابت عن الاستنتاج، لا تضف أي معلومة غير موجودة، وابحث مرة أخيرة عن أقوى حجة معاكسة ومعلومة ناقصة قد تقلب النتيجة. أخرج النتيجة العملية المطلوبة فقط، دون كشف حزمة التدقيق الداخلية أو سلسلة التفكير السرية.`;

/** Finish reasons that represent a provider refusal/filter, not a normal continuation point. */
function isBlockedFinishReason(reason: unknown): boolean {
  const normalized = String(reason || '').trim().toUpperCase();
  return ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'CONTENT_FILTER'].includes(normalized);
}

function logLegalSearchFailure(error: any, model: string, phase: string): void {
  const message = String(error?.message || '')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted]')
    .replace(/((?:api[_-]?key|token|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .slice(0, 240);
  console.warn('[counter-brief] Google Search request failed; drafting fallback will continue without search', {
    model,
    phase,
    status: Number(error?.status || error?.statusCode || error?.response?.status) || null,
    code: error?.code || error?.error?.status || null,
    message: message || null,
  });
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

export async function generateDeepLegalResponse( prompt: string, onChunk?: (text: string) => void, options: { legalResearch?: boolean; researchContext?: string } = {}, ): Promise<string> {
  // Performance-critical path: the previous implementation generated a full
  // hidden audit response and then sent a second full generation request for
  // the final answer. That doubled model latency and was especially noticeable
  // on long legal documents. The system instruction already requires internal
  // verification, so perform the review inside a single generation request.
  const completionMarker = '[[AMIN_STREAM_COMPLETE_9F7C2A]]';
  const maxContinuations = 5;
  const usedPairs = new Set<string>();
  const deadlineAt = Date.now() + 270000;
  let accumulatedText = '';
  let continuationCount = 0;
  let lastError: any = null;
  let previousPair = '';

  // Legal research is part of the initial drafting request. If Google Search
  // fails before any draft text is produced, retry the same generation without
  // the search tool so research availability can never block the legal draft.
  const focusedResearchContext = typeof options.researchContext === 'string'
    ? options.researchContext.trim()
    : '';
  const generationPrompt = options.legalResearch && focusedResearchContext
    ? `${prompt}\n\n[بحث قانوني مدمج في طلب الصياغة — استخدم Google Search عند الحاجة]\nاستخرج من السياق التالي المسائل القانونية المحددة ذات الصلة بالقضية، وابحث عنها أثناء إعداد المستند. اعتمد على المصادر التي تظهر فعلياً في نتائج البحث فقط، واذكر بيانات المصدر والرابط فقط إذا أعادها البحث فعلاً. إذا لم تتوفر نتائج بحث موثقة، أكمل الصياغة من الأوراق المتاحة دون اختلاق مواد أو أحكام أو أرقام طعون أو روابط أو مصادر.\n${focusedResearchContext}`
    : prompt;

  const optimizedPrompt = `${generationPrompt} [تعليمات كفاءة الإخراج] أنجز المطلوب في طلب توليد واحد قدر الإمكان. لا تكرر التحليل أو تعيد صياغة الفكرة نفسها في أكثر من موضع، ولا تضف مقدمات أو خاتمات إنشائية أو عناوين مكررة. اجعل كل فقرة تضيف حجة أو واقعة أو تطبيقاً أو طلباً جديداً، مع الحفاظ على جميع النقاط القانونية الجوهرية وعدم اختصار ما يؤثر في النتيجة. راجع الوقائع والطلبات ومخاطر الاختلاق داخلياً مراجعة مركزة، ولا تعرض خطوات التفكير. أخرج المستند المطلوب مباشرة. [علامة اكتمال داخلية إلزامية] بعد إتمام جميع أجزاء النتيجة المطلوبة بالكامل، وفي آخر النص فقط، أضف هذه العلامة حرفياً: ${completionMarker}. لا تضف العلامة قبل اكتمال المستند. لا تشرح العلامة ولا تجعلها جزءاً من المحتوى القانوني.`;

  const makeContinuationPrompt = () => accumulatedText
    ? `${optimizedPrompt} [استكمال إلزامي للنتيجة غير المكتملة] هذا هو النص الذي تم توليده بالفعل حتى الآن، وهو جزء من المستند نفسه: ${accumulatedText}\n\nتابع من آخر موضع في النص السابق دون إعادة كتابته أو تلخيصه أو إعادة أي قسم مكتمل. أكمل الأجزاء المتبقية فقط حتى نهاية المستند، بما في ذلك الخاتمة والطلبات الختامية المطلوبة. لا تعتبر المستند مكتملاً إلا بعد إنهاء جميع أجزائه. أضف علامة الاكتمال ${completionMarker} في نهاية المستند فقط بعد إتمامه بالكامل. سبب طلب الاستكمال: الجزء السابق انتهى قبل وصول علامة الاكتمال.`
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
          activePair = key === 'openrouter' ? `openrouter::${model}` : `${key}::${model}`;
          activePairLabel = `${key === 'openrouter' ? 'OpenRouter' : 'Gemini'} / ${model}`;

          return (async function* () {
            let pendingMarkerTail = '';
            let receivedText = false;
            let searchFallbackUsed = false;
            const searchDiagnostics = { queryCount: 0, sourceCount: 0, metadataSeen: false };
            const shouldUseLegalSearch = Boolean(key !== 'openrouter' && options.legalResearch && focusedResearchContext && !accumulatedText);
            const requestConfig: any = {
              systemInstruction: EGYPTIAN_LEGAL_SYSTEM_INSTRUCTION,
              temperature: 0.15,
              maxOutputTokens: 32768,
              thinkingConfig: { thinkingLevel: 'low' },
            };
            if (shouldUseLegalSearch) requestConfig.tools = [{ googleSearch: {} }];
            const streamWithConfig = (config: any) => ai.models.generateContentStream({
              model,
              contents: segmentPrompt,
              config,
            });

            const forwardStream = async function* (activeStream: any) {
              for await (const chunk of activeStream) {
                const candidate = chunk?.candidates?.[0];
                const grounding = candidate?.groundingMetadata;
                if (shouldUseLegalSearch && grounding) {
                  searchDiagnostics.metadataSeen = true;
                  searchDiagnostics.queryCount += Array.isArray(grounding.webSearchQueries) ? grounding.webSearchQueries.length : 0;
                  searchDiagnostics.sourceCount += Array.isArray(grounding.groundingChunks) ? grounding.groundingChunks.length : 0;
                }
                const candidateReason = candidate?.finishReason;
                if (candidateReason) finishReason = String(candidateReason).toUpperCase();
                if (segmentCompleted) continue;
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
                  continue;
                }
                const keepLength = completionMarker.length - 1;
                const splitAt = Math.max(0, candidateText.length - keepLength);
                const visibleText = candidateText.slice(0, splitAt);
                pendingMarkerTail = candidateText.slice(splitAt);
                if (visibleText) yield { text: visibleText };
              }
            };

            try {
              const stream = await streamWithConfig(requestConfig);
              for await (const part of forwardStream(stream)) yield part;
            } catch (searchError: any) {
              if (!shouldUseLegalSearch || receivedText) throw searchError;
              searchFallbackUsed = true;
              logLegalSearchFailure(searchError, model, 'stream-before-first-token');
              const fallbackConfig = { ...requestConfig };
              delete fallbackConfig.tools;
              const fallbackStream = await streamWithConfig(fallbackConfig);
              for await (const part of forwardStream(fallbackStream)) yield part;
            }

            if (shouldUseLegalSearch) {
              console.info('[counter-brief] Google Search grounding diagnostics', {
                model,
                fallbackUsed: searchFallbackUsed,
                metadataSeen: searchDiagnostics.metadataSeen,
                queryCount: searchDiagnostics.queryCount,
                sourceCount: searchDiagnostics.sourceCount,
              });
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
          avoidPairs: Array.from(usedPairs),
        });
      } catch (error: any) {
        segmentError = error;
        lastError = error;
      }

      if (activePair) usedPairs.add(activePair);
      if (segmentError?.blockedResponse) throw segmentError;
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
        activePair = key === 'openrouter' ? `openrouter::${model}` : `${key}::${model}`;
        activePairLabel = `${key === 'openrouter' ? 'OpenRouter' : 'Gemini'} / ${model}`;
        const shouldUseLegalSearch = Boolean(key !== 'openrouter' && options.legalResearch && focusedResearchContext && !accumulatedText);
        const requestConfig: any = {
          systemInstruction: EGYPTIAN_LEGAL_SYSTEM_INSTRUCTION,
          temperature: 0.15,
          maxOutputTokens: 32768,
        };
        if (shouldUseLegalSearch) requestConfig.tools = [{ googleSearch: {} }];
        let response: any;
        let searchFallbackUsed = false;
        try {
          response = await ai.models.generateContent({
            model,
            contents: segmentPrompt,
            config: requestConfig,
          });
        } catch (searchError: any) {
          if (!shouldUseLegalSearch) throw searchError;
          searchFallbackUsed = true;
          logLegalSearchFailure(searchError, model, 'non-streaming');
          const fallbackConfig = { ...requestConfig };
          delete fallbackConfig.tools;
          response = await ai.models.generateContent({
            model,
            contents: segmentPrompt,
            config: fallbackConfig,
          });
        }
        if (shouldUseLegalSearch) {
          const grounding = response?.candidates?.[0]?.groundingMetadata;
          console.info('[counter-brief] Google Search grounding diagnostics', {
            model,
            fallbackUsed: searchFallbackUsed,
            metadataSeen: Boolean(grounding),
            queryCount: Array.isArray(grounding?.webSearchQueries) ? grounding.webSearchQueries.length : 0,
            sourceCount: Array.isArray(grounding?.groundingChunks) ? grounding.groundingChunks.length : 0,
          });
        }
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
        avoidPairs: Array.from(usedPairs),
      });
    } catch (error: any) {
      lastError = error;
      if (error?.blockedResponse) throw error;
      if (activePair) usedPairs.add(activePair);
      throw error;
    }

    if (activePair) usedPairs.add(activePair);
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
      vaultContext,
    } = body || {};

    if (!facts || !facts.trim()) {
      return res.status(400).json({ error: 'يرجى كتابة وقائع الدعوى.' });
    }

    const { session } = await enforceAiCooldown(req);
    rateLimit(req, 'gemini-counter-brief', 8, 10 * 60 * 1000, {
      identity: session.userId,
      allowConfiguredAiExemption: true,
    });

    limitBodyString(facts, 200000, 'الوقائع');
    limitBodyString(vaultContext, 30000, 'سياق الخزانة');
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
      ? `اكتب: ${finalWorkType}. هذا الاختيار ملزم ولا تستبدله بنوع آخر.`
      : 'حدّد نوع العمل الأنسب من غرض الطلب والوقائع، واذكر النوع من خلال بنية المستند لا بمقدمة تفسيرية.';

    // Keep the legal-search, streaming, continuation, billing and job lifecycle
    // unchanged; only the drafting instructions and lawyer-style payload are compact.
    const legalResearch = true;
    const prompt = `[مهمة الصياغة]
${workTypeInstruction}

[بيانات الإجراء]
المحكمة أو الجهة: ${courtType || 'تُحدد من البيانات المتاحة'}
الدائرة: ${circuit || ''}
صفة الموكل: ${clientRole || 'غير محددة؛ لا تفترض صفة'}
اسم الموكل: ${clientName || ''}
الخصم: ${opponentName || ''}
رقم الدعوى: ${caseNumber || ''}
الجلسة أو التاريخ: ${sessionDate || ''}

[وقائع القضية ومدخلاتها]
${facts}

[دفوع المحامي]
${defenses || 'لم تُحدد دفوع مستقلة.'}

[طلبات المحامي]
${requests || 'لم تُحدد طلبات صريحة؛ لا تفترض تفويضاً بإضافة طلبات.'}

[تعليمات المحامي الإضافية]
${customInstructions || 'لا توجد.'}

[بصمة أسلوب المحامي]
${vaultContext}

[طريقة الإنجاز]
أنشئ المستند كاملاً وفق نوع العمل المحدد وجهة القضاء وصفة الموكل. رتّب الوقائع والحجج والأقسام والطلبات بما يلائم هذا النوع، وحافظ على أسلوب المحامي دون نسخ محتوى النماذج. اربط كل نتيجة جوهرية بما يسندها من المدخلات والقاعدة القانونية المنطبقة. افحص الصفة والإجراءات والمواعيد والتناقضات والأدلة فقط بقدر ما تسمح به الأوراق. لا تضف طلباً قضائياً لم يحدده المحامي، ولا تسقط طلباً حدده. إذا كانت معلومة أو قاعدة لازمة غير متاحة، ضع تنبيهاً محدداً بدلاً من اختلاقها. أخرج النص القانوني وحده بالعربية، من بدايته الإجرائية حتى طلباته أو خاتمته المناسبة، دون تمهيد أو تعليق محادثي.`;

    const factsForResearch = facts.length > 8000
      ? `${facts.slice(0, 6000)}\n[مقتطف أخير من الوقائع]\n${facts.slice(-1500)}`
      : facts;
    const researchContext = [
      'الاختصاص القانوني: جمهورية مصر العربية.',
      `نوع العمل القضائي: ${finalWorkType || 'غير محدد'}.`,
      `جهة القضاء/المحكمة: ${courtType || 'غير محددة'}؛ الدائرة: ${circuit || 'غير محددة'}.`,
      clientRole ? `صفة الموكل: ${clientRole}.` : '',
      `الوقائع ذات الصلة (مقتطف محدود لا يتضمن قالب الصياغة):\n${factsForResearch}`,
      defenses ? `الدفوع التي أدخلها المحامي:\n${String(defenses).slice(0, 2500)}` : '',
      requests ? `الطلبات التي أدخلها المحامي:\n${String(requests).slice(0, 1500)}` : '',
    ].filter(Boolean).join('\n\n');

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
        await generateDeepLegalResponse(prompt, writeChunk, { legalResearch, researchContext });
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

    const resultText = await generateDeepLegalResponse(prompt, undefined, { legalResearch, researchContext });
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
