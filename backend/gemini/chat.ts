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
    const taskLabel = taskType === 'deconstruct' ? 'تفنيد والرد على مستند' : taskType === 'qualify' ? 'تكييف قانوني للنزاع' : 'صياغة قانونية';

    const prompt = `أنت أمين، مساعد قانوني مصري شاطر وتفهم العامية المصرية بطلاقة. هذه متابعة لمهمة (${taskLabel}).
مهمتك هي الرد على طلب المحامي الأخير بناءً على سياق القضية والنتيجة الحالية.

حدد أولاً هل طلب المحامي يتطلب **تعديل المستند الحالي نفسه** (مثل تعديل، إعادة صياغة، إضافة بند للمستند الأساسي) أم مجرد **سؤال أو نقاش أو طلب نص يظهر في الشات فقط**.

أجب بصيغة JSON خفيفة وصريحة جداً كالتالي:
{
  "mode": "chat" أو "edit",
  "reply": "إجابتك أو ردك الذي يظهر للمحامي في الشات",
  "updatedResult": "اكتب المستند كاملاً بعد التعديل هنا فقط إذا كان mode يساوي edit، وإلا اجعله null"
}

[سياق القضية الأصلي]
${String(originalContext || '').slice(0, 50000)}

[النتيجة الحالية للمستند]
${result}

[سجل المحادثة]
${history}

أرجع JSON صالحاً فقط بدون أي نص خارجه:`;

    const rawAnswer = await generateDeepLegalResponse(prompt);
    
    let mode = 'chat';
    let answer = '';
    let updatedResult: string | null = null;

    try {
      const cleanedJson = rawAnswer.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const parsed = JSON.parse(cleanedJson);
      mode = parsed?.mode === 'edit' ? 'edit' : 'chat';
      answer = typeof parsed?.reply === 'string' ? parsed.reply.trim() : 'تم استلام طلبك.';
      if (mode === 'edit' && typeof parsed?.updatedResult === 'string' && parsed.updatedResult.trim().length > 50) {
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

  } تقدر catch (err: any) {
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
