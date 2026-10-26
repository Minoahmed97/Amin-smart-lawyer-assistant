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
    
    limitBodyString(originalContext, 30000, 'سياق القضية');
    limitBodyString(result, 40000, 'النتيجة الأصلية');
    
    for (const message of messages) {
      if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') return res.status(400).json({ error: 'رسالة محادثة غير صالحة.' });
      limitBodyString(message.content, 10000, 'رسالة المحادثة');
    }
    if (messages[messages.length - 1]?.role !== 'user') return res.status(400).json({ error: 'يجب أن تنتهي المحادثة بسؤال من المستخدم.' });

    rateLimit(req, 'gemini-legal-chat', 20, 10 * 60 * 1000);
    await enforceAiCooldown(req);

    const history = messages.map((m: any) => `${m.role === 'user' ? 'المحامي' : 'أمين'}: ${m.content}`).join('\n\n');
    const latestUserMessage = String(messages[messages.length - 1]?.content || '').trim();

    // التعرف الذكي والشامل على طلبات التعديل بالفصحى العامية المصرية بشتى صيغها
    const requestsEdit = /(?:احذف|حذف|امسح|شيل|شيله|شيلها|أضف|اضف|ضيف|ضيفه|ضيفها|إضافة|اضافة|عدّل|عدل|عدّلها|عدلها|عدليه|يعدل|تعديل|غيّر|غير|غيرها|استبدل|بدّل|بدل|بدلها|أعد صياغ|اعد صياغ|أعد كتابة|اعد كتابة|صحّح|صحح|صححلي|اختصر|وسّع|وسع|رتّب|رتب|ضع|أدرج|ادرج|اكتب|اكتبها|اكتبلي|اجعل|خليها|خليه|حط|حطه|حطها|انقل|نقلها|قدّم|قدم|أخّر|اخر|أدخل|ادخل|ظبط|ظبطها|زود|زودها|كمل المستند|أكمل المستند|اكمل المستند|اكتب المذكرة|اكتب المذكره|نفذ التعديل|نفّذ التعديل|عدّي في النتيجة|عدي في النتيجة|ضيف في النتيجة|أضف في النتيجة|عايزك تغير|عايزك تعدل|عايزك تضيف|عايزك تكتب|remove|delete|add|rewrite|replace|edit|change|insert|move|update)\s*/i.test(latestUserMessage);
    
    const taskLabel = taskType === 'deconstruct' ? 'تفنيد والرد على مستند' : taskType === 'qualify' ? 'تكييف قانوني للنزاع' : 'صياغة قانونية';

    const prompt = `أنت أمين، مساعد قانوني مصري شاطر وتفهم العامية المصرية بطلاقة. هذه متابعة لمهمة ${taskLabel}.
المطلوب منك إرجاع كائن JSON صالح فقط بدون أية زيادات، بصيغة:
{"reply":"رسالة قصيرة للمحامي","updatedResult":null}

تعليمات الهيكلة والتنسيق والتعامل مع العامية:
1. افهم قصد المحامي سواء تحدث بالفصحى أو بالعامية المصرية (مثل: "خليها كذا"، "غير دي لـ كذا"، "ظبط التاريخ"، "شيل الحته دي").
2. ميّز بدقة بين:
   - السؤال القانوني أو المناقشة فقط: اجعل "updatedResult": null وأجب في "reply" دون تغيير المستند.
   - طلب تعديل أو إضافة أو حذف أو إعادة صياغة أو استكمال للمستند، بما في ذلك طلب كتابة المذكرة المقابلة أو إدراجها في آخر النتيجة: ضع المستند كاملاً بعد التعديل في "updatedResult"، وليس الجزء المضاف وحده، واجعل "reply" رسالة قصيرة توضّح ما تم.
   - إذا طلب المحامي صياغة أو تنفيذ مستند جديد اعتماداً على التحليل الحالي، فأدرج نص المستند كاملاً في "updatedResult" كي يظهر في مربع النتيجة، ولا تكتفِ باقتراح نوع المستند أو وصف ما ينبغي كتابته.
3. أخرج JSON صالحاً تماماً. لأن الأسطر الجديدة داخل قيم JSON يجب تهريبها، استخدم \n داخل السلاسل عند الحاجة، ولا تضع أسطراً فعلية غير مهربة داخل قيمة نصية. بعد قراءة JSON ستظهر فواصل الأسطر بشكل طبيعي.
4. حافظ على نص المستند الأصلي بالكامل، وغير فقط ما طلبه المحامي. لا تحذف الأقسام أو الديباجة أو الطلبات الختامية ولا تعِد كتابة الأجزاء غير المطلوبة دون داعٍ.

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

    if (requestsEdit && !updatedResult) {
      try {
        const recoveryPrompt = `قم بتعديل النتيجة الحالية بناءً على طلب المحامي (سواء بالعامية أو الفصحى). أعد النص الكامل النهائي المعدل فقط بدون رموز "n\\" أو "\\n" نصية.

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

    if (!answer.trim() && updatedResult) answer = 'تم تحديث النتيجة بناءً على طلبك.';

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
