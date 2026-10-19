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

    const requestsEdit = /(?:احذف|حذف|امسح|شيل|أضف|اضف|ضيف|إضافة|اضافة|عدّل|عدل|تعديل|غيّر|غير|استبدل|بدّل|بدل|أعد صياغ|اعد صياغ|أعد كتابة|اعد كتابة|صحّح|صحح|صححلي|اختصر|وسّع|وسع|رتّب|رتب|ضع|أدرج|ادرج|اكتب|اجعل|حط|حطه|حطها|انقل|قدّم|قدم|أخّر|اخر|أدخل|ادخل|remove|delete|add|rewrite|replace|edit|change|insert|move|update)\s*/i.test(latestUserMessage);
    const taskLabel = taskType === 'deconstruct' ? 'تفنيد والرد على مستند' : taskType === 'qualify' ? 'تكييف قانوني للنزاع' : 'صياغة قانونية';

    const prompt = `أنت أمين، مساعد قانوني مصري. هذه متابعة لمهمة ${taskLabel}.
المطلوب منك إرجاع كائن JSON صالح فقط بدون أية زيادات، بصيغة:
{"reply":"رسالة قصيرة للمحامي","updatedResult":null}

تعليمات الهيكلة والتنسيق الصارمة:
1. استخدم الأسطر الحقيقية الجديدة (Newlines) للفصل بين الفقرات والسطور، ولا تكتب الرمز "n\\" أو "\\n" كأحرف نصية صريحة إطلاقاً داخل النص.
2. عند التعديل، أعد المستند كاملاً داخل "updatedResult" دون كتابة أي كلام شارح أو أجزاء من JSON في داخله.
3. حافظ على كل النصوص كما هي وغير فقط ما طلبه المحامي (مثل التاريخ أو الرقم).

[سياق القضية الأصلي]
${String(originalContext || '').slice(0, 100000)}

[النتيجة الحالية]
${result}

[سجل المحادثة]
${history}

أرجع JSON فقط:`;

    const rawAnswer = await generateDeepLegalResponse(prompt);
    let answer = '';
    let updatedResult: string | null = null;

    // دالة خاصة بتنظيف النصوص القانونية ومعالجة رموز الأسطر الملتصقة n\
    const sanitizeLegalText = (text: string) => {
      if (!text) return '';
      return text
        .replace(/^```(?:json|text|markdown)?\s*/i, '')
        .replace(/\s*```$/, '')
        .replace(/^\{\s*"reply"\s*:\s*".*?"\s*,\s*"updatedResult"\s*:\s*"/s, '')
        .replace(/^"reply"\s*:\s*".*?"\s*,\s*"updatedResult"\s*:\s*"/s, '')
        .replace(/\"\}\s*$/, '')
        // تحويل رموز n\ و \n النصية المفتعلة إلى أسطر حقيقية
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

    // تطبيق التنظيف على النتيجة المعدلة وعلى الرد
    if (updatedResult) {
      updatedResult = sanitizeLegalText(updatedResult);
    }
    if (answer) {
      answer = sanitizeLegalText(answer);
    }

    if (requestsEdit && !updatedResult) {
      try {
        const recoveryPrompt = `قم بتعديل النتيجة الحالية بناءً على طلب المحامي فقط. أعد النص الكامل النهائي المعدل فقط. لا تكتب رموز "n\\" أو "\\n" كأحرف نصية بل استخدم الأسطر الحقيقية.

[طلب المحامي] ${latestUserMessage}
[النتيجة الحالية]
${result}`;

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
