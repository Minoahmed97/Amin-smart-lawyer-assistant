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
    if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'سجل المحادثة غير صالح.' });
    
    limitBodyString(originalContext, 100000, 'سياق القضية');
    limitBodyString(result, 120000, 'النتيجة الأصلية');
    
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || lastMessage.role !== 'user' || typeof lastMessage.content !== 'string') {
      return res.status(400).json({ error: 'يجب أن تنتهي المحادثة بسؤال من المستخدم.' });
    }
    limitBodyString(lastMessage.content, 10000, 'رسالة المحادثة');

    rateLimit(req, 'gemini-legal-chat', 20, 10 * 60 * 1000);
    await enforceAiCooldown(req);

    const taskLabel = taskType === 'deconstruct' ? 'تفنيد والرد على مستند' : taskType === 'qualify' ? 'تكييف قانوني للنزاع' : 'صياغة قانونية';
    const latestUserMessage = lastMessage.content.trim();

    // فحص ذكي وسريع في الكود: هل طلب المحامي يحتوي على كلمة تدل على التعديل أو التغيير؟
    const isEditIntent = /(عدل|غير|بدل|احذف|أضف|اضف|زود|صغ|تعديل|تغيير)/i.test(latestUserMessage);

    let prompt = '';
    if (isEditIntent) {
      // لو نية المحامي تعديل، نطلب من الذكاء الاصطناعي تعديل المستند وإرجاعه بالكامل
      prompt = `أنت أمين، مساعد قانوني مصري. بناءً على طلب المحامي التالي: "${latestUserMessage}"
قم بتعديل "النتيجة الحالية للمستند" أدناه وتطبيق التعديل المطلوب بدقة، وأرجع المستند كاملاً بعد التعديل فقط بدون أي شرح أو كلام خارجه.

[النتيجة الحالية للمستند]
${result}`;
    } else {
      // لو سؤال عادي، يرد في الشات
      prompt = `أنت أمين، مساعد قانوني مصري. أجب على سؤال المحامي التالي بناءً على فهمك للنتيجة الحالية للمستند. أجب في الشات مباشرة بدون تعديل المستند.

[النتيجة الحالية للمستند]
${result}

[سؤال المحامي]
${latestUserMessage}`;
    }

    const rawAnswer = await Promise.race([
      generateDeepLegalResponse(prompt),
      new Promise((_, reject) => setTimeout(() => reject(new Error('AI_TIMEOUT')), 45000))
    ]) as string;

    let answer = '';
    let updatedResult: string | null = null;

    const cleanedAnswer = rawAnswer.replace(/^```(?:text|markdown|json)?\s*/i, '').replace(/\s*```$/, '').trim();

    if (isEditIntent && cleanedAnswer.length > 50) {
      // إذا كان طلب تعديل والرد عبارة عن مستند جديد، نعتبره updatedResult
      updatedResult = cleanedAnswer;
      answer = 'تم تحديث النتيجة في مربع المستند بناءً على طلبك.';
    } else {
      // رد عادي للشات
      answer = cleanedAnswer;
      updatedResult = null;
    }

    const usage = await consumeOperation(req, 'gemini-operation');
    return res.status(200).json({ 
      result: answer, 
      updatedResult, 
      remainingCredits: usage.remainingCredits, 
      trialRemaining: usage.trialRemaining 
    });

  } catch (err: any) {
    console.error('Error in /api/gemini/chat:', err?.message || 'unknown error');
    const isTimeout = err?.message === 'AI_TIMEOUT';
    return res.status(isTimeout ? 504 : 500).json({
      error: isTimeout 
        ? 'استغرق الذكاء الاصطناعي وقتاً أطول من اللازم للرد. حاول مرة أخرى.' 
        : (err?.message || 'تعذر إتمام الدردشة القانونية. حاول مرة أخرى بعد قليل.'),
    });
  }
}
