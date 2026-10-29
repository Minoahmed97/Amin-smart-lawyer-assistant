
import { generateDeepLegalResponse } from './counter-brief.ts';
import { enforceAiCooldown, consumeOperation } from '../auth.ts';
import { rateLimit, limitBodyString } from '../security.ts';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    let body = req.body;

    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch {}
    }

    if (body && typeof body.messages === 'string') {
      try {
        body.messages = JSON.parse(body.messages);
      } catch {
        body.messages = null;
      }
    }

    const { taskType, originalContext, result, messages } = body || {};

    if (!['deconstruct', 'qualify', 'draft'].includes(taskType)) {
      return res.status(400).json({
        error: 'نوع المهمة غير صالح للدردشة القانونية.'
      });
    }

    if (typeof result !== 'string' || !result.trim()) {
      return res.status(400).json({
        error: 'لا توجد نتيجة أصلية لمناقشتها.'
      });
    }

    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({
        error: 'سجل المحادثة غير صالح.'
      });
    }

    limitBodyString(originalContext, 100000, 'سياق القضية');
    limitBodyString(result, 120000, 'النتيجة الأصلية');

    const lastMessage = messages[messages.length - 1];

    if (
      !lastMessage ||
      lastMessage.role !== 'user' ||
      typeof lastMessage.content !== 'string'
    ) {
      return res.status(400).json({
        error: 'يجب أن تنتهي المحادثة بسؤال من المستخدم.'
      });
    }

    limitBodyString(lastMessage.content, 10000, 'رسالة المحادثة');

    rateLimit(req, 'gemini-legal-chat', 20, 10 * 60 * 1000);
    await enforceAiCooldown(req);

    const taskLabel =
      taskType === 'deconstruct'
        ? 'تفنيد والرد على مستند'
        : taskType === 'qualify'
        ? 'تكييف قانوني للنزاع'
        : 'صياغة قانونية';

    const latestUserMessage = lastMessage.content.trim();

    // اكتشاف أوامر تعديل المستند
    const isDocumentEditIntent =
      /^(?:من فضلك\s+|لو سمحت\s+|عايزك\s+|ممكن\s+)*(?:عدل|عدّل|تعديل|غير|غيّر|بدل|بدّل|احذف|امسح|شيل|أضف|اضف|زود|استبدل|صحح|عدّللي|عدلي|ضيف)/i.test(latestUserMessage) &&
      !/(?:اشرح|وضح|اعرض|وريني|اكتبلي في الشات|هاتلي في الشات)/i.test(latestUserMessage);

    let prompt = '';

    if (isDocumentEditIntent) {

      // تعديل المستند الأصلي وإرجاع النسخة الكاملة المعدلة
      prompt = `أنت مساعد قانوني مصري متخصص.

المحامي يطلب إجراء تعديل على المستند الحالي.

[طلب المحامي]
${latestUserMessage}

تعليمات إلزامية:
1. نفّذ التعديل المطلوب داخل المستند الأصلي فقط.
2. حافظ على جميع الفقرات والبنود الأخرى دون تغيير.
3. لا تحذف أي جزء غير مطلوب حذفه.
4. لا تختصر المستند.
5. لا تضف مقدمات أو تعليقات أو شروحات.
6. أرجع المستند كاملاً بعد تنفيذ التعديل.
7. حافظ على التنسيق والعناوين والترتيب الأصلي قدر الإمكان.
8. لا تخترع وقائع أو نصوصاً قانونية أو أحكاماً قضائية.

[المستند الأصلي]
${result}`;

    } else {

      // المحادثة العادية دون تعديل مربع النتيجة
      prompt = `أنت أمين، مساعد قانوني مصري شاطر وتفهم العامية المصرية بطلاقة.

هذه متابعة لمهمة (${taskLabel}).

أجب على طلب أو سؤال المحامي التالي في الشات مباشرة.

إذا طلب عرض المذكرة أو جزء منها في الشات، اعرض المطلوب في الشات.

لا تقم بتعديل المستند الأساسي في هذه الحالة.

[النتيجة الحالية للمستند للاطلاع والاستعانة بها]
${result}

[طلب أو سؤال المحامي]
${latestUserMessage}`;

    }

    // الحفاظ على مهلة الانتظار الحالية
    const rawAnswer = await Promise.race([
      generateDeepLegalResponse(prompt),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('AI_TIMEOUT')), 90000)
      )
    ]) as string;

    let answer = '';
    let updatedResult: string | null = null;

    const cleanedAnswer = rawAnswer
      .replace(/^```(?:text|markdown|json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();

    // الفصل بين تعديل المستند والرد داخل الشات
    if (isDocumentEditIntent) {

      if (!cleanedAnswer || cleanedAnswer.length <= 10) {
        throw new Error('لم يتم إرجاع مستند معدل صالح.');
      }

      // المستند المعدل يذهب إلى مربع النتيجة
      updatedResult = cleanedAnswer;

      // الشات يعرض رسالة تأكيد فقط
      answer = 'تم تنفيذ التعديل المطلوب على النتيجة.';

    } else {

      // الرد العادي يظهر في الشات فقط
      answer = cleanedAnswer;

      // عدم المساس بمربع النتيجة
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

    console.error(
      'Error in /api/gemini/chat:',
      err?.message || 'unknown error'
    );

    const isTimeout = err?.message === 'AI_TIMEOUT';

    return res.status(isTimeout ? 504 : 500).json({
      error: isTimeout
        ? 'استغرق التعديل وقتاً أطول من المعتاد. حاول مرة أخرى.'
        : (err?.message || 'تعذر إتمام الطلب. حاول مرة أخرى بعد قليل.')
    });

  }
}
