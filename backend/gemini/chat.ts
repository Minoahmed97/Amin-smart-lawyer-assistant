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
    const taskLabel = taskType === 'deconstruct' ? 'تفنيد والرد على مستند' : taskType === 'qualify' ? 'تكييف قانوني للنزاع' : 'صياغة قانونية';
    const prompt = `أنت أمين، مساعد قانوني مصري. هذه متابعة لمهمة ${taskLabel} أُنجزت بالفعل. أعد JSON صالحاً فقط بالشكل التالي: {\"reply\":\"رد موجز للمحامي\",\"updatedResult\":null}. إذا كان آخر طلب من المحامي مجرد سؤال أو طلب شرح أو مناقشة، اجعل updatedResult = null وأجب في reply. أما إذا طلب بوضوح تعديل النتيجة نفسها أو حذف/إضافة/استبدال فقرة أو إعادة صياغة أو تنفيذ ملاحظة داخل المستند، فيجب أن تنشئ النسخة الكاملة النهائية المعدلة من النتيجة في updatedResult، لا تضع تعليمات التعديل فقط، واجعل reply يؤكد باختصار أن النتيجة تم تحديثها. حافظ على الأجزاء التي لم يطلب تعديلها، ولا تغيّر الوقائع أو الأسماء أو التواريخ ولا تخترعها، واستخدم الوقائع الجديدة التي يقدمها المحامي فقط عند ملاءمتها. إذا طلب تعديل جزء محدد، لا تختصر المستند كله ولا تستبدله بملخص. لا تعرض سلسلة التفكير الداخلية.\n\n[سياق القضية الأصلي]\n${String(originalContext || '').slice(0, 100000)}\n\n[النتيجة الحالية التي يجب تعديلها عند الطلب]\n${result}\n\n[سجل المحادثة بالترتيب]\n${history}\n\nاكتب JSON فقط مع المفتاحين reply و updatedResult. updatedResult إما null أو النص الكامل للنتيجة المعدلة.`;
    const rawAnswer = await generateDeepLegalResponse(prompt);
    let answer = '';
    let updatedResult: string | null = null;
    try {
      const trimmedAnswer = rawAnswer.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const jsonStart = trimmedAnswer.indexOf('{');
      const jsonEnd = trimmedAnswer.lastIndexOf('}');
      const cleaned = jsonStart >= 0 && jsonEnd > jsonStart ? trimmedAnswer.slice(jsonStart, jsonEnd + 1) : trimmedAnswer;
      const parsed = JSON.parse(cleaned);
      answer = typeof parsed?.reply === 'string' ? parsed.reply.trim() : '';
      updatedResult = typeof parsed?.updatedResult === 'string' && parsed.updatedResult.trim() ? parsed.updatedResult.trim() : null;
    } catch {
      // Graceful fallback if the model returns ordinary text instead of the requested JSON.
      answer = rawAnswer.trim();
    }
    if (!answer.trim()) {
      const err: any = new Error('لم تُنتج خدمة الذكاء الاصطناعي إجابة هذه المرة. لم يتم إرسال رد؛ انتظر مهلة الاستخدام ثم أعد المحاولة.');
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
