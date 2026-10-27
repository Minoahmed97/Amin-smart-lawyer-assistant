import { generateDeepLegalResponse } from './counter-brief.ts';
import { enforceAiCooldown, consumeOperation } from '../auth.ts';
import { rateLimit, limitBodyString } from '../security.ts';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  
  try {
    let body = req.body;
    if (typeof body === 'string') { 
      try { 
        body = JSON.parse(body); 
      } catch {} 
    }

    const { taskType, originalContext, result, messages } = body || {};
    
    if (!['deconstruct', 'qualify', 'draft'].includes(taskType)) {
      return res.status(400).json({ error: 'نوع المهمة غير صالح للدردشة القانونية.' });
    }
    if (typeof result !== 'string' || !result.trim()) {
      return res.status(400).json({ error: 'لا توجد نتيجة أصلية لمناقشتها.' });
    }
    if (!Array.isArray(messages) || !messages.length || messages.length > 40) {
      return res.status(400).json({ error: 'سجل المحادثة غير صالح.' });
    }
    
    limitBodyString(originalContext, 30000, 'سياق القضية');
    limitBodyString(result, 40000, 'النتيجة الأصلية');
    
    for (const message of messages) {
      if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') {
        return res.status(400).json({ error: 'رسالة محادثة غير صالحة.' });
      }
      limitBodyString(message.content, 10000, 'رسالة المحادثة');
    }
    
    if (messages[messages.length - 1]?.role !== 'user') {
      return res.status(400).json({ error: 'يجب أن تنتهي المحادثة بسؤال من المستخدم.' });
    }

    rateLimit(req, 'gemini-legal-chat', 25, 10 * 60 * 1000);
    await enforceAiCooldown(req);

    const history = messages.map((m: any) => `${m.role === 'user' ? 'المحامي' : 'أمين'}: ${m.content}`).join('\n\n');
    const latestUserMessage = String(messages[messages.length - 1]?.content || '').trim();

    const requestsEdit = /(?:احذف|حذف|امسح|شيل|شيله|شيلها|أضف|اضف|ضيف|ضيفه|ضيفها|إضافة|اضافة|عدّل|عدل|عدّلها|عدلها|عدليه|يعدل|تعديل|غيّر|غير|غيرها|استبدل|بدّل|بدل|بدلها|أعد صياغ|اعد صياغ|أعد كتابة|اعد كتابة|صحّح|صحح|صححلي|اختصر|وسّع|وسع|رتّب|رتب|ضع|أدرج|ادرج|اكتب|اكتبها|اكتبلي|اجعل|خليها|خليه|حط|حطه|حطها|انقل|نقلها|قدّم|قدم|أخّر|اخر|أدخل|ادخل|ظبط|ظبطها|زود|زودها|كمل المستند|أكمل المستند|اكمل المستند|اكتب المذكرة|اكتب المذكره|نفذ التعديل|نفّذ التعديل|عدّي في النتيجة|عدي في النتيجة|ضيف في النتيجة|أضف في النتيجة|عايزك تغير|عايزك تعدل|عايزك تضيف|عايزك تكتب|remove|delete|add|rewrite|replace|edit|change|insert|move|update)\s*/i.test(latestUserMessage);
    
    const taskLabel = taskType === 'deconstruct' ? 'تفنيد والرد على مستند' : taskType === 'qualify' ? 'تكييف قانوني للنزاع' : 'صياغة قانونية';

    const prompt = `أنت أمين، مساعد قانوني مصري شاطر وتفهم العامية المصرية بطلاقة. هذه متابعة لمهمة ${taskLabel}.
المطلوب منك إرجاع كائن JSON صالح فقط بدون أية زيادات، بصيغة دقيقة:
{"reply":"رسالة قصيرة للمحامي تشرح ما تم","updatedResult":null}

تعليمات الهيكلة والتنسيق:
1. افهم قصد المحامي سواء تحدث بالفصحى أو بالعامية المصرية.
2. إذا طلب تعديلاً على المذكرة، ضع النص الكامل المعدل داخل حقل "updatedResult". وإذا كان مجرد سؤال أو استفسار عام، اجعل "updatedResult" بقيمة null وضع الإجابة في "reply".
3. أخرج كائن JSON صالحاً تماماً.

[سياق القضية الأصلي]
${String(originalContext || '').slice(0, 30000)}

[النتيجة الحالية للمستند]
${result}

[سجل المحادثة]
${history}

أرجع JSON فقط:`;

    const rawAnswer = await generateDeepLegalResponse(prompt);
    let answer = '';
    let updatedResult: string | null = null;

    const sanitizeLegalText = (text: string) => {
      if (!text) return '';
      return text
        .replace(/^```(?:json|text|markdown)?\s*/i, '')
        .replace(/\s*```$/, '')
        .replace(/\\r?\\n/g, '\n')
        .replace(/(?:n\\)+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    };

    const readJsonStringField = (source: string, field: string): string => {
      const match = source.match(new RegExp('"' + field + '"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"', 's'));
      if (!match) return '';
      try {
        return String(JSON.parse('"' + match[1].replace(/\n/g, '\\n') + '"'));
      } catch {
        return match[1].replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
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
      answer = readJsonStringField(rawAnswer, 'reply') || sanitizeLegalText(rawAnswer);
      updatedResult = readJsonStringField(rawAnswer, 'updatedResult') || null;
    }

    if (updatedResult) updatedResult = sanitizeLegalText(updatedResult);
    if (answer) answer = sanitizeLegalText(answer);

    // آلية استرجاع ذكية إذا طلب المحامي تعديلاً ولم يرجعه النموذج كـ JSON مباشر
    if (requestsEdit && !updatedResult) {
      try {
        const recoveryPrompt = `قم بتعديل النتيجة الحالية بناءً على طلب المحامي بدقة. أعد النص الكامل النهائي المعدل فقط دون أي مقدمات.
[طلب المحامي]: ${latestUserMessage}
[النتيجة الحالية]:
${result}`;
        const recoveredRaw = String(await generateDeepLegalResponse(recoveryPrompt) || '').trim();
        let recoveredResult = sanitizeLegalText(recoveredRaw);
        if (recoveredResult.length >= 80) {
          updatedResult = recoveredResult;
          answer = 'تم تحديث المذكرة والنتيجة بنجاح بناءً على طلبك.';
        }
      } catch {}
    }

    if (!answer.trim() && updatedResult) answer = 'تم تحديث النتيجة بناءً على طلبك.';
    if (!answer.trim()) answer = 'تمت العملية بنجاح.';

    const usage = await consumeOperation(req, 'gemini-operation');
    return res.status(200).json({ result: answer, updatedResult, remainingCredits: usage.remainingCredits, trialRemaining: usage.trialRemaining });
  } catch (err: any) {
    console.error('Error in /api/gemini/chat:', err?.message || 'unknown error');
    const code = Number(err?.statusCode || err?.status);
    const status = Number.isInteger(code) && code >= 400 && code < 600 ? code : 500;
    return res.status(status).json({ error: err?.message || 'تعذر إتمام الدردشة القانونية.' });
  }
}
