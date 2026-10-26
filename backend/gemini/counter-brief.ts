import { executeWithKeyRotation, executeWithKeyRotationStream } from '../keyRotation.ts';
import { enforceAiCooldown, consumeOperation } from '../auth.ts';
import { rateLimit, limitBodyString } from '../security.ts';

export const EGYPTIAN_LEGAL_SYSTEM_INSTRUCTION = `أنت «أمين»؛ مساعد قانوني قضائي مصري شديد الذكاء والانتباه والدقة، تعمل كمساعد مهني للمحامي المصري في تحليل القضايا والمستندات وصياغة الأعمال القضائية، لا كمجرد مولّد نصوص. === تحليل المستندات وتقارير الخبراء ودعاوى الخصم — إلزامي === قم بفحص وتحليل كافة المستندات المقدمة، ومذكرات الخصوم، وصحف الدعاوى، وتقارير الخبراء هندسياً وحسابياً وقانونياً بعمق شديد. استخرج التناقضات، ونقاط العوار في تقارير الخبراء، ودلالة كل مستند وما يثبته وما لا يثبته، وابنِ عليها الرد الموضوعي والقانوني السليم وتفنيد دفوع الخصم بنداً بنداً. نطاق عملك شامل بحسب وقائع كل مهمة، ويشمل الأعمال المدنية والجنائية والإدارية ومجلس الدولة والتجارية والعمالية والأحوال الشخصية والتنفيذ والتحقيقات والعقود والإعلانات والدعاوى والمذكرات والدفوع والتفنيد والرد على المستندات والاستئناف والنقض والطعون وسائر الأعمال القانونية والقضائية ذات الصلة. === معيار التنقيب عن الثغرات والأمانة المهنية — إلزامي === افحص بعمق كل ما قد يؤثر فعلاً في المركز القانوني أو الإثبات أو الإجراءات أو النتيجة، بما في ذلك التناقضات المباشرة وغير المباشرة، والتسلسل الزمني، والأرقام والحسابات، والصفة والمصلحة والاختصاص والقبول والمواعيد والإعلانات والتوقيعات وحجية المستندات ونقص الأدلة وأوجه مخالفة القانون. إذا لم تجد بعد الفحص دفوعاً أو ثغرات جوهرية حقيقية مدعومة، فقل صراحةً: «لا توجد دفوع جوهرية إضافية بناءً على الأوراق المتاحة». === خزانة المحامي والقوالب الأسلوبية — إلزامي === عند وجود سياق بعنوان «خزانة المحامي والقوالب الأسلوبية» في الطلب، اعتبره أساساً إلزامياً للبناء: حافظ على هيكله وترتيب أقسامه والدفوع والبنود والمصطلحات القانونية وديباجته وخاتمته. لا تقل في المخرج إنك «استخدمت الخزانة». ابدأ مباشرة بأول سطر من الديباجة القانونية المناسبة دون تحية أو مقدمة عامة أو عبارات مثل «بصفتي مستشاراً».`;

export async function generateDeepLegalResponse(
  prompt: string,
  onChunk?: (text: string) => void,
  options: { legalResearch?: boolean } = {}
): Promise<string> {
  const completionMarker = '[[AMIN_STREAM_COMPLETE_9F7C2A]]';
  const optimizedPrompt = `${prompt} [تعليمات كفاءة الإخراج وتحليل المستندات] حلل كافة مستندات الخصم وتقارير الخبراء والوقائع بدقة تامة، وأجزاء المذكرة للنهاية دون أي توقف أو اقتطاع. [علامة اكتمال داخلية إلزامية] بعد إتمام جميع أجزاء النتيجة المطلوبة بالكامل حتى نهاية الطلبات الختامية، وفي آخر سطر فقط، أضف هذه العلامة حرفياً: ${completionMarker}.`;

  // تنفيذ التوليد مع حلقة استكمال ذكية في الخلفية تضمن جلب النص كاملاً للنهاية
  return executeWithKeyRotation(async (ai, _key, model) => {
    let currentPrompt = optimizedPrompt;
    let fullText = '';

    for (let attempt = 0; attempt <= 8; attempt += 1) {
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
      
      fullText += visibleText;

      // إذا ظهرت علامة الاكتمال أو توقف النص عن الزيادة، ننهي التكرار
      if (markerIndex >= 0 || !rawText.trim() || visibleText.length < 50) {
        break;
      }

      // إذا لم تكتمل المذكرة ووصل للحد الأقصى، نأخذ آخر جزء ونطلب منه المتابعة فوراً
      const lastChunkTail = fullText.slice(-500);
      currentPrompt = `${optimizedPrompt}\n\n[استكمال إلزامي ودقيق]: توقف النص السابق عند: "...${lastChunkTail}"\nتابع صياغة وتكملة المستند القانوني والمذكرة فوراً من نقطة التوقف وبدون أي تكرار، حتى تصل إلى الطلبات الختامية وعلامة الاكتمال ${completionMarker}.`;
    }

    const finalCleanedText = fullText.replace(new RegExp(completionMarker, 'g'), '').trim();

    // إذا تم تمرير دالة بث (onChunk)، نقوم بإرسال النص كاملاً مجتمعاً وآمناً لمنع أي تقطيع في الواجهة
    if (onChunk && finalCleanedText) {
      onChunk(finalCleanedText);
    }

    return finalCleanedText;
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
    const workTypeInstruction = `نوع المستند المطلوب: ${finalWorkType}. قم بفحص وتحليل مستندات الخصم وتقارير الخبراء والرد عليها تفصيلياً حتى نهايتها.`;

    const prompt = `[مهمة إعداد وتحليل مستندات وصياغة قانونية شاملة]: ${workTypeInstruction} المحكمة: ${courtType || 'المحكمة المختصة'} الدائرة: ${circuit || ''} صفة الموكل: ${clientRole || 'الموكل'} (${clientName || ''}) الخصم: ${opponentName || ''} رقم الدعوى: ${caseNumber || ''} الجلسة: ${sessionDate || ''} الوقائع ومستندات الخصم وتقارير الخبراء المراد تفنيدها وتحليلها: ${facts} ${defenses ? `أوجه الدفاع:\n${defenses}\n` : ''} ${requests ? `الطلبات:\n${requests}\n` : ''} ${customInstructions ? `[تعليمات إضافية]:\n${customInstructions}\n` : ''} ${vaultContext ? `\n[خزانة المحامي — أسلوب وبنية فقط]:\n${vaultContext}\n` : ''}`;

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
  }
}
