import { executeWithKeyRotation } from '../keyRotation.ts';

type LegalReference = { kind: 'case' | 'statute'; label: string; number: string; year?: string; article?: string };
type GroundedSource = { uri: string; title: string; domain: string; official: boolean };

const OFFICIAL_HOSTS = new Set(['register.cc.gov.eg', 'www.alamiria.com', 'alamiria.com', 'www.sccourt.gov.eg', 'sccourt.gov.eg']);
const ALLOWED_HOSTS = new Set([...OFFICIAL_HOSTS, 'www.mksegypt.org', 'mksegypt.org', 'www.laweg.net', 'laweg.net', 'lawhub.info', 'www.lawhub.info']);

function westernDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, (digit) => '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹'.indexOf(digit) < 10
    ? String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit))
    : String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit)));
}

function normalize(value: string): string {
  return westernDigits(value || '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/[\u064B-\u065F\u0670ـ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function extractReferences(text: string): LegalReference[] {
  const refs: LegalReference[] = [];
  const seen = new Set<string>();
  const normalized = westernDigits(text);
  const casePattern = /(?:الطعن|طعن)\s*(?:رقم)?\s*([0-9]{1,6})\s*(?:لسنة|/|سنه)\s*([0-9]{1,3})\s*(?:ق|هـ|ه)?/g;
  for (const match of normalized.matchAll(casePattern)) {
    const ref = { kind: 'case' as const, label: match[0].trim(), number: match[1], year: match[2] };
    const key = `case:${ref.number}/${ref.year}`;
    if (!seen.has(key)) { seen.add(key); refs.push(ref); }
  }
  const statutePattern = /(?:القانون|قانون)\s*(?:رقم)?\s*([0-9]{1,4})\s*لسنة\s*([0-9]{1,4})/g;
  for (const match of normalized.matchAll(statutePattern)) {
    const ref = { kind: 'statute' as const, label: match[0].trim(), number: match[1], year: match[2] };
    const key = `statute:${ref.number}/${ref.year}`;
    if (!seen.has(key)) { seen.add(key); refs.push(ref); }
  }
  const articlePattern = /(?:المادة|ماده)\s*\(?\s*([0-9]{1,3})\s*\)?/g;
  const articles = [...normalized.matchAll(articlePattern)].map((m) => m[1]);
  for (const ref of refs.filter((item) => item.kind === 'statute')) {
    const possible = articles.find((article) => text.slice(Math.max(0, text.indexOf(ref.label) - 250), text.indexOf(ref.label) + 500).match(new RegExp(`(?:المادة|ماده)\\s*\\(?\\s*${article}\\b`)));
    if (possible) ref.article = possible;
  }
  return refs.slice(0, 12);
}

function getGroundedSources(response: any): GroundedSource[] {
  const candidates = Array.isArray(response?.candidates) ? response.candidates : [];
  const chunks = candidates.flatMap((candidate: any) => candidate?.groundingMetadata?.groundingChunks || []);
  const sources: GroundedSource[] = [];
  const seen = new Set<string>();
  for (const chunk of chunks) {
    const uri = String(chunk?.web?.uri || '').trim();
    if (!uri) continue;
    try {
      const parsed = new URL(uri);
      const domain = parsed.hostname.toLowerCase();
      if (!ALLOWED_HOSTS.has(domain) || !/^https?:$/.test(parsed.protocol) || seen.has(uri)) continue;
      seen.add(uri);
      sources.push({ uri, title: String(chunk?.web?.title || domain), domain, official: OFFICIAL_HOSTS.has(domain) });
    } catch {}
  }
  return sources.slice(0, 8);
}

function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .slice(0, 180000);
}

