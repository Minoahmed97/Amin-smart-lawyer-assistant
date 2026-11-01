import { generateDeepLegalResponse, requiresLegalResearchRequest } from './counter-brief.ts';

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
    const { disputeDetails, clientGoals } = body || {};

    if (!disputeDetails || !disputeDetails.trim()) {
      return res.status(400).json({ error: 'يرجى تقديم تفاصيل النزاع.' });
    }

    rateLimit(req, 'gemini-qualify', 8, 10 * 60 * 1000);
    await enforceAiCooldown(req);

    limitBodyString(disputeDetails, 150000, 'تفاصيل النزاع');
    limitBodyString(clientGoals, 10000, 'الهدف');

    const legalResearch = requiresLegalResearchRequest(disputeDetails, clientGoals);

    const prompt = `[مهمة التكييف والتحليل القانوني المصري]: ابدأ الإجابة بالخلاصة والرأي القانوني المباشر في سؤال المستخدم، في أول فقرة بعنوان «الخلاصة والرأي القانوني المباشر». أجب عن السؤال المحدد بوضوح أولاً، واذكر التكييف القانوني الأرجح والنتيجة العملية بقدر ما تسمح به الوقائع، ثم اشرح الأسباب والتفاصيل بعد ذلك. لا تبدأ بمقدمة عامة ولا تؤخر الإجابة المباشرة إلى نهاية التقرير. بعد الخلاصة، حلّل الوقائع الثابتة والمختلف عليها والناقصة، وطبيعة النزاع والتكييف الأرجح وأي بديل مؤثر، والصفة والمصلحة والاختصاص والإجراءات والمواعيد عند ارتباطها، والأركان القانونية، وأوجه القوة والضعف والمخاطر، والأدلة والمستندات اللازمة، والدفوع المحتملة والإجراء العملي الأنسب. اجعل طول التحليل مناسباً لتعقيد النزاع، ولا تحصره في عدد ثابت من النقاط. لا تستخدم خزنة المحامي أو نماذجها أو أسلوبها في هذه المهمة؛ يجب أن يعتمد التكييف على تفاصيل النزاع والهدف المقدمين هنا فقط. لا تختلق واقعة أو مادة قانونية أو حكماً أو رقم طعن. إذا لم تكن المعلومة مؤكدة، فاذكر أنها تحتاج إلى تحقق. ============================================================ تفاصيل النزاع أو الاستفسار: ${disputeDetails} ${clientGoals ? `\n[الهدف أو المطلب المطلوب]:\n${clientGoals}\n` : ''} ============================================================ قبل الإخراج، راجع النتيجة للتأكد من أن الخلاصة أجابت مباشرة عن سؤال المستخدم أولاً، وأن التحليل التالي متسق معها ولا يغفل نقطة قانونية أو واقعية مؤثرة.`;

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
        // Forward actual model chunks as they arrive. The generator keeps
        // handling continuation internally while the client sees live output.
        await generateDeepLegalResponse(prompt, writeChunk, { legalResearch });
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

    const resultText = await generateDeepLegalResponse(prompt, undefined, { legalResearch });
    if (!resultText.trim()) throw new Error('لم تُنتج خدمة الذكاء الاصطناعي نتيجة صالحة.');
    const usage = await consumeOperation(req, 'gemini-operation');
    return res.json({ result: resultText, remainingCredits: usage.remainingCredits, trialRemaining: usage.trialRemaining });
  } catch (err: any) {
    console.error('Error in /api/gemini/qualify:', err);
    const statusCode = Number(err?.statusCode || err?.status);
    const status = Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600 ? statusCode : 500;
    if (!res.headersSent) return res.status(status).json({ error: err.message || 'فشل التكييف القانوني.' });
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: err.message || 'فشل التكييف القانوني.' })}\n\n`);
      return res.end();
    }
  }
}
