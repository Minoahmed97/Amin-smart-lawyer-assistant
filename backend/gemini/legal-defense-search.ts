import { executeWithKeyRotation, GEMINI_MODELS } from '../keyRotation.ts';
import { requireSession } from '../auth.ts';
import { rateLimit, limitBodyString } from '../security.ts';

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  try {
    requireSession(req);
    rateLimit(req, 'gemini-legal-defense-search', 12, 10 * 60 * 1000);
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch {}
    }
    const query = String(body?.query || '').trim();
    if (query.length < 3) return res.status(400).json({ error: 'اكتب موضوع الدفع أو كلمتين على الأقل للبحث.' });
    limitBodyString(query, 500, 'موضوع البحث');

    const result = await executeWithKeyRotation(async (ai: any, _key: string, model: string) => {
      const response = await ai.models.generateContent({
        model,
        contents: `ابحث على الإنترنت عن دفوع ومبادئ قانونية مصرية مرتبطة بالموضوع التالي: "${query}". أعط الأولوية للمصادر المصرية الرسمية أو القانونية المتخصصة ذات السمعة الواضحة. لا تخترع أحكاماً أو أرقام طعون أو مواد أو روابط. اشرح لكل نتيجة: اسم الدفع، متى يصلح، شروط انطباقه، ملخص السند القانوني إن أمكن، وما يلزم التحقق منه قبل استعماله. لا تعتبر النتيجة صالحة لقضية بعينها دون الاطلاع على وقائعها. أجب بالعربية.`,
        config: {
          temperature: 0.15,
          tools: [{ googleSearch: {} }],
        },
      });
      const chunks = response?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
      const sources = chunks.map((chunk: any) => chunk?.web).filter((web: any) => web?.uri).map((web: any) => ({
        title: String(web.title || web.uri),
        url: String(web.uri),
      }));
      return { summary: String(response?.text || '').trim(), sources };
    }, GEMINI_MODELS, undefined, true, { providerAttempt: 'gemini-primary' });

    if (!result.summary) return res.status(502).json({ error: 'لم يُرجع البحث نتيجة موثوقة. حاول بصياغة أخرى.' });
    return res.status(200).json({ ...result, disclaimer: 'نتائج البحث استرشادية؛ راجع المصدر والنص القانوني الساري قبل الاستناد إليها.' });
  } catch (error: any) {
    const status = Number(error?.statusCode || error?.status);
    return res.status(Number.isInteger(status) && status >= 400 && status < 600 ? status : 500)
      .json({ error: error?.message || 'تعذر تنفيذ البحث القانوني حالياً.' });
  }
}