async function inspectSource(source: GroundedSource, reference: LegalReference): Promise<{ matched: boolean; detail: string }> {
  try {
    const response = await fetch(source.uri, {
      method: 'GET',
      headers: { 'User-Agent': 'AminLegalReferenceVerifier/1.0 (+https://amin-smart-lawyer-assistant.vercel.app)' },
      signal: AbortSignal.timeout(7000),
      redirect: 'follow',
    });
    if (!response.ok) return { matched: false, detail: `تعذر فتح المصدر (HTTP ${response.status})` };
    const finalUrl = new URL(response.url);
    if (!ALLOWED_HOSTS.has(finalUrl.hostname.toLowerCase())) return { matched: false, detail: 'تغير نطاق المصدر إلى نطاق غير معتمد' };
    const html = await response.text();
    const page = normalize(htmlToText(html));
    const hasNumber = page.includes(normalize(reference.number));
    const hasYear = reference.year ? page.includes(normalize(reference.year)) : true;
    const hasArticle = reference.article ? new RegExp(`(?:الماده|ماده)\\s*${reference.article}\\b`).test(page) : true;
    const matched = hasNumber && hasYear && hasArticle;
    return {
      matched,
      detail: matched
        ? 'عُثر داخل صفحة المصدر على رقم المرجع وسنته' + (reference.article ? ' ورقم المادة' : '')
        : 'لم يمكن مطابقة جميع بيانات المرجع آلياً داخل نص الصفحة',
    };
  } catch {
    return { matched: false, detail: 'تعذر الوصول إلى نص المصدر أو قراءته' };
  }
}

/**
 * Performs a separate, Gemini-Google-Search-backed reference lookup, then
 * checks the returned source pages for the exact citation identifiers.
 * It deliberately reports identifier matching, not judicial-principle correctness.
 */
export async function verifyLegalReferences(text: string): Promise<string> {
  const references = extractReferences(text);
  if (!references.length) return '';
  const queries = references.map((ref) => ref.label).join('\n');
  try {
    const verification = await executeWithKeyRotation(async (ai) => {
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `ابحث عبر Google Search عن المراجع القانونية المصرية التالية فقط، وأعد نتائج البحث بمصادرها. لا تخترع مصادر ولا تستنتج صحة المرجع من الذاكرة. إذا لم تجد نتيجة، قل ذلك. المراجع:\n${queries}`,
        config: {
          temperature: 0,
          maxOutputTokens: 1800,
          tools: [{ googleSearch: {} }],
        },
      });
      return { response, text: String(response?.text || '') };
    }, undefined, undefined, true, { deadlineAt: Date.now() + 25000 });
    const sources = getGroundedSources(verification.response);
    if (!sources.length) {
      return '\n\n### تقرير التحقق الآلي من المراجع\nتعذر الحصول على مصادر بحث قابلة للفحص من نتائج البحث؛ لذلك لم يُعتمد أي مرجع على أنه متحقق. يلزم التحقق اليدوي من المصدر الأصلي.';
    }
    const rows: string[] = [];
    for (const reference of references) {
      const checks = await Promise.all(sources.map(async (source) => ({
        source,
        result: await inspectSource(source, reference),
      })));
      const match = checks.find((item) => item.result.matched);
      const candidate = checks.find((item) => item.source.official) || checks[0];
      if (match) {
        rows.push(`- **مطابقة بيانات المرجع:** ${reference.label} — ${match.source.official ? 'مصدر رسمي' : 'مستودع غير رسمي'}؛ ${match.result.detail}. المصدر: ${match.source.uri}`);
      } else if (candidate) {
        rows.push(`- **لم يتم التحقق:** ${reference.label} — ${candidate.result.detail}. مصدر البحث: ${candidate.source.uri}`);
      } else {
        rows.push(`- **لم يتم التحقق:** ${reference.label} — لم يظهر مصدر مصري مسموح بفحصه.`);
      }
    }
    return '\n\n### تقرير التحقق الآلي من المراجع\n' +
      'هذا الفحص يطابق بيانات الرقم والسنة (ورقم المادة عند توافره) داخل صفحات المصادر التي أمكن الوصول إليها. لا يثبت وحده أن المبدأ المنسوب للحكم صحيح أو أن النص هو آخر صيغة تشريعية؛ افحص الحكم كاملاً وتاريخ السريان قبل الإيداع.\n' +
      rows.join('\n');
  } catch (error: any) {
    return '\n\n### تقرير التحقق الآلي من المراجع\nتعذر إتمام البحث المستقل (' +
      String(error?.message || 'خطأ غير محدد').slice(0, 180) +
      ')؛ لم يُعتمد أي مرجع على أنه متحقق.';
  }
}
