export async function generateDeepLegalResponse( prompt: string, onChunk?: (text: string) => void, options: { legalResearch?: boolean } = {}, ): Promise<string> {
  const completionMarker = '[[AMIN_STREAM_COMPLETE_9F7C2A]]';
  const researchInstruction = options.legalResearch ? '\n\n[بحث قانوني موثق إلزامي] استخدم أداة البحث المتاحة للبحث عن المصادر المصرية الأولية والرسمية ذات الصلة بالمهمة الحالية. أعط الأولوية لمواقع الجهات الرسمية والتشريعات المنشورة والأحكام المنشورة من مصادر قضائية موثوقة. لا تعتبر مقتطف نتيجة البحث نصاً كاملاً للحكم أو القانون. لا تذكر إلا ما تدعمه المصادر التي وصلت إليها فعلاً، وأدرج روابط مباشرة للمصادر بجوار الادعاءات القانونية المستندة إليها. إذا لم تجد مصدراً موثوقاً أو تعذر التحقق من نص أو رقم حكم أو طعن، فصرح بذلك ولا تختلقه. افصل بوضوح بين النص الرسمي، والشرح، والاستنتاج القانوني.\n' : '';
  const optimizedPrompt = `${prompt}${researchInstruction} [تعليمات كفاءة الإخراج] أنجز المطلوب في طلب توليد واحد قدر الإمكان. لا تكرر التحليل أو تعيد صياغة الفكرة نفسها في أكثر من موضع، ولا تضف مقدمات أو خاتمات إنشائية أو عناوين مكررة. اجعل كل فقرة تضيف حجة أو واقعة أو تطبيقاً أو طلباً جديداً، مع الحفاظ على جميع النقاط القانونية الجوهرية وعدم اختصار ما يؤثر في النتيجة. راجع الوقائع والطلبات ومخاطر الاختلاق داخلياً مراجعة مركزة، ولا تعرض خطوات التفكير. أخرج المستند المطلوب مباشرة. [علامة اكتمال داخلية إلزامية] بعد إتمام جميع أجزاء النتيجة المطلوبة بالكامل، وفي آخر النص فقط، أضف هذه العلامة حرفياً: ${completionMarker}. لا تضف العلامة قبل اكتمال المستند. لا تشرح العلامة ولا تجعلها جزءاً من المحتوى القانوني.`;

  if (onChunk) {
    await executeWithKeyRotationStream(async (ai, _key, model) => {
      const providerSearchEnabled = options.legalResearch && (_key === 'openrouter'
        ? process.env.OPENROUTER_ENABLE_WEB_SEARCH === 'true'
        : process.env.GEMINI_ENABLE_GOOGLE_SEARCH === 'true');

      return (async function* () {
        let accumulatedText = '';
        let continuationCount = 0;
        let nextPrompt = optimizedPrompt;
        let completed = false;
        let pendingMarkerTail = '';

        while (true) {
          const textLengthBeforeStream = accumulatedText.length;
          const stream = await ai.models.generateContentStream({
            model,
            contents: nextPrompt,
            config: {
              systemInstruction: EGYPTIAN_LEGAL_SYSTEM_INSTRUCTION,
              temperature: 0.15,
              maxOutputTokens: 32768,
              ...(providerSearchEnabled ? { tools: [{ googleSearch: {} }] } : {}),
              thinkingConfig: { thinkingLevel: 'low' },
            },
          });

          let finishReason = '';
          for await (const chunk of stream) {
            const chunkText = typeof chunk?.text === 'string' ? chunk.text : '';
            if (chunkText) {
              const candidateText = pendingMarkerTail + chunkText;
              const markerIndex = candidateText.indexOf(completionMarker);

              if (markerIndex >= 0) {
                const visibleText = candidateText.slice(0, markerIndex);
                accumulatedText += visibleText;
                pendingMarkerTail = '';
                completed = true;
                yield { ...chunk, text: visibleText };
              } else {
                const keepLength = Math.max(0, completionMarker.length - 1);
                const splitAt = Math.max(0, candidateText.length - keepLength);
                const visibleText = candidateText.slice(0, splitAt);
                pendingMarkerTail = candidateText.slice(splitAt);
                if (visibleText) {
                  accumulatedText += visibleText;
                  yield { ...chunk, text: visibleText };
                }
              }
            } else {
              yield chunk;
            }
            const candidates = chunk?.candidates;
            const candidateReason = candidates?.[0]?.finishReason;
            if (candidateReason) finishReason = String(candidateReason).toUpperCase();
          }

          if (!completed && pendingMarkerTail) {
            if (!completionMarker.startsWith(pendingMarkerTail)) {
              accumulatedText += pendingMarkerTail;
              yield { text: pendingMarkerTail };
            }
            pendingMarkerTail = '';
          }

          if (!accumulatedText.trim() || (accumulatedText.length === textLengthBeforeStream && !completed)) {
            const noTextError: any = new Error(
              `استجاب مزود الذكاء الاصطناعي دون نص قابل للاستخدام (finishReason: ${finishReason || 'UNKNOWN'}).`,
            );
            noTextError.status = 503;
            noTextError.statusCode = 503;
            throw noTextError;
          }

          // [التعديل هنا فقط]: زيادة عدد محاولات الاستكمال لضمان إتمام المستندات الطويلة للنهاية
          if (completed || continuationCount >= 7 || (!hitOutputTokenLimit(finishReason) && finishReason !== 'STOP')) {
            break;
          }

          continuationCount += 1;
          nextPrompt = `${optimizedPrompt} [استكمال إلزامي للنتيجة التي لم تصل إلى علامة الاكتمال] هذا هو النص الذي أخرجته حتى الآن، وهو جزء من النتيجة نفسها وليس طلباً لإعادة كتابته: ${accumulatedText} تابع مباشرة من آخر حرف في النص السابق دون إعادة أي جزء منه أو تلخيصه. أكمل جميع الأجزاء المتبقية من النتيجة المطلوبة حتى نهايتها، بما في ذلك النتيجة النهائية والطلبات الختامية إن كانت مطلوبة. لا تعتبر النص السابق مكتملاً، ولا تضع علامة الاكتمال إلا بعد إتمام كل المطلوب. سبب الاستكمال التقني: ${finishReason || 'انتهى البث دون علامة اكتمال'}.`;
        }
      })();
    }, onChunk);
    return '';
  }

  return executeWithKeyRotation(async (ai, _key, model) => {
    const providerSearchEnabled = options.legalResearch && (_key === 'openrouter'
      ? process.env.OPENROUTER_ENABLE_WEB_SEARCH === 'true'
      : process.env.GEMINI_ENABLE_GOOGLE_SEARCH === 'true');
    let currentPrompt = optimizedPrompt;
    let fullText = '';

    for (let attempt = 0; attempt <= 7; attempt += 1) {
      const response = await ai.models.generateContent({
        model,
        contents: currentPrompt,
        config: {
          systemInstruction: EGYPTIAN_LEGAL_SYSTEM_INSTRUCTION,
          temperature: 0.15,
          maxOutputTokens: 32768,
          ...(providerSearchEnabled ? { tools: [{ googleSearch: {} }] } : {}),
        },
      });

      const rawText = typeof response.text === 'string' ? response.text : '';
      const finishReason = String(response?.candidates?.[0]?.finishReason || '').toUpperCase();
      const markerIndex = rawText.indexOf(completionMarker);
      const visibleText = markerIndex >= 0 ? rawText.slice(0, markerIndex) : rawText;
      fullText += visibleText;

      if (markerIndex >= 0 || !rawText.trim() || attempt >= 7 || (!hitOutputTokenLimit(finishReason) && finishReason !== 'STOP')) {
        break;
      }

      currentPrompt = `${optimizedPrompt} [استكمال بسبب بلوغ حد الإخراج فقط] هذا هو النص الذي تم توليده حتى الآن. أكمل منه مباشرة دون إعادة أي جزء سابق أو تلخيصه: ${fullText} أكمل جميع الأجزاء المتبقية من العمل المطلوب حتى النهاية، ولا تعتبر النتيجة مكتملة إلا بعد إنهاء جميع الأقسام والطلبات اللازمة. أضف علامة الاكتمال فقط بعد إنهاء العمل بالكامل. سبب الاستكمال التقني: ${finishReason}.`;
    }

    return fullText.trim();
  });
}
