import { generateDeepLegalResponse } from './counter-brief.ts';

import { requireActiveSession, consumeOperation } from '../auth.ts';
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
    const { draftText, enhancementType, vaultContext } = body || {};

    if (!draftText || !draftText.trim()) {
      return res.status(400).json({ error: 'يرجى تقديم نص المسودة المراد تدقيقها.' });
    }

    rateLimit(req, 'gemini-refine', 8, 10 * 60 * 1000);
    await requireActiveSession(req);

    limitBodyString(draftText, 200000, 'المسودة');
    limitBodyString(vaultContext, 30000, 'سياق الخزانة');

    const typePrompts: Record<string, string> = {
      moreDecisive: 'اجعل الصياغة أكثر حسماً وقوة قانونية مع تعزيز العبارات القضائية الصارمة.',
      addPrecedents: 'راجع الحاجة إلى مبادئ وأحكام قضائية مصرية مؤيدة، ولا تضف أي حكم أو رقم طعن إلا إذا كان متحققاً؛ وإلا ضع تنبيهاً للتحقق.',
      addProceduralDefenses: 'أضف الدفوع الشكلية والإجرائية (عدم القبول، الاختصاص، المواعيد).',
      auditCheck: 'راجع المسودة وتأكد من اكتمال الديباجة، الوقائع، الأسانيد والطلبات الختامية.',
    };

    const prompt = `[تدقيق ومراجعة قانونية عميقة للمسودة القضائية]: الهدف المطلوب: [${typePrompts[enhancementType] || 'تحسين الصياغة'}] ======================================== ${vaultContext ? `[خزانة المحامي — أسلوب وبنية فقط]:\n${vaultContext}\n` : ''} نص المسودة الحالية: ======================================== ${draftText} ======================================== لا تكتفِ بالتحسين اللغوي. افحص المسودة نقطة نقطة بحثاً عن: - واقعة أو مستند أو دفع أو طلب مؤثر تم إغفاله. - تناقض بين الوقائع والأسباب والطلبات. - قفزة منطقية أو افتراض غير ثابت. - ضعف في التكييف أو في تسلسل الواقعة ← الدليل ← القاعدة القانونية ← التطبيق ← النتيجة. - دفع إجرائي أو شكلي أو موضوعي مرتبط لم يُفحص. - استناد إلى مادة أو حكم أو رقم طعن غير مؤكد. - طلبات لا تتفق مع الأسباب. - مواضع تحتاج معلومة أو مستنداً إضافياً. أصلح ما يمكن إصلاحه اعتماداً على النص والمعلومات المتاحة فقط، ولا تخترع وقائع أو مستندات أو أحكاماً. إذا كان التعديل يتطلب تحققاً خارجياً، ضع تنبيهاً واضحاً بدلاً من الاختلاق. في الطلبات الختامية خصوصاً: لا تؤلف طلبات جديدة لمجرد أن صياغتها تبدو قانونية. اربط كل طلب بالوقائع والدفوع والأسباب والنتيجة الموجودة في المسودة وبأي طلب أصلي أدخله المحامي. احذف أو عدّل فقط ما ثبت أنه غير متسق مع المسودة، ولا تضف طلباً جديداً بلا سند. قبل الإخراج افحص كل طلب: ما سببه في جسم المذكرة؟ وهل يتفق مع النتيجة؟ وهل أغفل طلب أصلي واضح؟ أخرج النسخة القانونية المحسنة كاملة دون تحية أو عبارات من نوع «بصفتي مستشاراً». حافظ على ديباجة المحامي وترويته واسمه واسم مكتبه وأي عناصر ثابتة من بصمته إذا كانت واضحة في المسودة أو سياق الخزنة، ولا تحذفها باعتبارها بيانات قديمة؛ احذف فقط بيانات القضية القديمة غير التابعة للقضية الحالية. لا تحذف نقطة مؤثرة لمجرد الاختصار، ولا تطِل أو تكرر ما لا يحتاج إلى تفصيل. لا تعتبر النسخة مكتملة إذا توقفت قبل نهاية المذكرة أو قبل الطلبات الختامية؛ أخرج المستند كاملاً من أوله إلى آخره، وحافظ على الأقسام الجوهرية حتى لو كانت المسودة طويلة. اجعل مقدار الشرح والتحليل متناسباً مع أهمية وتعقيد النقطة: المختصر حين يكون كافياً، والتفصيل حين يكون ضرورياً للفهم والإثبات والتطبيق. لا تضع «الأسانيد القانونية» أو «السند القانوني» كعنوان مستقل؛ أدخل القواعد القانونية في موضعها الطبيعي داخل الحجة. حافظ على بنية المستند اللازمة لنوعه، لكن أزل المقدمات والنهايات الإنشائية الزائدة. بعد الفحص اكتب النسخة القانونية المحسنة كاملة، مع الحفاظ على المعنى الصحيح للمسودة وعدم حذف نقطة مؤثرة، ثم راجعها داخلياً مرة أخيرة قبل الإخراج.`;

    if (body?.stream === true) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      // Keep the Vercel stream alive while Gemini prepares its first token.
      // Without this, a slow first token can surface in the browser as
      // "Failed to fetch" even though the backend is still working.
      res.write(JSON.stringify({ type: 'start' }) + '\n');
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) {
          res.write(JSON.stringify({ type: 'keepalive' }) + '\n');
        }
      }, 5000);

      let streamedAny = false;
      const writeChunk = (text: string) => {
        if (text) {
          streamedAny = true;
          res.write(JSON.stringify({ type: 'chunk', text }) + '\n');
        }
      };
      try {
        // Forward actual model chunks as they arrive. The generator keeps
        // handling continuation internally while the client sees live output.
        await generateDeepLegalResponse(prompt, writeChunk);
        if (!streamedAny) throw new Error('لم تُنتج خدمة الذكاء الاصطناعي نتيجة صالحة.');
        await consumeOperation(req, 'gemini-operation');
        res.write(JSON.stringify({ type: 'done' }) + '\n');
        return res.end();
      } catch (streamErr: any) {
        if (!res.writableEnded) {
          res.write(JSON.stringify({ type: 'error', error: streamErr?.message || 'فشلت الاستجابة المتدفقة.' }) + '\n');
          return res.end();
        }
        return;
      } finally {
        clearInterval(heartbeat);
      }
    }

    const resultText = await generateDeepLegalResponse(prompt);
    if (!resultText.trim()) throw new Error('لم تُنتج خدمة الذكاء الاصطناعي نتيجة صالحة.');
    const usage = await consumeOperation(req, 'gemini-operation');
    return res.json({ result: resultText, remainingCredits: usage.remainingCredits, trialRemaining: usage.trialRemaining });
  } catch (err: any) {
    console.error('Error in /api/gemini/refine:', err);
    const statusCode = Number(err?.statusCode || err?.status);
    const status = Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600 ? statusCode : 500;
    if (!res.headersSent) return res.status(status).json({ error: err.message || 'فشل تدقيق المسودة.' });
    if (!res.writableEnded) {
      res.write(JSON.stringify({ type: 'error', error: err.message || 'فشل تدقيق المسودة.' }) + '\n');
      return res.end();
    }
  }
}
