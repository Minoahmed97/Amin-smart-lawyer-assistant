
import { generateDeepLegalResponse } from './counter-brief.ts';
import { executeWithKeyRotation } from '../keyRotation.ts';
import { enforceAiCooldown, consumeOperation } from '../auth.ts';
import { rateLimit, limitBodyString } from '../security.ts';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    let body = req.body;

    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {}
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

    // اكتشاف طلب تعديل النتيجة
    const normalizedMessage = latestUserMessage
      .replace(/[\u064B-\u065F\u0670]/g, '')
      .trim();

    const isDocumentEditIntent =
      /^(?:(?:من فضلك|لو سمحت|عايزك|ممكن|ياريت)\s+)*(?:عدل|عدلي|تعديل|غير|بدل|احذف|امسح|شيل|اضف|زود|استبدل|صحح|ضيف)\b/i.test(normalizedMessage) &&
      !/(?:اشرح|وضح|اعرض|وريني|اكتبلي في الشات|هاتلي في الشات)/i.test(normalizedMessage);

    let answer = '';
    let updatedResult: string | null = null;

    if (isDocumentEditIntent) {

      /*
       * تعديل موضعي:
       * لا نطلب إعادة توليد المستند بالكامل.
       * النموذج يحدد النص الأصلي والنص البديل فقط.
       */

      const editPrompt = `أنت محرر مستندات قانونية مصرية.

المطلوب تنفيذ تعديل موضعي على المستند التالي.

[طلب المحامي]
${latestUserMessage}

[المستند الحالي]
${result}

تعليمات إلزامية:

1. حدد النص الموجود فعلياً في المستند الذي يجب تغييره.
2. أرجع النص القديم حرفياً دون إعادة صياغته.
3. أرجع النص البديل المطلوب فقط.
4. لا تعيد كتابة المستند بالكامل.
5. لا تعدل أي فقرة أخرى.
6. لا تختلق وقائع أو أسماء أو مواد قانونية.
7. إذا كان التعديل غير واضح أو لا يمكن تحديد موضعه بدقة، أرجع status بقيمة unclear.
8. إذا كان المطلوب إضافة نص جديد، حدد نصاً موجوداً يتم إدراج الإضافة بعده.
9. لا تختصر النص القديم ولا تستخدم علامات الحذف بدلاً منه.
10. اختر موضعاً فريداً لا يتكرر داخل المستند.
11. إذا كان الطلب يتطلب تعديلات متعددة أو إعادة صياغة شاملة لا يمكن تمثيلها باستبدال موضعي واحد، أرجع unclear.

أرجع JSON صالحاً فقط بهذا الشكل:

{
  "status": "ok",
  "oldText": "النص الأصلي المطابق حرفياً",
  "newText": "النص البديل"
}

في حالة الإضافة، اجعل newText يحتوي على النص الأصلي المحدد ثم الإضافة المطلوبة بعده.

في حالة عدم وضوح الطلب:

{
  "status": "unclear",
  "oldText": "",
  "newText": ""
}

ممنوع إضافة أي شرح خارج JSON.`;

      // طلب قصير مخصص للتعديل بدلاً من مولد المستندات الطويلة
      const editResponse = await executeWithKeyRotation(
        async (ai, key, model) => {
          const response = await ai.models.generateContent({
            model,
            contents: editPrompt,
            config: {
              temperature: 0.1,
              maxOutputTokens: 8192,
              responseMimeType: 'application/json'
            }
          });

          const text = typeof response.text === 'string'
            ? response.text.trim()
            : '';

          if (!text) {
            throw new Error('لم يصل رد صالح لتنفيذ التعديل.');
          }

          return text;
        }
      );

      let editData: any;

      try {
        const cleanJson = String(editResponse)
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```$/, '')
          .trim();

        editData = JSON.parse(cleanJson);

      } catch {
        throw new Error('تعذر قراءة التعديل المطلوب. حاول توضيح الجزء المراد تغييره.');
      }

      if (
        !editData ||
        editData.status !== 'ok' ||
        typeof editData.oldText !== 'string' ||
        typeof editData.newText !== 'string' ||
        !editData.oldText.length
      ) {
        return res.status(422).json({
          error: 'لم أتمكن من تحديد موضع التعديل بدقة. حدد الجملة أو الفقرة المطلوب تعديلها.',
          updatedResult: null
        });
      }

      const oldText = editData.oldText;
      const newText = editData.newText;

      // التحقق من وجود النص الأصلي فعلياً
      const firstIndex = result.indexOf(oldText);

      if (firstIndex === -1) {
        return res.status(422).json({
          error: 'تعذر العثور على النص المطلوب تعديله داخل النتيجة الأصلية.',
          updatedResult: null
        });
      }

      // منع تعديل موضع خاطئ إذا تكرر النص
      const secondIndex = result.indexOf(
        oldText,
        firstIndex + oldText.length
      );

      if (secondIndex !== -1) {
        return res.status(422).json({
          error: 'النص المطلوب تعديله متكرر داخل المستند. يرجى تحديد الفقرة المقصودة بدقة.',
          updatedResult: null
        });
      }

      // تنفيذ الاستبدال مع الحفاظ على باقي المستند حرفياً
      const modifiedDocument =
        result.slice(0, firstIndex) +
        newText +
        result.slice(firstIndex + oldText.length);

      if (!modifiedDocument.trim()) {
        throw new Error('لا يمكن استبدال المستند بنتيجة فارغة.');
      }

      if (modifiedDocument === result) {
        answer = 'النص المطلوب موجود بالفعل ولا يحتاج إلى تعديل.';
        updatedResult = null;
      } else {
        updatedResult = modifiedDocument;
        answer = 'تم تنفيذ التعديل المطلوب على النتيجة.';
      }

    } else {

      /*
       * المحادثة القانونية العادية:
       * الحفاظ على نفس الوظيفة السابقة.
       */

      const prompt = `أنت أمين، مساعد قانوني مصري شاطر وتفهم العامية المصرية بطلاقة.

هذه متابعة لمهمة (${taskLabel}).

أجب على طلب أو سؤال المحامي التالي في الشات مباشرة.

إذا طلب عرض المذكرة أو جزء منها في الشات، اعرض المطلوب في الشات.

لا تقم بتعديل المستند الأساسي.

[النتيجة الحالية للمستند للاطلاع والاستعانة بها]
${result}

[طلب أو سؤال المحامي]
${latestUserMessage}`;

      const rawAnswer = await generateDeepLegalResponse(prompt);

      answer = rawAnswer
        .replace(/^```(?:text|markdown|json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();

      updatedResult = null;
    }

    // الحفاظ على نظام احتساب العمليات الحالي
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

    const statusCode = Number(err?.statusCode || err?.status);

    const status =
      isTimeout ? 504 :
      Number.isInteger(statusCode) &&
      statusCode >= 400 &&
      statusCode < 600
        ? statusCode
        : 500;

    return res.status(status).json({
      error: isTimeout
        ? 'استغرق الطلب وقتاً أطول من المعتاد. حاول مرة أخرى.'
        : (err?.message || 'تعذر إتمام الطلب. حاول مرة أخرى بعد قليل.')
    });

  }
}
