Import { generateDeepLegalResponse } from './counter-brief.ts';

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
    const {
      opponentBriefText,
      courtType,
      caseNature,
      judicialWorkType,
      ourPosition,
      additionalFacts,
      vaultContext,
    } = body || {};

    if (!opponentBriefText || !opponentBriefText.trim()) {
      return res.status(400).json({ error: 'يرجى تقديم نص مذكرة الخصم.' });
    }

    rateLimit(req, 'gemini-deconstruct', 8, 10 * 60 * 1000);
    await enforceAiCooldown(req);

    limitBodyString(opponentBriefText, 200000, 'مذكرة الخصم');
    limitBodyString(vaultContext, 30000, 'سياق الخزانة');

    const workTypeInstruction =
      judicialWorkType && judicialWorkType.trim()
        ? `- نوع المستند المقابل المطلوب من المحامي: "${judicialWorkType.trim()}". التزم بهذا النوع ولا تستبدله بنوع آخر.`
        : `- حدّد بذكاء نوع المستند القضائي الأنسب للرد على المستند محل الفحص، مثل مذكرة رد/دفاع، عريضة أو صحيفة دعوى، صحيفة طعن، حافظة مستندات، إنذار، تعقيب، أو غير ذلك بحسب الوقائع والطلبات. لا تفترض أن الرد يجب أن يكون مذكرة دفاع.`;

    const prompt = `[مهمة تفكيك المستند وإعداد الرد القانوني المناسب — فحص شامل]: ${workTypeInstruction} ${courtType ? `- المحكمة: ${courtType}` : ''} ${caseNature ? `- طبيعة الدعوى: ${caseNature}` : ''} ${ourPosition ? `- موقفنا: ${ourPosition}` : ''} ${additionalFacts ? `- وقائع وأدلة إضافية لصالحنا: ${additionalFacts}` : ''} ${vaultContext ? `\n[خزانة المحامي — أسلوب وبنية فقط، لا تستورد منها وقائع]:\n${vaultContext}\n` : ''} ======================================== نص مذكرة الخصم المراد تفكيكها بالكامل: ======================================== ${opponentBriefText} ======================================== نفّذ أولاً فحصاً داخلياً كاملاً ثم أخرج النتيجة مباشرة. اللغة الإلزامية للإخراج هي العربية الفصحى القانونية فقط؛ لا تستخدم الصينية أو اليابانية أو الكورية أو أي أحرف غير عربية إلا الأرقام والاختصارات الأجنبية التي تظهر في المستند الأصلي عند الضرورة. حافظ على النص العربي المقدم كما هو ولا تحوّله إلى لغة أخرى. بعد الخلاصة مباشرة اكتب سطراً واضحاً بعنوان «نوع العمل القضائي المقابل المقترح:» ثم اذكر نوع المستند الذي ينبغي صياغته بناءً على الفحص. إذا حدد المحامي نوعاً صراحةً فاذكره كما هو والتزم به. يجب أن تظل «طبيعة الدعوى» منفصلة عن «نوع المستند المقابل». يجب أن تكون أول فقرة بعنوان «خلاصة الرأي القانوني» وألا تتجاوز خمسة أسطر، وتلخص النتيجة القانونية العملية في القضية بوضوح وعقلانية. بعد الخلاصة أكمل التقرير التفصيلي كاملاً دون اختصار. ابدأ في صلب الموضوع دون تحية أو تعريف بنفسك أو عبارات تمهيدية، ولا تضع خاتمة إنشائية أو عبارات وداع. لا تجعل «الأسانيد القانونية» عنواناً مستقلاً؛ أدخل القواعد والمواد والمبادئ القانونية داخل التحليل والرد في مواضعها الطبيعية. لا تستخدم لغة اختصامية أو هجومية، ووازن بين قوة موقف الموكل وقوة موقف الخصم. ثم يتضمن التقرير، بحسب ما ينطبق: 1- ملخص القضية ومحل النزاع والطلبات الفعلية. 2- تفكيك ادعاءات الخصم نقطة نقطة، مع سند كل ادعاء ومدى ثبوته. 3- مقارنة أقوال الخصم بالمستندات والوقائع والتواريخ وكشف التناقضات. 4- أخطاء أو سوء تطبيق القانون، مع عدم ذكر نص أو حكم غير متحقق منه. 5- قصور الإثبات ونقاط الضعف في حجية أو دلالة المستندات، مع التمييز بين العيب الثابت والاحتمال الذي يحتاج تحققاً. 6- الدفوع الشكلية والإجرائية والموضوعية المحتملة متى كانت مرتبطة. 7- نقاط القوة والضعف لدى موكلنا ولدى الخصم. 8- الثغرات الخفية أو النقاط التي قد يغفلها القارئ السريع. 9- ترتيب أقوى الردود والدفاعات حسب الأثر والأولوية، مع ذكر المستند أو الواقعة التي تدعم كل رد. 10- النقاط التي تحتاج مستنداً أو معلومة إضافية قبل الجزم. 11- استراتيجية الرد النهائية. 12- المذكرة المقابلة المقترحة، مكتوبة بأسلوب المحامي في الخزانة، دون استيراد وقائع من النموذج الاسترشادي. لا تكتفِ بالتلخيص ولا تعتبر المهمة مكتملة قبل مراجعة شاملة للملف والنتيجة.`;

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
    console.error('Error in /api/gemini/deconstruct:', err);
    const statusCode = Number(err?.statusCode || err?.status);
    const status = Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600 ? statusCode : 500;
    if (!res.headersSent) return res.status(status).json({ error: err.message || 'فشل التفكيك.' });
    if (!res.writableEnded) {
      res.write(JSON.stringify({ type: 'error', error: err.message || 'فشل التفكيك.' }) + '\n');
      return res.end();
    }
  }
}
