import { generateDeepLegalResponse } from './counter-brief.ts';
import { enforceAiCooldown, consumeOperation } from '../auth.ts';
import { rateLimit, limitBodyString } from '../security.ts';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch {} }
    if (body && typeof body.messages === 'string') {
      try { body.messages = JSON.parse(body.messages); } catch { body.messages = null; }
    }
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

    const history = messages.map((m: any) => `${m.role === 'user' ? 'المحامي' : 'أمين'}: ${m.content}`).join('\n\n');
    const latestUserMessage = String(messages[messages.length - 1]?.content || '').trim();

    // لا تعتبر كل طلب كتابة أو فعل أمر تعديلاً على النتيجة؛ فقد يطلب المحامي
    // مذكرة جديدة أو إجابة داخل المحادثة. لا تُحدّث المستند إلا عند وجود طلب
    // صريح يستهدف النتيجة/المستند الحالي أو جزءاً منه، مع إعطاء أولوية لمكان
    // الإخراج إذا قال المستخدم بوضوح إنه يريد الإجابة هنا في الشات.
    const explicitlyWantsChatReply = /(?:في\s*الشات|هنا\s+(?:في\s*)?الشات|داخل\s+(?:هذه\s*)?المحادثة|في\s*المحادثة|هنا\s+في\s+الرد|اكتب(?:لي|\s+لي)?\s+.{0,45}\s+هنا|ابعته(?:ا|الي|اليها)?\s+هنا|ابعتها\s+هنا|اكتبها\s+هنا|اعرضها\s+هنا)/i.test(latestUserMessage);
    const explicitResultTarget = /(?:النتيجة(?:\s+(?:الحالية|المعروضة|نفسها))?|خانة\s+النتيجة|المستند(?:\s+(?:الحالي|الموجود|المعروض))?|المذكرة\s+(?:الحالية|الموجودة|المعروضة)|النص\s+الحالي|داخل\s+(?:المستند|المذكرة|النتيجة)|إلى\s+(?:المستند|المذكرة|النتيجة)|في\s+(?:المستند|المذكرة|النتيجة))/i.test(latestUserMessage);
    const explicitEditAction = /(?:احذف|حذف|امسح|شيل|أضف|اضف|ضيف|إضافة|اضافة|عدّل|عدل|تعديل|غيّر|غير|استبدل|بدّل|بدل|أعد\s+صياغ|اعد\s+صياغ|أعد\s+كتابة|اعد\s+كتابة|صحّح|صحح|اختصر|وسّع|وسع|رتّب|رتب|أدرج|ادرج|اكتب|صيّغ|صيغ|أنشئ|انشئ|جهز|جهّز|اجعل|خلي|حط|انقل|ظبط|زود|remove|delete|add|rewrite|replace|edit|change|insert|move|update)/i.test(latestUserMessage);
    const explicitlyTargetsExistingPart = /(?:الفقرة|الفقرات|الجزء|الأجزاء|العنوان|الترويسة|الخاتمة|الطلبات|الطلب|الدفع|الدفوع|التاريخ|الاسم|الجملة|السطر|المقطع|الصفحة|بند\s+رقم|الفقرة\s+رقم|(?:عدل|عدّل|ظبط|غير|غيّر|اختصر|وسع|وسّع|شيل|احذف|ضيف|أضف|اكتب)ها|(?:عدل|عدّل|ظبط|غير|غيّر)ه)/i.test(latestUserMessage);
    const requestsEdit = !explicitlyWantsChatReply && explicitEditAction && (explicitResultTarget || explicitlyTargetsExistingPart);
    
    const taskLabel = taskType === 'deconstruct' ? 'تفنيد والرد على مستند' : taskType === 'qualify' ? 'تكييف قانوني للنزاع' : 'صياغة قانونية';

    const prompt = `أنت أمين، مساعد قانوني مصري شاطر وتفهم العامية المصرية بطلاقة. هذه متابعة لمهمة ${taskLabel}. المطلوب منك إرجاع كائن JSON صالح فقط بدون أية زيادات، بصيغة: {"reply":"الإجابة أو النص المطلوب داخل الشات","updatedResult":null} تعليمات الإخراج المباشر: ابدأ من أول كلمة بالإجابة أو النص المطلوب مباشرة. ممنوع افتتاح الرد بكلمات تمهيدية مثل «بالطبع»، «بالتأكيد»، «حاضر»، «إليك»، «سأقوم»، أو شرح ما ستفعله؛ نفّذ المطلوب فوراً. إذا كانت المهمة تعديلاً، أخرج المستند المعدل مباشرة دون إعلان مسبق. تعليمات الهيكلة والتنسيق والتعامل مع العامية: 1. افهم قصد المحامي سواء تحدث بالفصحى أو بالعامية المصرية (مثل: "خليها كذا"، "غير دي لـ كذا"، "ظبط التاريخ"، "شيل الحته دي"). 2. ميّز بدقة بين مكان الإجابة وبين تعديل المستند: - إذا طلب المحامي كتابة مذكرة جديدة أو صياغة نص أو شرح/إجابة داخل الشات أو المحادثة، فاكتب المحتوى المطلوب كاملاً في "reply" واجعل "updatedResult": null. لا تعتبر كلمات مثل "اكتب" أو "مذكرة" وحدها أمراً بتعديل النتيجة. - لا تضع نصاً في "updatedResult" إلا إذا كان الطلب صريحاً بتعديل المستند/المذكرة/النتيجة الحالية أو جزء محدد منها. عندها فقط ضع النسخة المعدلة كاملة في "updatedResult" واجعل "reply" تأكيداً قصيراً. - الأسئلة والمناقشات والاستفسارات تكون إجاباتها في "reply" دائماً، و"updatedResult": null. 3. استخدم الأسطر الحقيقية الجديدة (Newlines) للفصل بين الفقرات والسطور، ولا تكتب الرمز "n\\" أو "\\n" كأحرف نصية صريحة إطلاقاً. 4. حافظ على نص المستند الأصلي بالكامل وغير فقط ما طلبه المحامي دون إعادة كتابة الترويسات بلا داعٍ. [سياق القضية الأصلي] ${String(originalContext || '').slice(0, 100000)} [النتيجة الحالية للمستند] ${result} [سجل المحادثة] ${history} أرجع JSON فقط:`;

    const rawAnswer = await generateDeepLegalResponse(prompt);
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
      // Remove common conversational lead-ins if the model emits one despite
      // the direct-output instruction; keep the actual legal answer untouched.
      answer = answer.replace(/^(?:بالطبع|بالتأكيد|حاضر|تمام|أكيد|يسعدني)[،,:!؛\s]+(?:إليك|هذا|هذه|سأقوم|سأبدأ|سأكتب|سأعد|سأراجع|سأعمل|يمكنني|تفضل|تفضّل)?[^\n]*\n+/i, '').trim();
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

    // حماية نهائية: لا نسمح للنموذج بتغيير خانة النتيجة إذا لم يصنّف
    // طلب المستخدم صراحةً كتعديل للمستند الموجود.
    if (!requestsEdit) updatedResult = null;
    if (updatedResult) {
      updatedResult = sanitizeLegalText(updatedResult);
    }
    if (answer) {
      answer = sanitizeLegalText(answer);
    }

    // إذا أعاد النموذج تأكيداً كاذباً بأنه عدّل المستند رغم أن الطلب للمحادثة،
    // نطلب منه إجابة فعلية داخل الشات بدلاً من عرض رسالة نجاح مضللة.
    if (!requestsEdit && /(?:تم\s+(?:تعديل|تحديث|إضافة|اضافة|حذف)|عدلت\s+(?:المستند|النتيجة)|تم تعديل المطلوب في المستند|تم تحديث النتيجة بنجاح)/i.test(answer)) {
      try {
        const chatOnlyPrompt = `أجب على أحدث رسالة من المحامي داخل الشات فقط. لا تعدّل المستند الحالي ولا تقل إنك عدّلته، ولا تُرجع نسخة بديلة منه. إذا طلب كتابة مذكرة أو نص، فاكتب النص المطلوب كاملاً هنا في الرد. إذا كان سؤالاً، فأجب عنه مباشرة. أعد الإجابة فقط دون JSON.\n\n[سياق القضية]\n${String(originalContext || '').slice(0, 100000)}\n\n[النتيجة للاطلاع والسياق فقط، لا تعدّلها]\n${result}\n\n[سجل المحادثة]\n${history}\n\n[أحدث طلب]\n${latestUserMessage}`;
        const chatOnlyAnswer = String(await generateDeepLegalResponse(chatOnlyPrompt) || '').trim();
        if (chatOnlyAnswer) answer = sanitizeLegalText(chatOnlyAnswer);
      } catch (chatRecoveryError: any) {
        console.warn('Legal chat-only response recovery failed:', chatRecoveryError?.message || 'unknown error');
      }
      updatedResult = null;
    }

    if (requestsEdit && !updatedResult) {
      try {
        const recoveryPrompt = `قم بتعديل النتيجة الحالية بناءً على طلب المحامي (سواء بالعامية أو الفصحى). أعد النص الكامل النهائي المعدل فقط بدون رموز "n\\" أو "\\n" نصية. [طلب المحامي] ${latestUserMessage} [النتيجة الحالية] ${result}`;

        const recoveredRaw = String(await generateDeepLegalResponse(recoveryPrompt) || '').trim();
        let recoveredResult = sanitizeLegalText(recoveredRaw);
        
        const minimumDocumentLength = Math.min(300, Math.max(120, Math.floor(result.trim().length * 0.45)));
        if (recoveredResult.length >= minimumDocumentLength) {
          updatedResult = recoveredResult;
          answer = 'تم تحديث النتيجة بنجاح.';
        }
      } catch (recoveryError: any) {
        console.warn('Legal chat result-update recovery failed:', recoveryError?.message || 'unknown error');
      }
    }

    if (!answer.trim()) {
      const err: any = new Error('لم تُنتج خدمة الذكاء الاصطناعي إجابة هذه المرة.');
      err.statusCode = 503;
      throw err;
    }

    const usage = await consumeOperation(req, 'gemini-operation');
    return res.status(200).json({ result: answer, updatedResult, remainingCredits: usage.remainingCredits, trialRemaining: usage.trialRemaining });
  } catch (err: any) {
    console.error('Error in /api/gemini/chat:', {
      message: err?.message || 'unknown error',
      geminiCause: err?.geminiError?.message || err?.cause?.geminiError?.message || null,
      openRouterCause: err?.openRouterError?.message || err?.cause?.openRouterError?.message || err?.cause?.message || null,
      status: err?.statusCode || err?.status || null,
    });
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
