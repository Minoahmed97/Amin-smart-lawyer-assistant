import { generateDeepLegalResponse } from './counter-brief.ts';
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

    const history = messages.map((m: any) => `${m.role === 'user' ? 'المحامي' : 'أمين'}: ${m.content}`).join('\n\n');
    const latestUserMessage = String(messages[messages.length - 1]?.content || '').trim();

    // افصل بين إخراج نص داخل المحادثة وتعديل المستند نفسه.
    const asksForChatOutput = /(?:في\s+(?:ه(?:ذا|نا)\s+)?(?:الشات|المحادثة)|هنا\s+(?:في\s+)?(?:الشات|المحادثة)|داخل\s+(?:الشات|المحادثة)|بالشات|بالمحادثة|اكتب(?:لي|لنا)?\s+(?:هنا|في\s+(?:الشات|المحادثة))|جاوب(?:ني)?\s+(?:هنا|في\s+(?:الشات|المحادثة))|رد(?:لي|\s+عليّ|\s+عليا)?\s+(?:هنا|في\s+(?:الشات|المحادثة))|من\s+غير\s+تعديل|بدون\s+تعديل|لا\s+تعدل(?:\s+النتيجة)?|ما\s+تعدلش(?:\s+النتيجة)?|ما\s+تغيرش(?:\s+النتيجة)?|بدل\s+ما\s+تعدل)/i.test(latestUserMessage);
    const explicitlyTargetsResult = /(?:في\s+(?:النتيجة|المستند|النص)|على\s+(?:النتيجة|المستند|النص)|داخل\s+(?:النتيجة|المستند|النص)|من\s+(?:النتيجة|المستند|النص)|بالنتيجة|بالمستند|النتيجة\s+(?:الحالية|المعروضة|المحفوظة)|المستند\s+(?:الحالي|المعروض|المحفوظ)|احذف.{0,50}من\s+(?:النتيجة|المستند)|امسح.{0,50}من\s+(?:النتيجة|المستند)|شيل.{0,50}من\s+(?:النتيجة|المستند))/i.test(latestUserMessage);
    const hasEditVerb = /(?:احذف|حذف|امسح|شيل|أضف|اضف|ضيف|إضافة|اضافة|عدّل|عدل|تعديل|غيّر|غير|استبدل|بدّل|بدل|أعد صياغ|اعد صياغ|أعد كتابة|اعد كتابة|صحّح|صحح|اختصر|وسّع|وسع|رتّب|رتب|أدرج|ادرج|اجعل|خلي|حط|انقل|نقل|ظبط|زود|remove|delete|add|rewrite|replace|edit|change|insert|move|update)/i.test(latestUserMessage);
    const explicitlyRequestsRemovalFromResult = /(?:احذف|حذف|امسح|شيل|remove|delete).{0,80}(?:من\s+(?:النتيجة|المستند|النص)|النتيجة|المستند)/i.test(latestUserMessage);
    const requestsEdit = explicitlyTargetsResult || (!asksForChatOutput && hasEditVerb);
    const requestsBoth = asksForChatOutput && (explicitlyTargetsResult || explicitlyRequestsRemovalFromResult);
    const intentMode: 'chat' | 'edit' | 'both' | 'question' = requestsBoth ? 'both' : requestsEdit ? 'edit' : asksForChatOutput ? 'chat' : 'question';
    
    const taskLabel = taskType === 'deconstruct' ? 'تفنيد والرد على مستند' : taskType === 'qualify' ? 'تكييف قانوني للنزاع' : 'صياغة قانونية';

    const prompt = `أنت أمين، مساعد قانوني مصري شاطر وتفهم العامية المصرية بطلاقة. هذه متابعة لمهمة ${taskLabel}. المطلوب منك إرجاع كائن JSON صالح فقط بدون أية زيادات، بصيغة: {"reply":"رسالة قصيرة للمحامي","updatedResult":null} تعليمات الهيكلة والتنسيق والتعامل مع العامية: 1. افهم قصد المحامي سواء بالفصحى أو بالعامية المصرية. 2. وضع الطلب المحدد آلياً هو: ${intentMode}. 3. قواعد إلزامية حسب وضع الطلب: - إذا كان الوضع "chat": أجب بالنص الذي طلبه المحامي داخل "reply". يجب أن تكون "updatedResult": null، ولا تعدّل المستند إطلاقاً، حتى لو استخدم المحامي كلمات مثل "اكتب" أو "ضيف" أو "حط". - إذا كان الوضع "edit": عدّل المستند نفسه وأعد النسخة الكاملة المعدلة في "updatedResult"، واجعل "reply" مختصراً. - إذا كان الوضع "both": نفّذ الأمرين معاً: عدّل المستند وفق الجزء الذي يستهدف النتيجة، واكتب داخل "reply" النص الذي طلب المحامي عرضه في الشات. لا تجعل أحد الإجراءين بديلاً عن الآخر. - إذا كان الوضع "question": أجب عن السؤال أو ناقش الفكرة في "reply" واجعل "updatedResult": null. لا تعتبر كل طلب كتابة تعديلاً على المستند ما لم يكن المقصود تعديل النتيجة واضحاً. 4. إذا كان الطلب ملتبساً ولا يحدد أن التعديل على المستند، فالأصل هو الرد في الشات وعدم تغيير النتيجة. 5. استخدم الأسطر الحقيقية الجديدة (Newlines) للفصل بين الفقرات والسطور، ولا تكتب رموز الأسطر الجديدة كأحرف نصية صريحة. 6. حافظ على نص المستند الأصلي بالكامل وغيّر فقط ما طلب المحامي تعديله، دون إعادة كتابة الترويسات بلا داعٍ. [سياق القضية الأصلي] ${String(originalContext || '').slice(0, 100000)} [النتيجة الحالية للمستند] ${result} [سجل المحادثة] ${history} أرجع JSON فقط:`;

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
      updatedResult = typeof parsed?.updatedResult === 'string' && parsed.updatedResult.trim() ? parsed.updatedResult.trim() : null;
    } catch {
      const plainAnswer = sanitizeLegalText(rawAnswer);
      const minimumDocumentLength = Math.min(300, Math.max(120, Math.floor(result.trim().length * 0.45)));
      if (intentMode === 'edit' && plainAnswer.length >= minimumDocumentLength) {
        updatedResult = plainAnswer;
        answer = 'تم تعديل المطلوب في المستند.';
      } else {
        answer = plainAnswer;
      }
    }

    if (updatedResult) {
      updatedResult = sanitizeLegalText(updatedResult);
    }
    // Enforce the user's intent server-side: conversation-only requests cannot mutate the result.
    if (intentMode === 'chat' || intentMode === 'question') updatedResult = null;
    if (answer) {
      answer = sanitizeLegalText(answer);
    }

    if ((intentMode === 'edit' || intentMode === 'both') && !updatedResult) {
      try {
        const recoveryPrompt = `قم بتعديل النتيجة الحالية بناءً على طلب المحامي (سواء بالعامية أو الفصحى). أعد النص الكامل النهائي المعدل فقط بدون رموز "n\\" أو "\\n" نصية. [طلب المحامي] ${latestUserMessage} [النتيجة الحالية] ${result}`;

        const recoveredRaw = String(await generateDeepLegalResponse(recoveryPrompt) || '').trim();
        let recoveredResult = sanitizeLegalText(recoveredRaw);
        
        const minimumDocumentLength = Math.min(300, Math.max(120, Math.floor(result.trim().length * 0.45)));
        if (recoveredResult.length >= minimumDocumentLength) {
          updatedResult = recoveredResult;
          // In a combined request, keep the requested chat response instead of replacing it
          // with a generic success message after recovering the document edit.
          if (intentMode === 'edit' || !answer.trim()) answer = 'تم تحديث النتيجة بنجاح.';
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
