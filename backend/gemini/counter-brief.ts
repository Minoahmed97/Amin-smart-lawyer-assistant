import { executeWithKeyRotation, executeWithKeyRotationStream } from '../keyRotation.ts';
import { enforceAiCooldown, consumeOperation } from '../auth.ts';
import { rateLimit, limitBodyString } from '../security.ts';

export const EGYPTIAN_LEGAL_SYSTEM_INSTRUCTION = `أنت «أمين»؛ مساعد قانوني قضائي مصري شديد الذكاء والانتباه والدقة، تعمل كمساعد مهني للمحامي المصري في تحليل القضايا والمستندات وصياغة الأعمال القضائية، لا كمجرد مولّد نصوص. === تحليل المستندات وتقارير الخبراء ودعاوى الخصم — إلزامي === قم بفحص وتحليل كافة المستندات المقدمة، ومذكرات الخصوم، وصحف الدعاوى، وتقارير الخبراء هندسياً وحسابياً وقانونياً بعمق شديد. استخرج التناقضات، ونقاط العوار في تقارير الخبراء، ودلالة كل مستند وما يثبته وما لا يثبته، وابنِ عليها الرد الم الموضوعي والقانوني السليم وتفنيد دفوع الخصم بنداً بنداً. نطاق عملك شامل بحسب وقائع كل مهمة، ويشمل الأعمال المدنية والجنائية والإدارية ومجلس الدولة والتجارية والعمالية والأحوال الشخصية والتنفيذ والتحقيقات والعقود والإعلانات والدعاوى والمذكرات والدفوع والتفنيد والرد على المستندات والاستئناف والنقض والطعون وسائر الأعمال القانونية والقضائية ذات الصلة. === معيار التنقيب عن الثغرات والأمانة المهنية — إلزامي === افحص بعمق كل ما قد يؤثر فعلاً في المركز القانوني أو الإثبات أو الإجراءات أو النتيجة، بما في ذلك التناقضات المباشرة وغير المباشرة، والتسلسل الزمني، والأرقام والحسابات، والصفة والمصلحة والاختصاص والقبول والمواعيد والإعلانات والتوقيعات وحجية المستندات ونقص الأدلة وأوجه مخالفة القانون. إذا لم تجد بعد الفحص دفوعاً أو ثغرات جوهرية حقيقية مدعومة، فقل صراحةً: «لا توجد دفوع جوهرية إضافية بناءً على الأوراق المتاحة». === خزانة المحامي والقوالب الأسلوبية — إلزامي === عند وجود سياق بعنوان «خزانة المحامي والقوالب الأسلوبية» في الطلب، اعتبره أساساً إلزامياً للبناء: حافظ على هيكله وترتيب أقسامه والدفوع والبنود والمصطلحات القانونية وديباجته وخاتمته. لا تقل في المخرج إنك «استخدمت الخزانة». ابدأ مباشرة بأول سطر من الديباجة القانونية المناسبة دون تحية أو مقدمة عامة أو عبارات مثل «بصفتي مستشاراً».`;

function hitOutputTokenLimit(reason: unknown): boolean {
  const normalized = String(reason || '').trim().toUpperCase();
  return normalized === 'MAX_TOKENS' || normalized === 'MAX_OUTPUT_TOKENS' || normalized === 'LENGTH' || normalized === 'STOP' || normalized === '';
}

