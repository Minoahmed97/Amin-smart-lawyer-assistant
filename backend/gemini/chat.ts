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
    // Delimited plain-text sections are more reliable than asking the model to
    // JSON-escape an entire long legal document. JSON parsing remains as a fallback.
    const prompt = `أنت أمين، مساعد قانوني مصري تعمل داخل محرر مستند قانوني لمهمة ${taskLabel}. افهم مقصد المحامي من المعنى والسياق الكامل، لا من قائمة كلمات أو تطابق حرفي. قد يكتب بالعامية المصرية أو الفصحى أو بإملاء غير رسمي أو بصياغة غير مباشرة. استنتج من الرسالة الأخيرة وسجل الحوار هل يريد مناقشة المستند أم تغيير المستند نفسه.

إذا كان مقصد المحامي أن يتغير المستند أو تتغير واقعة أو فقرة فيه، فصنّف النية edit وطبّق التغيير على النص الكامل الحالي، حتى لو صيغ الطلب كتحديث معلومة أو إخبار بتغير واقعة. أعد المستند الكامل بعد التعديل، لا ملخصاً ولا وصفاً لما ستفعله. حافظ على كل ما لم يطلب تغييره، ولا تخترع أسماء أو وقائع أو تواريخ أو بيانات. إذا كان المقصود سؤالاً أو شرحاً فقط، فصنّفه discussion ولا تغيّر المستند. إذا كان التعديل المقصود غير واضح فعلاً أو يحتمل أكثر من معنى مؤثر، فصنّفه clarify واسأل سؤالاً واحداً محدداً. لا تقل إن التعديل تم إلا إذا أعدت المستند الكامل المعدّل.

أخرج الأقسام التالية حرفياً وبالترتيب. قيمة النية يجب أن تكون كلمة إنجليزية واحدة فقط من هذه القيم الثلاث: edit أو discussion أو clarify. لا تكتب الخيارات الثلاثة معاً، ولا تكتب كلمة «أو» في خانة النية. أمثلة: عند طلب تعديل اكتب edit فقط؛ عند الاستفسار اكتب discussion فقط؛ وعند غموض جوهري اكتب clarify فقط. لا تستخدم JSON ولا تضف شرحاً خارج الأقسام. لا تضع علامات الأقسام داخل نص المستند نفسه:
[[AMIN_INTENT_START]]
edit
[[AMIN_INTENT_END]]
[[AMIN_REPLY_START]]
رد موجز للمحامي. عند نجاح التعديل، اكتب تأكيداً قصيراً فقط؛ لا تضع نص المستند هنا.
[[AMIN_REPLY_END]]
[[AMIN_UPDATED_RESULT_START]]
عند edit: النص الكامل النهائي للمستند بعد التعديل. عند discussion أو clarify: اكتب null فقط.
[[AMIN_UPDATED_RESULT_END]]

[سياق القضية الأصلي]
${String(originalContext || '').slice(0, 100000)}

[النص الكامل الحالي للمستند]
${result}

[سجل المحادثة بالترتيب؛ الرسالة الأخيرة هي طلب المحامي الحالي]
${history}

نفّذ الطلب في ضوء الرسالة الأخيرة والسياق السابق. لا تعتبر مجرد إخطار بتغير واقعة سؤالاً نظرياً إذا كان السياق يدل على أن المطلوب تحديث المستند. لا تغيّر أي بيانات غير مرتبطة بالطلب.`;
    const rawAnswer = await generateDeepLegalResponse(prompt);
    let answer = '';
    let updatedResult: string | null = null;
    let intent: 'edit' | 'discussion' | 'clarify' | '' = '';

    // Preferred format: resilient section markers keep the long legal text out of
    // JSON string escaping, so Arabic text and paragraphs can be recovered intact.
    const taggedIntent = rawAnswer.match(/\[\[AMIN_INTENT_START\]\]\s*(edit|discussion|clarify)\s*\[\[AMIN_INTENT_END\]\]/i);
    const taggedReply = rawAnswer.match(/\[\[AMIN_REPLY_START\]\]([\s\S]*?)\[\[AMIN_REPLY_END\]\]/i);
    const taggedResult = rawAnswer.match(/\[\[AMIN_UPDATED_RESULT_START\]\]([\s\S]*?)\[\[AMIN_UPDATED_RESULT_END\]\]/i);

    if (taggedIntent && taggedReply && taggedResult) {
      intent = taggedIntent[1].toLowerCase() as 'edit' | 'discussion' | 'clarify';
      answer = taggedReply[1].trim();
      const documentText = taggedResult[1].trim();
      updatedResult = documentText && documentText.toLowerCase() !== 'null' ? documentText : null;
    } else {
      // Backward-compatible fallback if the model returns JSON instead of markers.
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
        // Try to recover explicit JSON string fields if a provider broke JSON escaping.
        const plainAnswer = String(rawAnswer || '').trim().replace(/^```(?:json|text|markdown)?\s*/i, '').replace(/\s*```$/, '').trim();
        const replyMatch = plainAnswer.match(/["']reply["']\s*:\s*("(?:\\.|[^"\\])*")/i);
        const updateMatch = plainAnswer.match(/["']updatedResult["']\s*:\s*("(?:\\.|[^"\\])*")/i);
        const intentMatch = plainAnswer.match(/["']intent["']\s*:\s*["'](edit|discussion|clarify)["']/i);
        if (intentMatch) intent = intentMatch[1].toLowerCase() as 'edit' | 'discussion' | 'clarify';
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
          const looksStructured = /["'](?:reply|updatedResult|intent)["']\s*:/i.test(plainAnswer) || /^\s*```json/i.test(rawAnswer || '');
          if (!looksStructured && plainAnswer) answer = plainAnswer;
          else answer = 'لم أتمكن من قراءة الرد بصورة موثوقة. لم تتغير النتيجة الأصلية؛ أعد إرسال طلبك من فضلك.';
        }
      }
    }
    // Never apply a document if the model classified the turn as discussion/clarification.
    if (intent && intent !== 'edit') updatedResult = null;

    // A returned full document is the only evidence that an edit was actually produced.
    if (updatedResult && updatedResult.trim()) {
      updatedResult = updatedResult.trim();
      if (updatedResult === result.trim()) {
        updatedResult = null;
        answer = 'لم ينتج عن الطلب تغيير فعلي في نص المستند، لذلك لم أعتبره تعديلاً منفذاً. حدّد التغيير المطلوب أو وضّح البيانات الجديدة.';
      } else {
        // Normalize the assistant text so the UI never relies on a free-form claim.
        answer = 'تم تطبيق التعديل على النتيجة الأصلية المعروضة بالأعلى.';
      }
    }

    // A semantic edit request without a complete new document is not success.
    if (intent === 'edit' && !updatedResult) {
      answer = 'فهمت أنك تريد تعديل المستند، لكن لم تصلني نسخة كاملة موثوقة بعد التعديل. لم تتغير النتيجة الأصلية؛ أعد إرسال الطلب مرة أخرى من فضلك.';
    }
    if (!updatedResult && /تم\s+(?:تحديث|تعديل|تغيير|إضافة|حذف|استبدال)|تم تطبيق التعديل/i.test(answer)) {
      answer = 'لم أتمكن من تأكيد تطبيق التعديل على المستند، لذلك لم تتغير النتيجة الأصلية. أعد إرسال الطلب أو وضّح المطلوب من فضلك.';
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
