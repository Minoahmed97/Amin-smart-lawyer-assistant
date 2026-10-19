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
    // Let the model classify intent semantically from context, not fixed keywords.
    const taskLabel = taskType === 'deconstruct' ? 'تفنيد والرد على مستند' : taskType === 'qualify' ? 'تكييف قانوني للنزاع' : 'صياغة قانونية';
    const prompt = `أنت أمين، مساعد قانوني مصري، وتعمل داخل محرر مستند قانوني. هذه متابعة لمهمة ${taskLabel} أُنجزت بالفعل. افهم مقصد المحامي من المعنى والسياق الكامل، لا من كلمات مفتاحية محفوظة. المحامي قد يكتب بالعامية المصرية أو بالفصحى أو بإملاء غير رسمي أو بطلب غير مباشر؛ تعامل مع جميع الصيغ باعتبارها طبيعية، واستنتج هل يريد مناقشة المستند أم تغيير المستند نفسه. أمثلة توضيحية وليست قائمة حصرية: «خلّي التاريخ يوم كذا»، «أنا عايزه يبقى كذا»، «الجلسة اتأجلت وبقت يوم كذا»، «بدّل اللي فوق»، «ممكن تصلح التاريخ؟» كلها قد تعني طلب تعديل إذا كان السياق يدل على ذلك. لا تعتمد على تطابق ألفاظ بعينها.

أعد JSON صالحاً فقط بهذه المفاتيح الثلاثة: {\"intent\":\"edit|discussion|clarify\",\"reply\":\"رد موجز للمحامي\",\"updatedResult\":null}. إذا كان مقصد المحامي تغيير المستند أو تحديث واقعة فيه، فاختر intent = edit وأنشئ النص الكامل النهائي للمستند بعد تطبيق التغيير في updatedResult. لا تكتفِ بتأكيد أو شرح التغيير، ولا تضع المستند المعدل في reply. إذا كان سؤالاً أو طلب شرح دون طلب تغيير المستند، فاختر intent = discussion واجعل updatedResult = null. إذا لم تستطع تحديد التغيير المطلوب بأمان، فاختر intent = clarify واسأل سؤالاً محدداً ولا تدّعِ تنفيذ التعديل. لا تقل أبداً إن التعديل تم إذا لم تُرجع النسخة الكاملة المعدلة في updatedResult. حافظ على كل الأجزاء التي لم يطلب المحامي تعديلها، ولا تختصر المستند أو تحوله إلى ملخص. غيّر فقط ما يقتضيه الطلب، ولا تخترع أسماء أو وقائع أو تواريخ أو بيانات ناقصة. إذا قال المحامي إن واقعة تغيرت (مثل تأجيل الجلسة)، فطبّق التغيير على الموضع المناسب في المستند مع الحفاظ على بقية النص. لا تعرض سلسلة التفكير الداخلية.

[سياق القضية الأصلي]
${String(originalContext || '').slice(0, 100000)}

[النتيجة الحالية التي يجب تعديلها عند الطلب]
${result}

[سجل المحادثة بالترتيب]
${history}

اكتب JSON فقط، واملأ intent و reply و updatedResult بدقة. updatedResult إما null أو النص الكامل للمستند بعد التعديل.`;
    const rawAnswer = await generateDeepLegalResponse(prompt);
    let answer = '';
    let updatedResult: string | null = null;
    let intent: 'edit' | 'discussion' | 'clarify' | '' = '';
    try {
      const trimmedAnswer = rawAnswer.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const jsonStart = trimmedAnswer.indexOf('{');
      const jsonEnd = trimmedAnswer.lastIndexOf('}');
      const cleaned = jsonStart >= 0 && jsonEnd > jsonStart ? trimmedAnswer.slice(jsonStart, jsonEnd + 1) : trimmedAnswer;
      const parsed = JSON.parse(cleaned);
      answer = typeof parsed?.reply === 'string' ? parsed.reply.trim() : '';
      updatedResult = typeof parsed?.updatedResult === 'string' && parsed.updatedResult.trim() ? parsed.updatedResult.trim() : null;
      intent = ['edit', 'discussion', 'clarify'].includes(parsed?.intent) ? parsed.intent : '';
    } catch {
      // Models may return JSON with extra prose, code fences, or imperfect escaping.
      // Recover the reply field when possible instead of converting a usable response
      // into an empty answer and an artificial 503.
      const plainAnswer = String(rawAnswer || '').trim().replace(/^```(?:json|text|markdown)?\s*/i, '').replace(/\s*```$/, '').trim();
      const replyMatch = plainAnswer.match(/["']reply["']\s*:\s*("(?:\\.|[^"\\])*")/i);
      const updateMatch = plainAnswer.match(/["']updatedResult["']\s*:\s*("(?:\\.|[^"\\])*")/i);
      if (replyMatch) {
        try { answer = String(JSON.parse(replyMatch[1]) || '').trim(); } catch { answer = ''; }
      }
      if (updateMatch) {
        try {
          const recoveredUpdate = String(JSON.parse(updateMatch[1]) || '').trim();
          if (recoveredUpdate) updatedResult = recoveredUpdate;
        } catch {}
      }
      if (!answer && !updatedResult) {
        const looksLikeJsonEnvelope = /[\"'](?:reply|updatedResult|intent)[\"']\s*:/i.test(plainAnswer) || /^\s*```json/i.test(rawAnswer || '');
        if (!looksLikeJsonEnvelope && plainAnswer) answer = plainAnswer;
        else answer = 'لم أتمكن من قراءة رد الذكاء الاصطناعي بصورة موثوقة. لم تتغير النتيجة الأصلية؛ أعد إرسال طلبك من فضلك.';
      }
    }
    // A returned document is the source of truth: apply it regardless of which
    // natural-language wording the user used. Never infer success from reply text.
    if (updatedResult && updatedResult.trim()) {
      updatedResult = updatedResult.trim();
      if (updatedResult === result.trim()) {
        updatedResult = null;
        if (!answer.trim() || /تم\s+(?:تحديث|تعديل|تغيير|إضافة|حذف|استبدال)/i.test(answer)) {
          answer = 'لم ينتج عن الطلب تغيير فعلي في المستند، لذلك لم أعتبره تعديلاً منفذاً. وضّح الجزء الذي تريد تغييره من فضلك.';
        }
      } else if (intent === 'edit' || !intent) {
        if (!answer.trim() || /تم\s+(?:تحديث|تعديل|تغيير|إضافة|حذف|استبدال)/i.test(answer)) {
          answer = 'تم تطبيق التعديل على النتيجة الأصلية المعروضة بالأعلى.';
        }
      }
    }
    // Model intent is semantic, not keyword-based. If it identified an edit but
    // failed to return a revised document, never falsely report success.
    if (intent === 'edit' && !updatedResult) {
      answer = 'فهمت أنك تريد تعديل المستند، لكن لم أتمكن من إنشاء نسخة معدّلة موثوقة هذه المرة. لم تتغير النتيجة الأصلية؛ أعد إرسال طلبك أو حدّد الجزء المطلوب.';
    }
    if (!updatedResult && /تم\s+(?:تحديث|تعديل|تغيير|إضافة|حذف|استبدال)|تم تطبيق التعديل/i.test(answer)) {
      answer = 'لم أتمكن من تأكيد تطبيق التعديل على المستند، لذلك لم تتغير النتيجة الأصلية. وضّح طلبك أو أعد إرساله من فضلك.';
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
