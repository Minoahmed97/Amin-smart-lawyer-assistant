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

    // Prompt مركز فقط على المستند الحالي وآخر رسالة للمحامي بدون تاريخ الشات القديم
    const prompt = `أنت أمين، مساعد قانوني مصري شاطر وتفهم العامية المصرية بطلاقة. هذه متابعة لمهمة (${taskLabel}).
مهمتك هي الرد على طلب المحامي الأخير المذكور أدناه، والتعامل مع النتيجة الحالية للمستند بناءً على طلبه.

حدد هل طلب المحامي يتطلب **تعديل المستند الحالي نفسه** (مثل تعديل جملة، إعادة صياغة، تغيير اسم، إضافة بند) أم مجرد **سؤال أو نقاش أو طلب نص يظهر في الشات فقط**.

أجب بصيغة JSON خفيفة وصريحة جداً كالتالي:
{
  "mode": "chat" أو "edit",
  "reply": "إجابتك أو ردك الذي يظهر للمحامي في الشات",
  "updatedResult": "اكتب المستند كاملاً بعد التعديل هنا فقط إذا كان mode يساوي edit، وإلا اجعله null"
}

[النتيجة الحالية للمستند]
${result}

[طلب المحامي الأخير]
${latestUserMessage}

أرجع JSON صالحاً فقط بدون أي نص خارجه:`;

    // استدعاء النموذج مع حماية زمنية (25 ثانية) لضمان عدم التعليق نهائياً
    const rawAnswer = await Promise.race([
      generateDeepLegalResponse(prompt),
      new Promise((_, reject) => setTimeout(() => reject(new Error('AI_TIMEOUT')), 25000))
    ]) as string;
    
    let mode = 'chat';
    let answer = '';
    let updatedResult: string | null = null;

    try {
      const cleanedJson = rawAnswer.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const parsed = JSON.parse(cleanedJson);
      mode = parsed?.mode === 'edit' ? 'edit' : 'chat';
      answer = typeof parsed?.reply === 'string' ? parsed.reply.trim() : 'تم استلام طلبك.';
      if (mode === 'edit' && typeof parsed?.updatedResult === 'string' && parsed.updatedResult.trim().length > 20) {
        updatedResult = parsed.updatedResult.trim();
        answer = 'تم تحديث النتيجة في مربع المستند بناءً على طلبك.';
      }
    } catch (parseError) {
      answer = rawAnswer.replace(/^```(?:json|text)?\s*/i, '').replace(/\s*```$/, '').trim();
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
