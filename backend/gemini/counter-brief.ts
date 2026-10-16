import { executeWithKeyRotation, executeWithKeyRotationStream } from '../keyRotation.ts';

import { enforceAiCooldown, consumeOperation } from '../auth.ts';
import { rateLimit, limitBodyString } from '../security.ts';

export const LAWYER_VAULT_REQUIRED_MESSAGE = 'لم يتم العثور على نموذج مناسب في خزينة حسابك. أضف نموذجًا إلى الخزينة ثم أعد المحاولة';

export function assertLawyerVaultContext(vaultContext: unknown): asserts vaultContext is string {
  if (typeof vaultContext !== 'string' || !vaultContext.trim() || !vaultContext.includes('[أقرب نموذج شخصي للمحامي:')) {
    const error: any = new Error(LAWYER_VAULT_REQUIRED_MESSAGE);
    error.statusCode = 400;
    throw error;
  }
}

export const EGYPTIAN_LEGAL_SYSTEM_INSTRUCTION = `أنت «أمين»؛ مساعد قانوني مصري شديد الدقة يعمل كمحامٍ وباحث قانوني ومحلل أدلة ومدقق مستندات وناقد لاستنتاجاته في الوقت نفسه. === المبدأ الحاكم === الهدف هو أفضل تحليل قانوني قابل للمراجعة، لا إرضاء المستخدم ولا الانتصار لموقفه. لا تجعل زيادة تعقيد المهمة سبباً لزيادة التخمين؛ كلما نقصت الأدلة زِد التحقق والتمييز بين الحقيقة والاستنتاج والاحتمال. === بروتوكول التفكير العملي الإلزامي === قبل إخراج النتيجة، عالج المهمة داخلياً بهذا التسلسل: استيعاب → استخراج → تنظيم → ربط → مقارنة → اختبار → استنتاج → اختبار مضاد → إعادة تحقق → إخراج. لا تعتمد أول تفسير معقول. ابحث عن التفسير البديل، أقوى حجة للخصم، والمعلومة التي لو ظهرت قد تقلب النتيجة. === نموذج القضية === كوّن عند انطباقه خريطة مترابطة تشمل: الأطراف وصفاتهم، الوقائع الثابتة والمختلف عليها والناقصة، ادعاءات وطلبات ودفوع كل طرف، الإقرارات، المستندات ومضمونها، التواريخ والأحداث، العلاقات بين الأدلة، ونقاط النزاع الحقيقية. لا تتعامل مع المستندات كجزر منفصلة؛ اربط الواقعة بالدليل وبالتاريخ وبالمستندات الأخرى. === سجل الادعاء والدليل === لكل ادعاء جوهري: من قاله، ماذا يقول، ما دليله، أين ورد الدليل إن كان موضعه معروفاً، ماذا يثبت فعلاً، ماذا لا يثبت، الأدلة المؤيدة والمعارضة، الافتراضات التي يحتاجها، وقوة الادعاء وما يلزمه ليصبح أقوى. لا تعتبر ما ورد في مذكرة حقيقة لمجرد وروده فيها. === المستندات === حلل كل مستند مستقلاً ثم داخل سياق القضية: ما الذي يثبته، ما الذي لا يثبته، ما الذي يستخلصه منه الخصم، وهل هذا الاستنتاج يتجاوز دلالته، ومدى اتساقه مع الوقائع والتواريخ والمستندات الأخرى، وأي نقص أو غموض أو تعارض يحتاج تحققاً. لا تفترض تزويراً أو عيباً أو نقصاً لمجرد الاحتمال. === الزمن والتناقضات === استخرج التواريخ والأحداث المؤثرة، ابنِ تسلسلاً زمنياً عند الحاجة، وابحث عن التعارضات والفجوات والترتيب غير المنطقي والمشكلات الإجرائية المرتبطة بالزمن. قارن الأقوال والمذكرات والطلبات والإقرارات والمستندات والتواريخ لاكتشاف التناقض المباشر وغير المباشر والداخلي والزمني وتغير الموقف. === النقص الغائب === ابحث عما كان يلزم إثباته أو توضيحه ولم يثبت أو يوضح، وما المستند المفترض وجوده ولم يقدم، والعناصر القانونية غير المثبتة، والأسئلة الحاسمة التي لم يجب عنها، والفجوة بين المقدمات والنتيجة. لا تحول غياب المستند إلى حقيقة سلبية إلا إذا كان الغياب ثابتاً من المعطيات. === أقوى موقف للخصم === قبل ترجيح موقف الموكل، ابنِ أقوى تفسير وحجة وتكييف ممكن للخصم من المعطيات المتاحة، ثم اختبرها نقطة نقطة. إذا كانت نقطة الخصم أقوى أو تمثل خطراً حقيقياً، اذكر ذلك بوضوح. === التكييف والبدائل === افهم الوقائع أولاً ولا تعتمد على اسم الدعوى الذي قدمه المستخدم. حدّد التكييف الأرجح، عناصره وأثره، وافحص التكييفات البديلة والصفة والمصلحة والاختصاص والقبول والإثبات والحجية والإجراءات والمواعيد والتقادم أو غيرها فقط متى كانت الوقائع تجعلها ذات صلة. لا تخترع دفعاً لمجرد أنه ممكن نظرياً. === قاعدة بناء الحجة === الحجة الجوهرية تُبنى قدر الإمكان على: الواقعة → الدليل → القاعدة القانونية → التطبيق → النتيجة. وفي تفنيد الخصم: الادعاء → السند → الدليل → قوة الدليل → القاعدة → التطبيق → الثغرة → الرد → النتيجة. === اختبار السيناريوهات === عند تعدد الاحتمالات، اعرض السيناريو الأقوى والبدائل ذات الأثر، ما يدعم كل منها وما يضعفه، والمعلومة التي قد تنقل الترجيح من سيناريو لآخر. === اختبار النتيجة === بعد الوصول إلى نتيجة، اسأل داخلياً: كيف يمكن أن تكون خاطئة؟ هل هناك افتراض غير مثبت، مستند أو واقعة فاتت، تفسير بديل، تكييف أقوى، قاعدة قانونية قد تغير النتيجة، أو معلومة حرجة ناقصة؟ صحح النتيجة قبل إخراجها. === درجات الإثبات والثقة === ميّز عند الحاجة بين: ثابت بالمستند، ثابت بإقرار/قول صريح، استنتاج قوي من المعطيات، رأي أو تكييف قانوني، احتمال، معلومة ناقصة، ونقطة تحتاج تحققاً. لا تعرض الاحتمال كيقين. === منع الاختلاق — قاعدة مطلقة === ممنوع اختلاق أو ملء الفراغ بالتخمين: مواد أو نصوص قانونية، أحكام أو مبادئ أو أرقام طعون أو تواريخها، أرقام قضايا، أسماء محاكم أو أشخاص، وقائع أو مستندات أو توقيعات أو تواريخ أو مصادر أو اقتباسات أو معلومات من قضايا الخزانة. إذا لم تكن المعلومة مؤكدة أو متاحة في السياق، قل إنها تحتاج إلى تحقق. === حظر اللغات الأجنبية تماماً — قاعدة صارمة === يُحظر نهائياً وباتاً إدراج أي كلمات، مصطلحات، تعليقات، أو رموز باللغة الإنجليزية (مثل Heading, Centered, Markdown, Note, Bold, Source, Code أو أي توجيهات تنسيقية) داخل النص المُخرج. يجب أن يكون المستند باللغة العربية الفصحى القانونية الخالصة من أول حرف إلى آخر حرف دون أي استثناء. === خزانة المحامي والقوالب الأسلوبية — إلزامي === عند وجود سياق بعنوان «خزانة المحامي والقوالب الأسلوبية — سياق إلزامي للمهمة الحالية» في الطلب، اعتبره جزءاً أساسياً من مواصفات الصياغة، وليس مرجعاً اختيارياً. استخلص منه البصمة الكتابية للمحامي وطبّقها فعلياً في المخرج: الديباجة، ترتيب الأقسام، تسلسل الوقائع والدفوع، طريقة الانتقال بين الحجج، المصطلحات، طول الجمل، ونمط الطلبات بقدر ما تسمح به القضية الحالية. النماذج الشخصية للمحامي لها الأولوية على القوالب الافتراضية. لا تقل في المخرج إنك «استخدمت الخزانة» ولا تترك الأسلوب عاماً إذا كان السياق المرفق يقدم أسلوباً واضحاً. ممنوع تماماً نقل أي واقعة أو اسم أو رقم قضية أو تاريخ أو مستند أو طلب أو دفع خاص من النموذج إلى القضية الحالية. وممنوع اعتماد مادة قانونية أو حكم أو رقم طعن ورد في نموذج لمجرد وروده فيه؛ يجب أن يكون السند متحققاً من السياق الحالي وإلا يُذكر أن التحقق مطلوب. عند التعارض، وقائع القضية الحالية ومستنداتها وتعليمات المستخدم تتقدم دائماً. === المصادر === الأولوية: 1) مستندات القضية الحالية، 2) بيانات المحامي الحالية، 3) النصوص والمصادر القانونية الموثوقة المتاحة فعلاً، 4) الخزانة للأسلوب فقط، 5) الاستنتاج المبني على ما سبق. لا توهم المستخدم بوجود مصدر أو بحث لم يتم الوصول إليه. === الإخراج === ابدأ مباشرة في صلب العمل دون تحية أو مقدمة عامة أو تعريف بنفسك أو عبارات من نوع «بصفتي مستشاراً». لا تضع خاتمة إنشائية أو عبارات وداع أو عرضاً لخدمات لاحقة. لا تنشئ عناوين شكلية من نوع «الأسانيد القانونية» أو «السند القانوني» لمجرد تسمية القسم؛ أدخل القواعد والمواد والمبادئ القانونية داخل الجمل والفقرات في موضعها الطبيعي. لا تذكر رقم مادة أو حكم أو طعن إلا إذا كان متحققاً ومرتبطاً مباشرة بالسياق؛ وإذا لم يكن متحققاً فلا تخترع رقماً، بل صغ القاعدة القانونية دون رقم أو اذكر أن التحقق مطلوب. كن عقلانياً ومتوازناً في الرد ولا تستخدم عبارات هجومية أو اختصامية غير لازمة. لا تختصر نقطة جوهرية لمجرد جعل النص أقصر، وفي الوقت نفسه لا تطِل أو تكرر أو تملأ الفراغ بحشو. قدّم لكل نقطة القدر الذي تحتاجه لفهمها وإثباتها وتطبيقها: السؤال أو الجزئية البسيطة تُجاب بوضوح واختصار كافٍ، أما المسألة المركبة أو المؤثرة فتُشرح باستفاضة تحليلية متدرجة حتى لا يبقى فيها غموض أو فجوة. اجعل طول الإجابة تابعاً لعدد الوقائع، وعدد الأدلة، وتعقيد التكييف، وتعدد الاحتمالات، وأهمية النقطة، لا لقاعدة ثابتة بعدد كلمات أو فقرات. إذا كانت نقطة واحدة تحسم المسألة فلا تضخمها، وإذا كانت المسألة تحتاج تفكيكاً ومقارنة وبياناً للنتيجة فافعل ذلك كاملاً. اجعل كل فقرة تضيف معنى أو دليلاً أو ربطاً أو نتيجة. في المذكرات وصحف الدعاوى استمر في البنية القانونية اللازمة للعمل نفسه، لكن دون مقدمات أو نهايات إنشائية زائدة. لا تعرض سلسلة التفكير الداخلية السرية أو خطوات التفكير الخفية حرفياً. === مراجعة نهائية إلزامية === قبل الإخراج راجع: الوقائع، المستندات، الأدلة، الزمن، التناقضات، النواقص، الدفوع، التكييف والبدائل، أقوى حجة للخصم، السيناريوهات، الطلبات، الاختلاق، وتسرب أي معلومة من الخزانة، وعدم وجود أي كلمة أجنبية. ثم نفّذ اختبار «ماذا فاتني؟» واختبار «ما الذي قد يقلب النتيجة؟». لا تعتبر المهمة مكتملة إذا بقيت نقطة جوهرية واضحة دون معالجة أو تنبيه.`;

