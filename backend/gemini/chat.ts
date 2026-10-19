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
    // Detect explicit requests to modify the document, so a plain-text model response
    // cannot be mistaken for a successful chat-only answer.
    const requestsEdit = /(?:احذف|حذف|امسح|شيل|أضف|اضف|ضيف|إضافة|اضافة|عدّل|عدل|تعديل|غيّر|غير|استبدل|بدّل|بدل|أعد صياغ|اعد صياغ|أعد كتابة|اعد كتابة|صحّح|صحح|صححلي|اختصر|وسّع|وسع|رتّب|رتب|ضع|أدرج|ادرج|اكتب|اجعل|حط|حطه|حطها|انقل|قدّم|قدم|أخّر|اخر|أدخل|ادخل|remove|delete|add|rewrite|replace|edit|change|insert|move|update)\s*/i.test(latestUserMessage);
    const taskLabel = taskType === 'deconstruct' ? 'تفنيد والرد على مستند' : taskType === 'qualify' ? 'تكييف قانوني للنزاع' : 'صياغة قانونية';
    const prompt = `أنت أمين، مساعد قانوني مصري. هذه متابعة لمهمة ${taskLabel} أُنجزت بالفعل. أعد JSON صالحاً فقط بالشكل التالي: {\"reply\":\"رد موجز للمحامي\",\"updatedResult\":null}. إذا كان آخر طلب من المحامي مجرد سؤال أو طلب شرح أو مناقشة، اجعل updatedResult = null وأجب في reply. أما إذا طلب بوضوح تعديل النتيجة نفسها أو حذف/إضافة/استبدال فقرة أو إعادة صياغة أو تنفيذ ملاحظة داخل المستند، فيجب أن تنشئ النسخة الكاملة النهائية المعدلة من النتيجة في updatedResult، لا تضع تعليمات التعديل فقط، واجعل reply يؤكد باختصار أن النتيجة تم تحديثها. لا تضع المستند المعدل في reply؛ يجب أن يكون النص الكامل المعدل في updatedResult وحده. حافظ على الأجزاء التي لم يطلب تعديلها، ولا تغيّر الوقائع أو الأسماء أو التواريخ ولا تخترعها، واستخدم الوقائع الجديدة التي يقدمها المحامي فقط عند ملاءمتها. إذا طلب تعديل جزء محدد، لا تختصر المستند كله ولا تستبدله بملخص. لا تعرض سلسلة التفكير الداخلية.\n\n[سياق القضية الأصلي]\n${String(originalContext || '').slice(0, 100000)}\n\n[النتيجة الحالية التي يجب تعديلها عند الطلب]\n${result}\n\n[سجل المحادثة بالترتيب]\n${history}\n\nاكتب JSON فقط مع المفتاحين reply و updatedResult. updatedResult إما null أو النص الكامل للنتيجة المعدلة.`;
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
      // If the model returned a broken JSON envelope, never mistake that technical
      // wrapper for the legal document. Leave the answer empty so the plain-text
      // recovery request below can return only the final document or a clean reply.
      const plainAnswer = rawAnswer.trim().replace(/^```(?:text|markdown)?\s*/i, '').replace(/\s*```$/, '').trim();
      const looksLikeJsonEnvelope = /["'](?:reply|updatedResult)["']\s*:/i.test(plainAnswer) || /^\s*```json/i.test(rawAnswer);
      if (looksLikeJsonEnvelope) {
        answer = '';
      } else {
        const minimumDocumentLength = Math.min(300, Math.max(120, Math.floor(result.trim().length * 0.45)));
        if (requestsEdit && plainAnswer.length >= minimumDocumentLength) {
          updatedResult = plainAnswer;
          answer = 'تم تحديث النتيجة الأصلية في المربع الموجود بالأعلى.';
        } else {
          answer = plainAnswer;
        }
      }
    }
    // If JSON is valid but the model mistakenly placed the full revised document in
    // reply instead of updatedResult, recover it only when it is document-sized.
    if (requestsEdit && !updatedResult && answer.trim()) {
      const possibleDocument = answer.trim();
      const minimumDocumentLength = Math.min(300, Math.max(120, Math.floor(result.trim().length * 0.45)));
      if (possibleDocument.length >= minimumDocumentLength) {
        updatedResult = possibleDocument;
        answer = 'تم تحديث النتيجة الأصلية في المربع الموجود بالأعلى.';
      }
    }
    // If the first response was chat-only despite an explicit edit request, make one
    // focused recovery attempt that asks for the complete revised result.
    if (requestsEdit && !updatedResult) {
      try {
        const recoveryPrompt = `نفّذ طلب المحامي التالي على النتيجة الحالية، وأعد النص الكامل النهائي المعدل فقط دون مقدمة أو شرح أو JSON. حافظ على كل جزء لم يطلب تغييره، ولا تخترع وقائع أو أسماء أو تواريخ. إذا كان الطلب لا يغيّر المستند فعلياً، أعد النتيجة الحالية كما هي.\n\n[المهمة] ${taskLabel}\n[طلب المحامي] ${latestUserMessage}\n[النتيجة الحالية كاملة]\n${result}`;
        const recoveredRaw = String(await generateDeepLegalResponse(recoveryPrompt) || '').trim();
        let recoveredResult = recoveredRaw.replace(/^```(?:text|markdown)?\s*/i, '').replace(/\s*```$/, '').trim();
        try {
          const start = recoveredResult.indexOf('{');
          const end = recoveredResult.lastIndexOf('}');
          if (start >= 0 && end > start) {
            const parsedRecovery = JSON.parse(recoveredResult.slice(start, end + 1));
            if (typeof parsedRecovery?.updatedResult === 'string' && parsedRecovery.updatedResult.trim()) recoveredResult = parsedRecovery.updatedResult.trim();
            else if (typeof parsedRecovery?.result === 'string' && parsedRecovery.result.trim()) recoveredResult = parsedRecovery.result.trim();
          }
        } catch {}
        const minimumDocumentLength = Math.min(300, Math.max(120, Math.floor(result.trim().length * 0.45)));
        if (recoveredResult.length >= minimumDocumentLength) {
          updatedResult = recoveredResult;
          answer = 'تم تحديث النتيجة الأصلية في المربع الموجود بالأعلى.';
        }
      } catch (recoveryError: any) {
        console.warn('Legal chat result-update recovery failed:', recoveryError?.message || 'unknown error');
      }
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
