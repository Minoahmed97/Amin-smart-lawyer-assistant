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

    // Classify intent by the meaning and context of the request, not fixed keywords.
    // The model's explicit action field below is the only authority for result edits.
    let requestsEdit = false;
    
    const taskLabel = taskType === 'deconstruct' ? 'تفنيد والرد على مستند' : taskType === 'qualify' ? 'تكييف قانوني للنزاع' : 'صياغة قانونية';

    const prompt = `أنت أمين، مساعد قانوني مصري شاطر وتفهم العامية المصرية بطلاقة. هذه متابعة لمهمة ${taskLabel}.
أرجع كائن JSON صالح فقط بهذه الحقول:
{"action":"chat","reply":"النص الذي يظهر في الشات","updatedResult":null}

افهم المقصود من المعنى والسياق، لا من كلمات مفتاحية أو صيغة حرفية. المستخدم قد يتحدث بالفصحى أو العامية المصرية وقد يعبّر عن طلبه بشكل غير مباشر.

حدّد action بدقة:
- "edit_result": عندما يكون قصده العملي تعديل أو استكمال أو تصحيح أو تقوية أو إعادة صياغة النتيجة/المستند الحالي أو جزء منه، حتى لو عبّر بصورة غير مباشرة، مثل أن يقول إن فقرة ضعيفة أو إن الرد محتاج يكون أقوى. أعد المستند كاملاً بعد تطبيق التعديل في "updatedResult"، واجعل "reply" تأكيداً قصيراً فقط. لا تضع المستند المعدل كاملاً في reply.
- "chat": عندما يسأل سؤالاً، أو يناقش نقطة، أو يطلب تفسيراً أو رأياً أو نصاً جديداً يريده في المحادثة. أجب فعلياً داخل "reply"، واجعل "updatedResult": null. لا تغيّر المستند لمجرد أن السؤال يتناول موضوعاً مذكوراً فيه.
- إذا طلب كتابة أو إعادة صياغة شيء داخل الشات، اكتب النص المطلوب في reply ولا تغيّر المستند.
- إذا طلب تعديل رسالة في الشات، اكتب النسخة المعدلة من الرسالة في reply ولا تغيّر المستند إلا إذا طلب أيضاً تعديله.
- إذا لم يكن واضحاً هل يريد تعديل المستند أم مجرد مناقشته، لا تخمّن ولا تعدّل المستند؛ اسأله في reply سؤال توضيحياً قصيراً واجعل action="chat".
- لا تجعل كلمة مثل "عدّل" أو "اكتب" أو "النتيجة" وحدها تحدد المسار؛ افهم العبارة كاملة. ميّز بين ملاحظة/سؤال عن المستند وبين طلب تغيير فعلي فيه.

لا تكتب Reply أو Response أو Answer كعنوان أو بادئة. استخدم أسطر جديدة حقيقية ولا تكتب رموز \\n كنص حرفي. حافظ على المستند الأصلي بالكامل وغيّر فقط ما يتطلبه الطلب دون إعادة كتابة الترويسات بلا داعٍ.

[سياق القضية الأصلي]
${String(originalContext || '').slice(0, 100000)}

[النتيجة الحالية للمستند]
${result}

[سجل المحادثة]
${history}

أرجع JSON فقط:`;

    const rawAnswer = await generateDeepLegalResponse(prompt);
    let answer = '';
    let updatedResult: string | null = null;

    // دالة تنظيف النصوص ومعالجة رموز الأسطر الملتصقة لضمان صفاء النص تماماً
    const sanitizeLegalText = (text: string) => {
      if (!text) return '';
      return text
        .replace(/^```(?:json|text|markdown)?\s*/i, '')
        .replace(/^\s*(?:reply|response|answer)\s*[:：-]?\s*(?:\r?\n)?/i, '')
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

      // Semantic classification from the model replaces brittle keyword matching.
      requestsEdit = parsed?.action === 'edit_result';
      answer = typeof parsed?.reply === 'string' ? sanitizeLegalText(parsed.reply) : '';
      updatedResult = typeof parsed?.updatedResult === 'string' && parsed.updatedResult.trim() ? sanitizeLegalText(parsed.updatedResult) : null;

      // Only after the model classified the intent as an edit, recover a full
      // document if it mistakenly placed that document in the chat reply field.
      const minimumDocumentLength = Math.min(300, Math.max(120, Math.floor(result.trim().length * 0.45)));
      if (requestsEdit && !updatedResult && answer.length >= minimumDocumentLength) {
        updatedResult = answer;
        answer = 'تم تحديث النتيجة في مربع المستند.';
      } else if (requestsEdit && updatedResult && answer.length >= minimumDocumentLength) {
        answer = 'تم تحديث النتيجة في مربع المستند.';
      }
    } catch {
      // If the model ignored the JSON contract, ask it to classify and structure
      // the same response semantically before deciding where the content belongs.
      try {
        const repairPrompt = `حوّل الناتج أدناه إلى JSON صالح فقط بالشكل {"action":"chat","reply":"...","updatedResult":null}. يجب أن تكون action إما chat أو edit_result.
افهم أحدث طلب من معناه وسياقه، لا من كلمات مفتاحية. إذا كان المقصود تنفيذ تغيير في المستند الحالي، فاجعل action="edit_result" وضع النسخة الكاملة المعدلة في updatedResult واجعل reply تأكيداً قصيراً. إذا كان سؤالاً أو طلب شرح أو نصاً داخل المحادثة، فاجعل action="chat" وأجب في reply واجعل updatedResult=null. لا تنقل المستند المعدل إلى reply.

[أحدث طلب للمحامي]
${latestUserMessage}

[النتيجة الحالية]
${result}

[الناتج السابق من النموذج]
${rawAnswer}`;
        const repairRaw = String(await generateDeepLegalResponse(repairPrompt) || '').trim();
        const repairStart = repairRaw.indexOf('{');
        const repairEnd = repairRaw.lastIndexOf('}');
        if (repairStart < 0 || repairEnd <= repairStart) throw new Error('invalid_repair_json');
        const repaired = JSON.parse(repairRaw.slice(repairStart, repairEnd + 1));
        requestsEdit = repaired?.action === 'edit_result';
        answer = typeof repaired?.reply === 'string' ? sanitizeLegalText(repaired.reply) : '';
        updatedResult = typeof repaired?.updatedResult === 'string' && repaired.updatedResult.trim() ? sanitizeLegalText(repaired.updatedResult) : null;
        const minimumDocumentLength = Math.min(300, Math.max(120, Math.floor(result.trim().length * 0.45)));
        if (requestsEdit && !updatedResult && answer.length >= minimumDocumentLength) {
          updatedResult = answer;
          answer = 'تم تحديث النتيجة في مربع المستند.';
        }
      } catch (repairError: any) {
        console.warn('Legal chat response structure recovery failed:', repairError?.message || 'unknown error');
        // Fail safely instead of accidentally posting a full revised document in chat.
        answer = 'تعذر تحديد نوع الطلب بصورة موثوقة هذه المرة، لذلك لم أغيّر النتيجة. أعد إرسال طلبك وسأحاول تنفيذه من جديد.';
        updatedResult = null;
        requestsEdit = false;
      }
    }

    // حماية نهائية: لا نسمح للنموذج بتغيير خانة النتيجة إذا لم يصنّف
    // طلب المستخدم صراحةً كتعديل للمستند الموجود.
    if (!requestsEdit) updatedResult = null;
    if (updatedResult) {
      updatedResult = sanitizeLegalText(updatedResult);
      if (requestsEdit && answer.length >= Math.min(300, Math.max(120, Math.floor(result.trim().length * 0.45)))) {
        answer = 'تم تحديث النتيجة في مربع المستند.';
      }
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
        const recoveryPrompt = `أنت تنفذ طلباً صُنّف بعد فهم المعنى والسياق على أنه تعديل للنتيجة الحالية. طبّق طلب المحامي بدقة على المستند أدناه، سواء كان بالعامية المصرية أو بالفصحى أو بصياغة غير مباشرة. أعد المستند كاملاً بعد التعديل فقط، ولا تكتب شرحاً أو تأكيداً. حافظ على كل ما لم يُطلب تغييره.

[طلب المحامي] ${latestUserMessage}
[النتيجة الحالية]
${result}`;

        const recoveredRaw = String(await generateDeepLegalResponse(recoveryPrompt) || '').trim();
        const recoveredResult = sanitizeLegalText(recoveredRaw);
        const minimumDocumentLength = Math.min(300, Math.max(120, Math.floor(result.trim().length * 0.45)));
        if (recoveredResult.length >= minimumDocumentLength) {
          updatedResult = recoveredResult;
          answer = 'تم تحديث النتيجة في مربع المستند.';
        }
      } catch (recoveryError: any) {
        console.warn('Legal chat result-update recovery failed:', recoveryError?.message || 'unknown error');
      }
      // Never leave a success-style reply when the result box was not updated.
      if (!updatedResult) {
        answer = 'لم أتمكن من تطبيق التعديل على النتيجة بشكل موثوق، لذلك لم أغيّر المستند. وضّح لي الجزء المطلوب أو أعد صياغة طلب التعديل.';
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
