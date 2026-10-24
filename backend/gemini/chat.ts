import { executeWithKeyRotation } from '../keyRotation.ts';
import { enforceAiCooldown, consumeOperation } from '../auth.ts';
import { rateLimit, limitBodyString } from '../security.ts';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch {} }
    const { taskType, originalContext, result, messages } = body || {};
    if (!['deconstruct', 'qualify', 'draft'].includes(taskType)) return res.status(400).json({ error: 'نوع المهمة غير صالح للدردشة القانونية.' });
    if (typeof result !== 'string' || !result.trim()) return res.status(400).json({ error: 'لا توجد نتيجة أصلية لمناقشتها.' });
    if (!Array.isArray(messages) || !messages.length || messages.length > 40) return res.status(400).json({ error: 'سجل المحادثة غير صالح.' });
    
    limitBodyString(originalContext, 100000, 'سياق القضية');
    limitBodyString(result, 120000, 'النتيجة الأصلية');
    
    for (const message of messages) {
      if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') return res.status(400).json({ error: 'رسالة محادثة غير صالحة.' });
      limitBodyString(message.content, 10000, 'رسالة المحادثة');
    }
    if (messages[messages.length - 1]?.role !== 'user') return res.status(400).json({ error: 'يجب أن تنتهي المحادثة بسؤال من المستخدم.' });

    rateLimit(req, 'gemini-legal-chat', 20, 10 * 60 * 1000);
    await enforceAiCooldown(req);

    // سجل المحادثة المرسل للنموذج يقتصر على آخر 8 رسائل وبحد أقصى 2500 حرف لكل رسالة.
    // لا نقص سياق القضية أو المستند الأصلي حتى لا نحذف وقائع قانونية قد يحتاجها الرد.
    const recentMessages = messages.slice(-8);
    const history = recentMessages.map((m: any) => `${m.role === 'user' ? 'المحامي' : 'أمين'}: ${m.content.slice(-2500)}`).join('\n\n');
    const latestUserMessage = String(messages[messages.length - 1]?.content || '').trim();

    // لا تعتبر كلمة «اكتب» وحدها طلب تعديل للمستند؛ قد يريد المحامي نصاً قابلاً للنسخ في الشات.
    // تُعطى أسئلة المحامي وطلبه الصريح للرد داخل المحادثة أولوية، إلا إذا طلب تعديل النتيجة بوضوح أيضاً.
    const requestsChatReply = /(?:هنا\s+في\s+(?:الشات|المحادثة)|(?:في|داخل)\s+(?:الشات|المحادثة)|اكتب(?:ها|ه)?\s*(?:لي)?\s+في\s+(?:الشات|المحادثة)|جاوبني|رد\s+علي(?:ا|ّ)|اشرح(?:لي)?|وضح(?:لي)?|ناقشني)/i.test(latestUserMessage);
    const startsWithQuestion = /^(?:هل|إزاي|ازاي|ليه|لماذا|ماذا|ما\s+(?:معنى|هو|رأيك)|ايه\s+(?:هو|معنى|رأيك)|فين|متى|أين|مين|ممكن\s+(?:تشرح|توضح)|عايز\s+أفهم|عاوز\s+أفهم)/i.test(latestUserMessage);
    const hasResultTarget = /(?:النتيجة|مربع\s+النتيجة|المستند|المذكرة|النص\s+الحالي|الملف\s+الحالي)/i.test(latestUserMessage);
    const editDirective = /(?:احذف|حذف|امسح|شيل|شيله|شيلها|أضف|اضف|ضيف|ضيفه|ضيفها|عدّل|عدل|عدلها|عدليه|غيّر|غير|غيرها|استبدل|بدّل|بدل|بدلها|أعد\s+صياغ|اعد\s+صياغ|أعد\s+كتابة|اعد\s+كتابة|صحّح|صحح|صححلي|اختصر|وسّع|وسع|رتّب|رتب|ضع|أدرج|ادرج|اجعل|خليها|خليه|حط|حطه|حطها|انقل|نقلها|قدّم|قدم|أخّر|اخر|أدخل|ادخل|ظبط|ظبطها|زود|زودها|عايزك\s+(?:تغير|تعدل)|عاوزك\s+(?:تغير|تعدل)|remove|delete|add|rewrite|replace|edit|change|insert|move|update)/i.test(latestUserMessage);
    const writesDirectlyToResult = /(?:اكتب|اكتبها|اكتب\s+لي|اكتبلي|دوّن|دون).{0,100}(?:في|داخل|ضمن)\s+(?:النتيجة|مربع\s+النتيجة|المستند|المذكرة)|(?:في|داخل|ضمن)\s+(?:النتيجة|مربع\s+النتيجة|المستند|المذكرة).{0,100}(?:اكتب|اكتبها|اكتب\s+لي|اكتبلي|دوّن|دون)/i.test(latestUserMessage);
    const requestsEdit = writesDirectlyToResult || (!startsWithQuestion && editDirective && (!requestsChatReply || hasResultTarget));
    
    const taskLabel = taskType === 'deconstruct' ? 'تفنيد والرد على مستند' : taskType === 'qualify' ? 'تكييف قانوني للنزاع' : 'صياغة قانونية';

    const prompt = `أنت أمين، مساعد قانوني مصري شاطر وتفهم العامية المصرية بطلاقة. هذه متابعة لمهمة ${taskLabel}.
المطلوب منك إرجاع كائن JSON صالح فقط بدون أية زيادات، بصيغة:
{"reply":"رسالة قصيرة للمحامي","updatedResult":null}

تعليمات الهيكلة والتنسيق والتعامل مع العامية:
1. افهم قصد المحامي سواء تحدث بالفصحى أو بالعامية المصرية (مثل: "خليها كذا"، "غير دي لـ كذا"، "ظبط التاريخ"، "شيل الحته دي").
2. ميّز بدقة بين:
   - طلبات التعديل الصريحة على المستند: ضع النسخة المعدلة كاملة في "updatedResult" واجعل الرد المختصر في "reply".
   - الأسئلة والمناقشات أو طلب كتابة نص داخل الشات: اجعل "updatedResult": null وضع الإجابة أو النص المطلوب في "reply" فقط. كلمة «اكتب» وحدها لا تعني تعديل المستند.
   - إذا جمع المحامي صراحةً بين تعديل المستند وسؤال أو شرح، نفّذ التعديل في "updatedResult" وأجب عن سؤاله في "reply".
3. استخدم الأسطر الحقيقية الجديدة (Newlines) للفصل بين الفقرات والسطور، ولا تكتب الرمز "n\\" أو "\\n" كأحرف نصية صريحة إطلاقاً.
4. حافظ على نص المستند الأصلي بالكامل وغير فقط ما طلبه المحامي دون إعادة كتابة الترويسات بلا داعٍ.

[سياق القضية الأصلي]
${String(originalContext || '').slice(0, 100000)}

[النتيجة الحالية للمستند]
${result}

[سجل المحادثة]
${history}

أرجع JSON فقط:`;

    // استخدم مسار تدوير المفاتيح المشترك مباشرةً، لكن بتعليمات خاصة بالدردشة.
    // خدمة الصياغة العامة تضيف تعليمات طويلة وعلامة اكتمال لا يحتاجهما رد الشات،
    // ما يزيد حجم الطلب وزمنه حتى عندما يكون سؤال المحامي قصيراً.
    const rawAnswer = await executeWithKeyRotation(async (ai, _key, model) => {
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          systemInstruction: `أنت أمين، مساعد قانوني مصري محترف يتابع المحامي داخل دردشة مرتبطة بقضية ومستند. افهم الفصحى والعامية المصرية. اعتمد على السياق والنتيجة وسجل المحادثة المرفق، ولا تختلق وقائع أو مواد قانونية أو أرقام أحكام أو طعون أو مصادر. ميّز ما هو ثابت عما يحتاج إلى تحقق. أخرج JSON صالحاً فقط وفق الحقول المطلوبة في رسالة المستخدم. في السؤال أو النقاش، أجب مباشرة بإيجاز مفيد واجعل updatedResult قيمة null. إذا طلب المحامي صراحة تعديل المستند، فغيّر المطلوب وحده وحافظ على بقية النص كاملاً واجعل updatedResult النص المعدل كاملاً. لا تدّعِ تنفيذ تعديل إذا لم تنفذه.`,
          temperature: 0.15,
          // الأسئلة العادية لا تحتاج ميزانية إخراج مستند كامل؛ أبقِ مساحة أكبر للتعديل الكامل.
          maxOutputTokens: requestsEdit ? 24576 : 2048,
          responseMimeType: 'application/json',
        },
      });
      return typeof response?.text === 'string' ? response.text : '';
    });
    let answer = '';
    let updatedResult: string | null = null;

    // دالة تنظيف النصوص ومعالجة رموز الأسطر الملتصقة لضمان صفاء النص تماماً
    const sanitizeLegalText = (text: string) => {
      if (!text) return '';
      return text
        .replace(/^```(?:json|text|markdown)?\s*/i, '')
        .replace(/\s*```$/, '')
        .replace(/^\{\s*"reply"\s*:\s*".*?"\s*,\s*"updatedResult"\s*:\s*"/s, '')
        .replace(/^"reply"\s*:\s*".*?"\s*,\s*"updatedResult"\s*:\s*"/s, '')
        .replace(/\"\}\s*$/, '')
        .replace(/(?:\\n|n\\)+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    };

    try {
      const trimmedAnswer = rawAnswer.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const jsonStart = trimmedAnswer.indexOf('{');
      const jsonEnd = trimmedAnswer.lastIndexOf('}');
      const cleaned = jsonStart >= 0 && jsonEnd > jsonStart ? trimmedAnswer.slice(jsonStart, jsonEnd + 1) : trimmedAnswer;
      const parsed = JSON.parse(cleaned);
      
      answer = typeof parsed?.reply === 'string' ? parsed.reply.trim() : '';
      updatedResult = typeof parsed?.updatedResult === 'string' && parsed.updatedResult.trim() ? parsed.updatedResult.trim() : null;
    } catch {
      const plainAnswer = sanitizeLegalText(rawAnswer);
      const minimumDocumentLength = Math.min(300, Math.max(120, Math.floor(result.trim().length * 0.45)));
      if (requestsEdit && plainAnswer.length >= minimumDocumentLength) {
        updatedResult = plainAnswer;
        answer = 'تم تعديل المطلوب في المستند.';
      } else {
        answer = plainAnswer;
      }
    }

    if (!requestsEdit) updatedResult = null;
    if (updatedResult) {
      updatedResult = sanitizeLegalText(updatedResult);
    }
    if (answer) {
      answer = sanitizeLegalText(answer);
    }

    // لا نطلق طلب توليد ثانٍ مستقلاً عند فشل استخراج التعديل؛ كل استدعاء جديد
    // يملك مهلة تدوير كاملة خاصة به وقد يتجاوز مع الطلب الأول حد Vercel ويظهر للعميل Failed to fetch.
    // بدلاً من ذلك نوضح أن التعديل لم يُطبّق، ونحافظ على النتيجة الحالية دون إرجاع مستند غير مكتمل.
    if (requestsEdit && !updatedResult) {
      answer = answer || 'لم أتمكن من تأكيد التعديل على المستند في هذه المحاولة؛ لم يتم تغيير النتيجة الحالية. أعد إرسال طلب التعديل بصياغة محددة.';
    }

    if (!answer.trim()) {
      const err: any = new Error('لم تُنتج خدمة الذكاء الاصطناعي إجابة هذه المرة.');
      err.statusCode = 503;
      throw err;
    }

    const usage = await consumeOperation(req, 'gemini-operation');
    return res.status(200).json({ result: answer, updatedResult, remainingCredits: usage.remainingCredits, trialRemaining: usage.trialRemaining });
  } catch (err: any) {
    console.error('Error in /api/gemini/chat:', err?.message || 'unknown error');
    const code = Number(err?.statusCode || err?.status);
    const status = Number.isInteger(code) && code >= 400 && code < 600 ? code : 500;
    const retryAfter = Number(err?.retryAfter || 0);
    if (status === 429 && retryAfter > 0) res.setHeader('Retry-After', String(retryAfter));
    return res.status(status).json({
      error: err?.message || 'تعذر إتمام الدردشة القانونية. حاول مرة أخرى بعد قليل.',
      ...(status === 429 && retryAfter > 0 ? { retryAfter } : {}),
    });
  }
}
