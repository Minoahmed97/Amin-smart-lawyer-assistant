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

    // تحديد وجهة الطلب أولاً: النتيجة الأساسية أم المحادثة.
    const normalizedMessage = latestUserMessage
      .replace(/[\\u064B-\\u065F\\u0670]/g, '')
      .trim();

    const mentionsDocument =
      /(?:النتيجة|المستند|المذكرة|الصحيفة|الصياغة|الفقرة|النص)/i.test(normalizedMessage);

    const mentionsChat =
      /(?:الشات|المحادثة|الرد هنا|هنا في الرد)/i.test(normalizedMessage);

    const hasEditAction =
      /(?:عدل|عدّل|تعديل|تعديلات|تعدل|غيّر|غير|تغيير|أعد صياغة|اعد صياغة|صياغة|احذف|امسح|أضف|اضف|استبدل|صحح|صلح|تصلح|نفذ|نفّذ|طبق|طبّق|خلي|اجعل|حوّل|حول)/i.test(normalizedMessage);

    // وجهة الشات لا تُفهم من مجرد ذكره؛ يجب أن يكون المطلوب عرضه أو كتابته فيه.
    const explicitlyTargetsChat =
      mentionsChat &&
      /(?:اكتب|اكتبلي|اكتب لي|انقل|نقل|انسخ|نسخ|اعرض|وريني|هات|استخرج|ضع|حط|اعرضه|اعرضها|رد|جاوب|اجب|أجب|اشرح|وضح|لخص|لخّص|ناقش|عدل|عدّل|تعديل|غيّر|غير|صيّغ|صيغ).{0,80}(?:في الشات|داخل الشات|بالشات|للشات|في المحادثة|داخل المحادثة|هنا في الرد)/i.test(normalizedMessage) ||
      /(?:في الشات|داخل الشات|بالشات|في المحادثة|داخل المحادثة).{0,80}(?:اكتب|انقل|انسخ|اعرض|هات|ضع|حط|رد|عدل|عدّل|تعديل)/i.test(normalizedMessage);

    // ذكر النتيجة/المستند مع فعل تعديل يجعلها الوجهة، حتى لو ذُكر الشات كمصدر للصياغة.
    const explicitlyTargetsDocument =
      mentionsDocument &&
      (hasEditAction || /(?:في|على|داخل|ضمن)\\s*(?:النتيجة|المستند|المذكرة|الصحيفة|الصياغة|الفقرة|النص)/i.test(normalizedMessage));

    // استكمال سؤال تحديد الوجهة: إذا كان آخر رد من المستخدم اختياراً
    // للنتيجة الأساسية، نربطه بطلب التعديل السابق بدلاً من معاملته كسؤال جديد.
    const previousUserMessage = [...messages.slice(0, -1)]
      .reverse()
      .find((message: any) => message?.role === 'user' && typeof message.content === 'string');
    const previousAssistantMessage = [...messages.slice(0, -1)]
      .reverse()
      .find((message: any) => message?.role === 'assistant' && typeof message.content === 'string');
    const previousRequest = String(previousUserMessage?.content || '')
      .replace(/[\\u064B-\\u065F\\u0670]/g, '')
      .trim();
    const confirmsMainResult =
      /(?:على|في|داخل)\\s*(?:النتيجة الأساسية|النتيجة|المستند الأساسي)/i.test(normalizedMessage) ||
      /(?:النتيجة الأساسية|النتيجة|المستند الأساسي)/i.test(normalizedMessage);
    const previousWasEditRequest =
      /(?:عدل|عدّل|تعديل|تعديلات|تعدل|غيّر|غير|تغيير|أعد صياغة|اعد صياغة|صياغة|احذف|امسح|أضف|اضف|استبدل|صحح|صلح|تصلح|نفذ|نفّذ|طبق|طبّق|خلي|اجعل|حوّل|حول)/i.test(previousRequest);
    const assistantWasAskingDestination =
      /(?:هل تريد|حدد الوجهة|النتيجة الأساسية|داخل الشات)/i.test(String(previousAssistantMessage?.content || ''));
    const isConfirmedDocumentEdit =
      confirmsMainResult && previousWasEditRequest && assistantWasAskingDestination;

    const isDocumentEditIntent =
      (hasEditAction && explicitlyTargetsDocument) || isConfirmedDocumentEdit;

    const isChatOnlyIntent =
      explicitlyTargetsChat && !explicitlyTargetsDocument;

    const isAmbiguousEditIntent =
      !isConfirmedDocumentEdit &&
      hasEditAction && !explicitlyTargetsDocument && !isChatOnlyIntent;

    const editInstruction = isConfirmedDocumentEdit
      ? `طلب التعديل الأصلي: ${previousRequest}\\nتأكيد الوجهة من المحامي: ${latestUserMessage}`
      : latestUserMessage;

    let answer = '';
    let updatedResult: string | null = null;

    if (isAmbiguousEditIntent) {
      answer = 'هل تريد تطبيق التعديل على النتيجة الأساسية وتحديث صياغتها، أم تريد كتابة التعديل داخل الشات فقط؟ حدد الوجهة وسأنفذ المطلوب.';
    } else if (isDocumentEditIntent) {
      // تعديل النتيجة يعني إعادة صياغة المستند كاملاً وإرجاع النسخة النهائية.
      const editPrompt = `أنت محرر ومستشار قانوني مصري محترف. المطلوب تعديل وإعادة صياغة المستند القانوني الكامل وفق تعليمات المحامي، ثم إرجاع النسخة النهائية الكاملة للمستند.

[نوع المهمة]
${taskLabel}

[سياق القضية]
${originalContext || 'غير متاح'}

[المستند الحالي بالكامل]
${result}

[تعليمات المحامي للتعديل]
${editInstruction}

قواعد إلزامية:
1. أعد صياغة المستند كاملاً بعد تطبيق طلب المحامي، ولا تكتفِ بتعديل فقرة منفردة أو إرجاع الجزء المعدل.
2. حافظ على جميع الوقائع والطلبات والدفوع والأسانيد والتفاصيل الصحيحة الموجودة في المستند، ما لم يطلب المحامي تغييرها صراحة.
3. طبّق التعديل المطلوب على كامل المستند بالقدر اللازم، ووحّد الصياغة والأسلوب حتى تظهر النسخة متماسكة.
4. إذا أرفق المحامي صياغة سابقة في الشات وطلب جعل النتيجة مثلها، اعتبر تلك الصياغة مرجعاً أسلوبياً وتعليمياً، وطبّقها على المستند الحالي كله بحسب السياق.
5. لا تختلق وقائع أو مستندات أو أسماء أو أرقام أو مواد قانونية أو أحكاماً.
6. لا تحذف أي جزء جوهري من المستند لمجرد الاختصار.
7. أخرج المستند النهائي كاملاً فقط، دون مقدمة أو شرح أو تعليق خارج المستند.
8. لا تقل إنك لم تحدد فقرة؛ فالمطلوب هنا هو معالجة المستند كاملاً.`;

      const editedDocument = await executeWithKeyRotation(
        async (ai, key, model) => {
          const response = await ai.models.generateContent({
            model,
            contents: editPrompt,
            config: {
              temperature: 0.2,
              maxOutputTokens: 32768
            }
          });

          const text = typeof response.text === 'string'
            ? response.text.trim()
            : '';

          if (!text) {
            throw new Error('لم يصل المستند المعدل كاملاً من النموذج.');
          }

          return text
            .replace(/^```(?:text|markdown)?\s*/i, '')
            .replace(/\s*```$/, '')
            .trim();
        }
      );

      if (!editedDocument || editedDocument.length < 100) {
        throw new Error('النسخة المعدلة غير مكتملة أو أقصر من أن تمثل المستند النهائي.');
      }

      if (editedDocument === result.trim()) {
        answer = 'راجعت المستند، ولم ينتج عن التعليمات تغيير واضح في الصياغة. وضّح لي التغيير المطلوب بصورة أدق.';
      } else {
        updatedResult = editedDocument;
        answer = 'تم تعديل وإعادة صياغة المستند بالكامل، وتحديث النتيجة الأساسية بالنسخة الجديدة.';
      }
    } else {
      // الأسئلة وطلبات العرض أو النقل الموجهة للشات لا تغيّر المستند الأساسي.
      const prompt = `أنت أمين، مساعد قانوني مصري محترف وتفهم العامية المصرية بطلاقة. هذه متابعة لمهمة (${taskLabel}). أجب على طلب المحامي داخل الشات فقط. إذا طلب نقل صياغة أو جزء من النتيجة إلى الشات، اعرضه هنا كما طلب. لا تعدّل المستند الأساسي ولا تدّعِ أنك حدّثته.

[النتيجة الحالية للاطلاع والاستعانة بها فقط]
${result}

[سجل المحادثة]
${messages.slice(-6).map((message: any) => `${message.role === 'user' ? 'المحامي' : 'أمين'}: ${message.content}`).join('\\n')}

[طلب المحامي الحالي]
${latestUserMessage}`;

      const rawAnswer = await generateDeepLegalResponse(prompt);

      answer = rawAnswer
        .replace(/^\`\`\`(?:text|markdown|json)?\\s*/i, '')
        .replace(/\\s*\`\`\`$/, '')
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
