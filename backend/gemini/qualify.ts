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
    const { disputeDetails, clientGoals, vaultContext } = body || {};

    if (!disputeDetails || !disputeDetails.trim()) {
      return res.status(400).json({ error: 'يرجى تقديم تفاصيل النزاع.' });
    }

    rateLimit(req, 'gemini-qualify', 8, 10 * 60 * 1000);
    await requireActiveSession(req);

    limitBodyString(disputeDetails, 150000, 'تفاصيل النزاع');
    limitBodyString(clientGoals, 10000, 'الهدف');
    limitBodyString(vaultContext, 30000, 'سياق الخزانة');

    const prompt = `[مهمة التكييف والتحليل القانوني المصري الشامل]: ============================================================ حلّل النزاع بالكامل قبل إصدار النتيجة. لا تجعل الإجابة مقيدة بأربع نقاط إذا كان الملف يحتاج إلى تحليل أعمق. افحص: - الوقائع الثابتة والمختلف عليها والناقصة. - طبيعة النزاع والتكييف القانوني الأرجح، وأي تكييف بديل مؤثر. - الصفة والمصلحة والاختصاص والإجراءات والمواعيد متى كانت مرتبطة. - أركان الدعوى/الجريمة أو عناصرها القانونية بحسب الحالة. - أوجه القوة والضعف والمخاطر. - الأدلة والمستندات اللازمة لإثبات كل عنصر، وما ينقص منها. - الدفوع المحتملة وترتيبها حسب القوة. - الإجراء العملي الأنسب، وما قد يغير النتيجة. قدّم النتيجة في صورة منظمة ومباشرة تناسب حجم وتعقيد النزاع، مع بيان درجة الثقة والنقاط التي تحتاج تحققاً. ممنوع اختلاق مادة قانونية أو حكم أو رقم طعن أو واقعة. إذا لم تكن المعلومة مؤكدة، قل إنها تحتاج إلى تحقق. ============================================================ تفاصيل النزاع أو الاستفسار: ${disputeDetails} ${clientGoals ? `\n[الهدف أو المطلب المطلوب]:\n${clientGoals}\n` : ''} ${vaultContext ? `\n${vaultContext}\n` : ''} ============================================================ قبل الإخراج نفّذ مراجعة داخلية نهائية للتأكد من عدم إغفال نقطة قانونية أو واقعية مؤثرة. إذا وُجد سياق لخزانة المحامي، استخدمه لاستخلاص بصمة الكتابة المهنية عند صياغة الأجزاء التفسيرية والنتيجة: الترويسة والديباجة، ترتيب الأفكار، طريقة عرض الوقائع، الانتقال بين الحجج، المصطلحات، أسلوب الخاتمة وتسلسل الطلبات إن ظهرت. لا تستورد من النماذج أي وقائع أو أسماء أو أرقام قضايا أو تواريخ تخص قضايا سابقة، ولا تخترع عناصر ثابتة غير موجودة فيها. يجب أن يظل التحليل القانوني مبنياً على النزاع الحالي فقط.`;

    if (body?.stream === true) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      // Keep the Vercel stream alive while Gemini prepares its first token.
      // Without this, a slow first token can surface in the browser as
      // "Failed to fetch" even though the backend is still working.
      res.write(`data: ${JSON.stringify({ type: 'start' })}\n\n`);
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ type: 'keepalive' })}\n\n`);
        }
      }, 5000);

      let streamedAny = false;
      const writeChunk = (text: string) => {
        if (text) {
          streamedAny = true;
          res.write(`data: ${JSON.stringify({ type: 'chunk', text })}\n\n`);
        }
      };
      try {
        // Generate the complete legal result before emitting it to the client.
        // The shared generator has its own continuation logic for MAX_TOKENS,
        // so this prevents the streaming path from exposing only the first
        // generation segment when a long legal answer is continued internally.
        const completeResult = await generateDeepLegalResponse(prompt);
        writeChunk(completeResult);
        if (!streamedAny) throw new Error('لم تُنتج خدمة الذكاء الاصطناعي نتيجة صالحة.');
        await consumeOperation(req, 'gemini-operation');
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        return res.end();
      } catch (streamErr: any) {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify({ type: 'error', error: streamErr?.message || 'فشلت الاستجابة المتدفقة.' })}\n\n`);
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
    console.error('Error in /api/gemini/qualify:', err);
    return res.status(500).json({ error: err.message || 'فشل التكييف القانوني.' });
  }
}