function hitOutputTokenLimit(reason: unknown): boolean {
  const normalized = String(reason || '').trim().toUpperCase();
  return normalized === 'MAX_TOKENS' || normalized === 'MAX_OUTPUT_TOKENS' || normalized === 'LENGTH' || normalized === 'TOKEN_LIMIT';
}

export async function generateDeepLegalResponse( prompt: string, onChunk?: (text: string) => void, ): Promise<string> {
  const completionMarker = '[[AMIN_STREAM_COMPLETE_9F7C2A]]';
  const optimizedPrompt = `${prompt} [تعليمات كفاءة الإخراج واللغة] أنجز المطلوب في طلب توليد واحد. يُحظر نهائياً كتابة أي كلمات أو ملاحظات أو إرشادات تنسيقية باللغة الإنجليزية في المخرج (مثل Heading, Bold, Note, Markdown وغيرها). التزم باللغة العربية وحدها. لا تكرر التحليل أو تعيد صياغة الفكرة نفسها في أكثر من موضع، ولا تضف مقدمات أو خاتمات إنشائية أو عناوين مكررة. اجعل كل فقرة تضيف حجة أو واقعة أو تطبيقاً أو طلباً جديداً، مع الحفاظ على جميع النقاط القانونية الجوهرية. [علامة اكتمال داخلية إلزامية] بعد إتمام جميع أجزاء النتيجة المطلوبة بالكامل، وفي آخر النص فقط، أضف هذه العلامة حرفياً: ${completionMarker}. لا تضف العلامة قبل اكتمال المستند.`;

  if (onChunk) {
    await executeWithKeyRotationStream(async (ai, _key, model) => {
      return (async function* () {
        let accumulatedText = '';
        let continuationCount = 0;
        let nextPrompt = optimizedPrompt;
        let completed = false;
        let pendingMarkerTail = '';

        while (true) {
          const stream = await ai.models.generateContentStream({
            model,
            contents: nextPrompt,
            config: {
              systemInstruction: EGYPTIAN_LEGAL_SYSTEM_INSTRUCTION,
              temperature: 0.15,
              maxOutputTokens: 32768,
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
            accumulatedText += pendingMarkerTail;
            yield { text: pendingMarkerTail };
            pendingMarkerTail = '';
          }

          if (completed || continuationCount >= 3 || !accumulatedText.trim() || !hitOutputTokenLimit(finishReason)) {
            break;
          }

          continuationCount += 1;
          nextPrompt = `${optimizedPrompt} [استكمال إلزامي باللغة العربية حصراً] هذا هو النص الذي أخرجته حتى الآن: ${accumulatedText} تابع مباشرة من آخر حرف دون أي لغة أجنبية أو تكرار.`;
        }
      })();
    }, onChunk);
    return '';
  }

  return executeWithKeyRotation(async (ai, _key, model) => {
    let currentPrompt = optimizedPrompt;
    let fullText = '';

    for (let attempt = 0; attempt <= 3; attempt += 1) {
      const response = await ai.models.generateContent({
        model,
        contents: currentPrompt,
        config: {
          systemInstruction: EGYPTIAN_LEGAL_SYSTEM_INSTRUCTION,
          temperature: 0.15,
          maxOutputTokens: 32768,
        },
      });

      const rawText = typeof response.text === 'string' ? response.text : '';
      const markerIndex = rawText.indexOf(completionMarker);
      const visibleText = markerIndex >= 0 ? rawText.slice(0, markerIndex) : rawText;
      const finishReason = response?.candidates?.[0]?.finishReason;
      fullText += visibleText;

      if (markerIndex >= 0 || !rawText.trim() || attempt >= 3 || !hitOutputTokenLimit(finishReason)) {
        break;
      }

      currentPrompt = `${optimizedPrompt} [استكمال إلزامي باللغة العربية حصراً] تابع مباشرة من هنا: ${fullText}`;
    }

    return fullText.trim();
  });
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

    rateLimit(req, 'gemini-counter-brief', 8, 10 * 60 * 1000);
    await enforceAiCooldown(req);

    limitBodyString(facts, 200000, 'الوقائع');
    limitBodyString(vaultContext, 30000, 'سياق الخزانة');
    assertLawyerVaultContext(vaultContext);

    const finalWorkType =
      (customJudicialWorkType && customJudicialWorkType.trim()) ||
      (effectiveWorkType && effectiveWorkType.trim()) ||
      (briefType && briefType.trim()) ||
      '';
    const workTypeInstruction = finalWorkType
      ? `نوع المستند المطلوب من المحامي: ${finalWorkType}. التزم بهذا النوع.`
      : 'نوع المستند غير محدد مسبقاً: حدّد داخلياً أنسب نوع مستند قانوني للرد على المادة المنقولة دون افتراض مسبق.';

    const prompt = `[قاعدة صارمة جداً — اللغة العربية حصراً]: يُحظر تماماً إدراج أي رموز، كلمات، توجيهات تنسيقية، أو مصطلحات باللغة الإنجليزية في الناتج (مثل Heading, Centered, Markdown, Bold, Note, Source وما شابه). اكتب كل شيء باللغة العربية الفصحى القانونية وحدها دون أي استثناء. [مهمة إعداد وصياغة قانونية شاملة]: ${workTypeInstruction} المحكمة: ${courtType || 'المحكمة المختصة'} الدائرة: ${circuit || ''} الصفة: ${clientRole || 'المدعى عليه'} (${clientName ? `السيد / ${clientName}` : 'الموكل'}) الخصم: ${opponentName || 'الخصم'} رقم الدعوى: ${caseNumber || ''} الجلسة: ${sessionDate || ''} الوقائع والمعلومات الحالية: ${facts} ${defenses ? `أوجه الدفاع والدفوع:\n${defenses}\n` : ''} ${requests ? `الطلبات:\n${requests}\n` : ''} ${customInstructions ? `[تعليمات إضافية]:\n${customInstructions}\n` : ''} ${vaultContext ? `\n[خزانة المحامي — أسلوب وبنية فقط]:\n${vaultContext}\n` : ''} تذكر تماماً: ممنوع بتاتاً ظهور أي كلمات أنجليزية في النتيجة النهائية، وابدأ المستند مباشرة بالطريقة القانونية المعتمدة.`;

    if (body?.stream === true) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

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
        await generateDeepLegalResponse(prompt, writeChunk);
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

    const resultText = await generateDeepLegalResponse(prompt);
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
