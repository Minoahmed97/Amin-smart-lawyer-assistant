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

    // Prompt ذكي وموجز يربط السؤال بالنتيجة الحالية مباشرة بدون الاعتماد على الشات القديم
    const prompt = `أنت أمين، مساعد قانوني مصري شاطر وتفهم العامية المصرية بطلاقة. هذه متابعة لمهمة (${taskLabel}).
لديك أدناه "النتيجة الحالية للمستند" ولدى المحامي سؤال أو طلب يتعلق بها.

[النتيجة الحالية للمستند التي تناقشها وتقرؤها جيداً]
${result}

[سؤال أو طلب المحامي الأخير]
${latestUserMessage}

المطلوب منك بدقة:
1. اقرأ "النتيجة الحالية للمستند" أعلاه جيداً لتعرف محتواها بالكامل.
2. انظر إلى "سؤال أو طلب المحامي الأخير".
3. حدد هل الطلب هو **تعديل أو تغيير أو إضافة** على المستند الحالي؟ 
   - إذا كان تعديلاً للمستند: ابدأ ردك بكلمة [EDIT] واكتب المستند كاملاً بعد إجراء التعديل المطلوب عليه.
   - إذا كان سؤالاً عادياً أو استفساراً أو طلباً لشرح نقطة: أجب عن السؤال مباشرة بناءً على فهمك للمستند وبدون كتابة كلمة EDIT.

أرجع إجابتك مباشرة بدون أي مقدمات أو نصوص زائدة:`;

    const rawAnswer = await Promise.race([
      generateDeepLegalResponse(prompt),
      new Promise((_, reject) => setTimeout(() => reject(new Error('AI_TIMEOUT')), 45000))
    ]) as string;

    let answer = '';
    let updatedResult: string | null = null;

    const trimmed = rawAnswer.trim();

    if (trimmed.startsWith('[EDIT]')) {
      updatedResult = trimmed.replace('[EDIT]', '').trim();
      answer = 'تم تحديث النتيجة في مربع المستند بناءً على طلبك.';
    } else {
      answer = trimmed.replace(/^```(?:text|markdown)?\s*/i, '').replace(/\s*```$/, '').trim();
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
