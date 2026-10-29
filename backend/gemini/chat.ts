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

    // فحص دقيق هل هو أمر تعديل
    const isDocumentEditIntent = /^(عدل|غير|بدل|احذف|أضف|اضف|استبدل|ضع|شيل)\b/i.test(latestUserMessage) && 
                                 (latestUserMessage.includes('نتيجة') || latestUserMessage.includes('مستند') || latestUserMessage.includes('بند') || latestUserMessage.includes('الفقرة') || latestUserMessage.includes('الجملة') || latestUserMessage.length < 60);

    let prompt = '';
    if (isDocumentEditIntent) {
      // هنا بنطلب منه يرجع النتيجة بصيغة JSON واضحة: الشات لوحده، والمستند المحدث لوحده عشان ميتلخبطوش
      prompt = `أنت مساعد قانوني مصري ذكي. المحامي يطلب منك هذا التعديل المحدد على المستند:
"${latestUserMessage}"

مهمتك: 
1. قم بتطبيق هذا التعديل على المستند أدناه وإرجاع المستند كاملاً بعد التعديل.
2. أجب بصيغة JSON صحيحة تماماً بالشكل التالي من غير أي كود ماركداك إضافي بره الـ JSON:
{
  "chatResponse": "رسالة قصيرة تخبر المحامي أنه تم التعديل بنجاح",
  "updatedDocument": "النص الكامل للمستند بعد التعديل"
}

[النص الأصلي للمستند]
${result}`;
    } else {
      prompt = `أنت أمين، مساعد قانوني مصري شاطر وتفهم العامية المصرية بطلاقة. هذه متابعة لمهمة (${taskLabel}).
أجب على طلب أو سؤال المحامي التالي في الشات مباشرة (مثل عرض المذكرة هنا في الشات، أو شرحها). لا تقم بتعديل المستند الأساسي.

[النتيجة الحالية للمستند للاطلاع والاستعانة بها]
${result}

[طلب أو سؤال المحامي]
${latestUserMessage}`;
    }

    const rawAnswer = await Promise.race([
      generateDeepLegalResponse(prompt),
      new Promise((_, reject) => setTimeout(() => reject(new Error('AI_TIMEOUT')), 90000))
    ]) as string;

    let answer = '';
    let updatedResult: string | null = null;

    const cleanedAnswer = rawAnswer.replace(/^```(?:json|text|markdown)?\s*/i, '').replace(/\s*```$/, '').trim();

    if (isDocumentEditIntent) {
      try {
        const parsed = JSON.parse(cleanedAnswer);
        answer = parsed.chatResponse || 'تم تعديل المطلوب بنجاح.';
        updatedResult = parsed.updatedDocument || null;
      } catch (e) {
        // لو الـ AI رجع النص دايركت من غير JSON بالخطأ، بنحطه في المستند ونخلي الشات يرد برسالة نجاح
        updatedResult = cleanedAnswer;
        answer = 'تم تعديل المستند وتحديث مربع النتيجة بنجاح.';
      }
    } else {
      answer = cleanedAnswer;
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
        ? 'استغرق التعديل وقتاً أطول من المعتاد. حاول مرة أخرى.' 
        : (err?.message || 'تعذر إتمام الطلب. حاول مرة أخرى بعد قليل.'),
    });
  }
}
