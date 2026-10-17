import { generateDeepLegalResponse } from './counter-brief.ts';

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

    const prompt = `[مهمة تكييف النزاع القانوني المصري]: ابدأ فوراً بإجابة مباشرة عن السؤال، دون تحية أو مقدمة أو تعريف. افتتح بعنوان «الخلاصة القانونية» ثم اذكر التكييف الأرجح والنتيجة العملية في فقرتين قصيرتين كحد أقصى، بعبارات واضحة وحاسمة بقدر ما تسمح به الوقائع. لا تؤخر الخلاصة ولا تكررها. بعد ذلك أضف فقط الأسباب القانونية الضرورية، وأي نقص جوهري أو مخاطرة أو إجراء عملي مؤثر؛ اجعل التحليل موجزاً ومتناسباً مع تعقيد النزاع، ولا تحوّله إلى تقرير طويل أو قائمة عامة إذا لم تستلزم الوقائع ذلك. ميّز بين الوقائع الثابتة والافتراضات، ولا تختلق واقعة أو مادة قانونية أو حكماً أو رقم طعن؛ وإذا لم تكن المعلومة مؤكدة فاذكر أنها تحتاج إلى تحقق. اعتمد حصراً على تفاصيل النزاع والهدف المقدمين هنا، ولا تستخدم خزنة المحامي أو نماذج الصياغة في تكييف النزاع. ============================================================ تفاصيل النزاع أو الاستفسار: ${disputeDetails} ${clientGoals ? `\n[الهدف أو المطلب المطلوب]:\n${clientGoals}\n` : ''} ============================================================ راجع أن أول ما يظهر للمستخدم هو الخلاصة المباشرة، وأن كل تفصيل بعدها ضروري ومتصّل بالسؤال.`;

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
        await generateDeepLegalResponse(prompt, writeChunk);
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
    const statusCode = Number(err?.statusCode || err?.status);
    const status = Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600 ? statusCode : 500;
    if (!res.headersSent) return res.status(status).json({ error: err.message || 'فشل التكييف القانوني.' });
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: err.message || 'فشل التكييف القانوني.' })}\n\n`);
      return res.end();
    }
  }
}