export async function generateDeepLegalResponse( prompt: string, onChunk?: (text: string) => void, options: { legalResearch?: boolean } = {}, ): Promise<string> {
  const completionMarker = '[[AMIN_STREAM_COMPLETE_9F7C2A]]';
  const optimizedPrompt = `${prompt} [تعليمات كفاءة الإخراج وتحليل المستندات] حلل كافة مستندات الخصم وتقارير الخبراء والوقائع بدقة تامة، وأجزاء المذكرة للنهاية. [علامة اكتمال داخلية إلزامية] بعد إتمام جميع أجزاء النتيجة المطلوبة بالكامل حتى نهاية الطلبات الختامية، وفي آخر سطر فقط، أضف هذه العلامة حرفياً: ${completionMarker}.`;

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

          if (completed || continuationCount >= 6) {
            break;
          }

          continuationCount += 1;
          const lastChunkTail = accumulatedText.slice(-400);
          nextPrompt = `${optimizedPrompt}\n\n[استكمال إلزامي] توقف النص عند: "...${lastChunkTail}"\nتابع صياغة المستند فوراً ودون تكرار حتى الطلبات الختامية وعلامة الاكتمال ${completionMarker}.`;
        }
      })();
    }, onChunk);
    return '';
  }

  return executeWithKeyRotation(async (ai, _key, model) => {
    let currentPrompt = optimizedPrompt;
    let fullText = '';

    for (let attempt = 0; attempt <= 6; attempt += 1) {
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
      const finishReason = String(response?.candidates?.[0]?.finishReason || '').toUpperCase();
      const markerIndex = rawText.indexOf(completionMarker);
      const visibleText = markerIndex >= 0 ? rawText.slice(0, markerIndex) : rawText;
      fullText += visibleText;

      if (markerIndex >= 0 || !rawText.trim() || attempt >= 6) {
        break;
      }

      const lastChunkTail = fullText.slice(-400);
      currentPrompt = `${optimizedPrompt}\n\n[استكمال إلزامي] توقف النص عند: "...${lastChunkTail}"\nتابع الكتابة فوراً حتى الطلبات الختامية وعلامة الاكتمال ${completionMarker}.`;
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

    // دعم طلبات شات مناقشة النتيجة وتعديلها لمنع ظهور خطأ Failed to fetch
    const { message, currentResult, taskType, courtType, circuit, briefType, judicialWorkType, customJudicialWorkType, clientRole, clientName, opponentName, caseNumber, sessionDate, facts, defenses, requests, customInstructions, vaultContext } = body || {};

    if (message && typeof message === 'string') {
      rateLimit(req, 'gemini-chat-refine', 20, 10 * 60 * 1000);
      const chatPrompt = `أنت «أمين»؛ مساعد قانوني مصري. بناءً على المستند القانوني الحالي:\n---\n${currentResult || ''}\n---\nطلب المستخدم / سؤاله للتعديل أو الإضافة:\n${message}\n\nقم بتعديل أو الرد على استفسار المحامي بدقة واحترافية قانونية كاملة. أخرج النص المعدل أو الرد مباشرة.`;
      const chatResult = await generateDeepLegalResponse(chatPrompt, undefined, { legalResearch: false });
      return res.json({ result: chatResult });
    }

    if (!facts || !facts.trim()) {
      return res.status(400).json({ error: 'يرجى كتابة وقائع الدعوى أو المستندات المطلوب تحليلها والرد عليها.' });
    }

    rateLimit(req, 'gemini-counter-brief', 8, 10 * 60 * 1000);
    await enforceAiCooldown(req);

    limitBodyString(facts, 200000, 'الوقائع والمستندات');
    limitBodyString(vaultContext, 30000, 'سياق الخزانة');

    const finalWorkType = (customJudicialWorkType && customJudicialWorkType.trim()) || (judicialWorkType && judicialWorkType.trim()) || (briefType && briefType.trim()) || 'مذكرة دفاع أو رد على مستندات وتقارير';
    const workTypeInstruction = `نوع المستند المطلوب: ${finalWorkType}. قم بفحص وتحليل مستندات الخصم وتقارير الخبراء والرد عليها تفصيلياً.`;

    const prompt = `[مهمة إعداد وتحليل مستندات وصياغة قانونية]: ${workTypeInstruction} المحكمة: ${courtType || 'المحكمة المختصة'} الدائرة: ${circuit || ''} صفة الموكل: ${clientRole || 'الموكل'} (${clientName || ''}) الخصم: ${opponentName || ''} رقم الدعوى: ${caseNumber || ''} الجلسة: ${sessionDate || ''} الوقائع ومستندات الخصم وتقارير الخبراء المراد تفنيدها وتحليلها: ${facts} ${defenses ? `أوجه الدفاع:\n${defenses}\n` : ''} ${requests ? `الطلبات:\n${requests}\n` : ''} ${customInstructions ? `[تعليمات إضافية]:\n${customInstructions}\n` : ''} ${vaultContext ? `\n[خزانة المحامي — أسلوب وبنية فقط]:\n${vaultContext}\n` : ''}`;

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
        await generateDeepLegalResponse(prompt, writeChunk, { legalResearch: false });
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

    const resultText = await generateDeepLegalResponse(prompt, undefined, { legalResearch: false });
    if (!resultText.trim()) throw new Error('لم تُنتج خدمة الذكاء الاصطناعي نتيجة صالحة.');
    const usage = await consumeOperation(req, 'gemini-operation');
    return res.json({ result: resultText, remainingCredits: usage.remainingCredits, trialRemaining: usage.trialRemaining });
  } catch (err: any) {
    console.error('Error in /api/gemini/counter-brief:', err);
    const statusCode = Number(err?.statusCode);
    const status = Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600 ? statusCode : 500;
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
