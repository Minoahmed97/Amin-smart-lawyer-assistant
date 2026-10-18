import { generateDeepLegalResponse } from './counter-brief.ts';
import { enforceAiCooldown, consumeOperation } from '../auth.ts';
import { rateLimit, limitBodyString } from '../security.ts';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch {} }
    const { taskType, originalContext, result, messages } = body || {};
    if (!['deconstruct', 'qualify'].includes(taskType)) return res.status(400).json({ error: 'نوع المهمة غير صالح للدردشة القانونية.' });
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
    const prompt = `أنت أمين، مساعد قانوني مصري. هذه متابعة لمهمة ${taskType === 'deconstruct' ? 'تفنيد والرد على مستند' : 'تكييف قانوني ونزاع'} أُنجزت بالفعل. أجب عن آخر سؤال مع الحفاظ على الاتساق مع السياق والنتيجة الأصلية وسجل الحوار. يجوز إدماج الوقائع الجديدة التي يذكرها المحامي، لكن ميّزها عن الوقائع السابقة ولا تخترع أسماء أو تواريخ أو نصوصاً أو أحكاماً. إذا طلب المستخدم تفسيراً فاشرحه بوضوح، وإذا طلب تعديل الاستنتاج فأعد تقييمه وفق المعطيات ولا تتمسك به لمجرد أنه ورد في النتيجة السابقة. لا تعرض سلسلة التفكير الداخلية؛ قدم الأسباب القانونية المفيدة والنتيجة العملية فقط.\n\n[سياق القضية الأصلي]\n${String(originalContext || '').slice(0, 100000)}\n\n[النتيجة الأصلية]\n${result}\n\n[سجل المحادثة بالترتيب]\n${history}\n\nأجب عن آخر رسالة من المحامي مباشرة وبالعربية القانونية الواضحة.`;
    const answer = await generateDeepLegalResponse(prompt);
    if (!answer.trim()) {
      const err: any = new Error('لم تُنتج خدمة الذكاء الاصطناعي إجابة هذه المرة. لم يتم إرسال رد؛ انتظر مهلة الاستخدام ثم أعد المحاولة.');
      err.statusCode = 503;
      throw err;
    }
    const usage = await consumeOperation(req, 'gemini-operation');
    return res.status(200).json({ result: answer, remainingCredits: usage.remainingCredits, trialRemaining: usage.trialRemaining });
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
