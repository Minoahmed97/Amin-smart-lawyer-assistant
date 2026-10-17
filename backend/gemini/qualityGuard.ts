/** Shared validation and conditional Arabic proofreading for saved legal-generation jobs. */
const VAULT_OPEN = '<LAWYER_VAULT_REFERENCE>';
const VAULT_CLOSE = '</LAWYER_VAULT_REFERENCE>';

export function extractLawyerVaultReference(context: unknown): string {
  if (typeof context !== 'string') return '';
  const start = context.indexOf(VAULT_OPEN);
  if (start < 0) return '';
  const contentStart = start + VAULT_OPEN.length;
  const end = context.indexOf(VAULT_CLOSE, contentStart);
  if (end < 0) return '';
  const reference = context.slice(contentStart, end).trim();
  const arabicChars = (reference.match(/[\u0600-\u06FF]/g) || []).length;
  // Reject marker-only/empty contexts but allow shorter genuine personal models.
  return reference.length >= 80 && arabicChars >= 12 ? reference : '';
}

export function hasLawyerVaultReference(context: unknown): boolean {
  return extractLawyerVaultReference(context).length > 0;
}

function getCurrentCaseLatinTerms(payload: Record<string, string>): Set<string> {
  // Only explicit identity/metadata fields may preserve Latin words. Do not
  // whitelist every word from the facts or opposing brief: an accidental
  // English/Chinese insertion in the source must not authorize it in output.
  const allowedKeys = new Set(['clientName', 'opponentName', 'courtType', 'circuit', 'caseNumber', 'sessionDate']);
  const source = Object.entries(payload)
    .filter(([key, value]) => allowedKeys.has(key) && typeof value === 'string')
    .map(([, value]) => value)
    .join('\n');
  return new Set((source.match(/[A-Za-z][A-Za-z'-]{1,}/g) || []).map((word) => word.toLowerCase()));
}

export function inspectGeneratedArabicText(text: string, payload: Record<string, string> = {}): string[] {
  const value = String(text || '');
  const reasons: string[] = [];
  if (!value.trim()) return ['empty-output'];

  if (/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/u.test(value)) {
    reasons.push('cjk-or-east-asian-characters');
  }

  const allowedLatinTerms = getCurrentCaseLatinTerms(payload);
  const latinWords = (value.match(/\b[A-Za-z][A-Za-z'-]{2,}\b/g) || []);
  const unexpectedLatinWords = [...new Set(latinWords.filter((word) => !allowedLatinTerms.has(word.toLowerCase())))];
  if (unexpectedLatinWords.length) reasons.push('unexpected-latin-words');

  if (/\*\*|__|```|(^|\n)\s{0,3}#{1,6}\s/m.test(value)) reasons.push('markdown-formatting-leak');
  if (/\[(?:اسم\s|رقم\s|بيانات\s|أدخل\s|ادخل\s|ضع\s|يُضاف\s|يضاف\s|اسم المدعي|اسم الخصم|المحكمة المختصة|بيانات القضية)[^\]\n]{0,100}\]/u.test(value)) {
    reasons.push('unfilled-template-placeholders');
  }

  const letters = value.match(/[A-Za-z\u0600-\u06FF]/g) || [];
  const arabicLetters = value.match(/[\u0600-\u06FF]/g) || [];
  if (letters.length >= 120 && arabicLetters.length / letters.length < 0.45) reasons.push('low-arabic-text-ratio');
  return [...new Set(reasons)];
}

export function generatedTextIssueScore(text: string, payload: Record<string, string> = {}): number {
  const value = String(text || '');
  const reasons = inspectGeneratedArabicText(value, payload);
  const cjkCount = (value.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/gu) || []).length;
  const allowedLatinTerms = getCurrentCaseLatinTerms(payload);
  const latinCount = (value.match(/\b[A-Za-z][A-Za-z'-]{2,}\b/g) || []).filter((word) => !allowedLatinTerms.has(word.toLowerCase())).length;
  const markdownCount = (value.match(/\*\*|__|```|(^|\n)\s{0,3}#{1,6}\s/gm) || []).length;
  const placeholderCount = (value.match(/\[(?:اسم\s|رقم\s|بيانات\s|أدخل\s|ادخل\s|ضع\s|يُضاف\s|يضاف\s|اسم المدعي|اسم الخصم|المحكمة المختصة|بيانات القضية)[^\]\n]{0,100}\]/gu) || []).length;
  return cjkCount * 5 + latinCount * 3 + markdownCount * 2 + placeholderCount * 4 + reasons.filter((reason) => reason === 'low-arabic-text-ratio').length * 20;
}

export function buildArabicProofreadingPrompt(text: string, taskType: string, payload: Record<string, string>): string {
  const documentType = String(payload.effectiveWorkType || payload.documentType || payload.briefType || payload.judicialWorkType || taskType || '').trim();
  const caseNames = ['clientName', 'opponentName', 'courtType', 'circuit', 'caseNumber', 'sessionDate']
    .map((key) => {
      const value = String(payload[key] || '').trim();
      return value ? `${key}: ${value}` : '';
    })
    .filter(Boolean)
    .join('\n');

  return `مهمة تدقيق لغوي نهائي للنص القانوني القائم، وليست إعادة صياغة من الصفر.
نوع العمل: ${documentType || taskType}.
${caseNames ? `بيانات التعريف من القضية الحالية التي يجب الحفاظ عليها كما هي:\n${caseNames}\n` : ''}
نفّذ تدقيقاً لغوياً عربياً وقانونياً محافظاً بدقة. حافظ على أسلوب الكاتب وديباجته وبنية المستند وترتيب الفقرات والدفوع والحجج والطلبات كما هي. صحح فقط الأخطاء الإملائية والنحوية الواضحة وسوء تركيب الجملة، وأصلح المسافات وعلامات الترقيم. حوّل أي كلمة إنجليزية عارضة أو جملة صينية/يابانية/كورية أو نص أجنبي غير لازم إلى العربية الواضحة، أو احذفها إن كانت بقايا تعليمات تنسيق أو نصاً بلا معنى. أبقِ فقط الاسم الأجنبي أو المصطلح الرسمي الضروري الذي يمكن التحقق من وجوده في بيانات القضية الحالية؛ لا تستعر ألفاظاً أجنبية من نموذج قديم أو من تعليمات التوليد. احذف علامات Markdown مثل ** و## والحقول النائبة غير المعبأة. لا تضف وقائع أو أسماء أو تواريخ أو مستندات أو دفوعاً أو مواد أو أحكاماً أو طلبات جديدة، ولا تحذف أي نقطة قانونية أو معلومة أو حجة موجودة. لا تختصر النص ولا تلخصه ولا تغير موقفه القانوني ولا تعيد ترتيب الأقسام. لا تضف مقدمة أو خاتمة من عندك. أخرج المستند الكامل بعد التصحيح فقط، بالعربية القانونية، من أول سطر إلى آخر سطر.

<النص_القانوني_للتدقيق>
${text}
</النص_القانوني_للتدقيق>`;
}
