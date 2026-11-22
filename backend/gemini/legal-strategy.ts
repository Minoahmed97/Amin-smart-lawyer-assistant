/**
 * Builds a structured, evidence-aware case strategy brief from the data already
 * supplied to an existing legal task. This is a preparation function, not a
 * separate model request: it normalizes case context for the task's existing
 * generation call and deliberately labels inferred procedural stages as clues.
 */

export type LegalStrategyTask =
  | 'drafting'
  | 'deconstruct'
  | 'qualification'
  | 'refinement';

export interface LegalStrategyInput {
  task: LegalStrategyTask;
  courtType?: string;
  caseNature?: string;
  judicialWorkType?: string;
  clientRole?: string;
  clientGoals?: string;
  sessionDate?: string;
  caseNumber?: string;
  facts?: string;
  disputeDetails?: string;
  opponentBriefText?: string;
  ourPosition?: string;
  defenses?: string;
  requests?: string;
  customInstructions?: string;
  priorAnalysis?: string;
  priorDraft?: string;
}

export interface LegalStrategyBrief {
  task: LegalStrategyTask;
  declaredWorkType: string;
  proceduralStageClues: string[];
  hasPriorAnalysis: boolean;
  hasPriorDraft: boolean;
  hasOpponentSubmission: boolean;
  hasExplicitClientGoal: boolean;
  context: string;
}

const STAGE_CLUES: Array<{ label: string; pattern: RegExp }> = [
  { label: 'إشارة إلى جلسة أخيرة أو ختام المرافعة', pattern: /آخر\s+جلسة|ختام\s+المرافعة|حجز(?:ت)?\s+للحكم|للحكم|للنطق\s+بالحكم/i },
  { label: 'إشارة إلى تقديم مذكرة أو مستند من الخصم', pattern: /مذكرة\s+(?:الخصم|مقدمة|شارحة|دفاع)|قدم(?:ت)?\s+(?:الخصم|مذكرة)|حافظة\s+مستندات/i },
  { label: 'إشارة إلى تحقيق أو إحالة لخبير', pattern: /إحالة\s+للتحقيق|تحقيق\s+أمام|ندب\s+خبير|تقرير\s+الخبير|إيداع\s+تقرير/i },
  { label: 'إشارة إلى مرحلة طعن', pattern: /استئناف|نقض|طعن\s+(?:بالنقض|أمام)|الإدارية\s+العليا/i },
  { label: 'إشارة إلى بدء الخصومة أو إعلانها', pattern: /صحيفة\s+دعوى|عريضة\s+دعوى|إعلان\s+صحيفة|رفع\s+الدعوى/i },
];

function clean(value: unknown, max = 12000): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export function prepareLegalStrategy(input: LegalStrategyInput): LegalStrategyBrief {
  const facts = clean(input.facts || input.disputeDetails, 18000);
  const opponent = clean(input.opponentBriefText, 18000);
  const priorAnalysis = clean(input.priorAnalysis, 14000);
  const priorDraft = clean(input.priorDraft, 14000);
  const declaredWorkType = clean(input.judicialWorkType, 300);
  const combined = [
    facts,
    opponent,
    clean(input.ourPosition, 4000),
    clean(input.defenses, 5000),
    clean(input.requests, 4000),
    clean(input.customInstructions, 4000),
    priorAnalysis,
    priorDraft,
  ].filter(Boolean).join('\n');

  const proceduralStageClues = STAGE_CLUES
    .filter(({ pattern }) => pattern.test(combined))
    .map(({ label }) => label);

  const fields = [
    ['نوع المهمة الحالية', input.task],
    ['المحكمة', clean(input.courtType, 300) || 'غير محددة في المدخلات'],
    ['طبيعة النزاع', clean(input.caseNature, 500) || 'تُستخلص بحذر من الوقائع'],
    ['رقم الدعوى', clean(input.caseNumber, 200) || 'غير وارد'],
    ['تاريخ الجلسة', clean(input.sessionDate, 200) || 'غير وارد'],
    ['صفة الموكل', clean(input.clientRole, 300) || 'غير محددة صراحةً؛ لا تفترضها'],
    ['نوع العمل الذي حدده المحامي', declaredWorkType || 'لم يحدده؛ قيّم الملاءمة قبل اقتراح النوع'],
    ['هدف الموكل', clean(input.clientGoals, 4000) || 'غير محدد صراحةً'],
    ['مؤشرات المرحلة المستخلصة من النص', proceduralStageClues.length ? proceduralStageClues.join('؛ ') : 'لا توجد إشارة كافية؛ لا تجزم بالمرحلة'],
    ['هل يوجد تحليل سابق', priorAnalysis ? 'نعم؛ يجب مراجعته على ضوء البيانات الحالية' : 'لا'],
    ['هل توجد مسودة سابقة', priorDraft ? 'نعم؛ افحص ما عولج وما بقي' : 'لا'],
    ['هل يوجد مستند مقدم من الخصم', opponent ? 'نعم؛ افصل ادعاءات الخصم عن الوقائع الثابتة' : 'غير وارد في مدخلات المهمة'],
  ];

  const context = [
    '[ملف المعاون القانوني الاستراتيجي — بيانات منظمة من المدخلات الحالية]',
    ...fields.map(([label, value]) => `- ${label}: ${value}`),
    '',
    '[منهج القرار المطلوب]',
    '1. استخرج الوقائع والادعاءات والأدلة من نص المهمة نفسه، وميّز الثابت عن الاستنتاج والاحتمال والنقص.',
    '2. حدد الهدف الإجرائي في المرحلة الحالية، ولا تجزم بالمرحلة من مؤشر منفرد محتمل.',
    '3. عند وجود مستند للخصم، حلل الغرض المحتمل من كل دفع جوهري، وتوقع أقوى رد مضاد على دفاع الموكل؛ وسم التوقع بأنه تقدير لا حقيقة.',
    '4. قارن الجديد بما سبق تقديمه: ما الذي سبق الرد عليه؟ وما الذي استجد؟ وما الذي يستحق ردًا مستقلًا؟',
    '5. قيّم الإجراء الأنسب: مستند جديد كامل، تعقيب محدود، إحالة إلى دفاع سابق، إجراء إثبات، أو عدم تقديم مذكرة جديدة إذا كان ذلك أصلح.',
    '6. لا تغيّر نوع العمل أو الطلبات التي حددها المحامي. اعرض البديل الأفضل كتوصية منفصلة ولا تنفذه دون تفويض.',
    '7. اربط كل توصية بواقعة أو مستند أو نقص محدد، وبيّن أثره ومخاطر البديل.',
    '8. لا تفترض ميعادًا أو إجراءً أو قاعدة قانونية غير متحقق منها، ولا تخترع مستندًا أو دفعًا.',
    '',
    '[ملاحظة تنفيذية] الوقائع والمستندات والتحليل السابق موجودة في متن المهمة؛ استخدم هذه البيانات المنظمة لتوجيه القرار دون إعادة نسخها أو افتراض معلومات غير واردة.',
  ].join('\n').slice(0, 5000);

  return {
    task: input.task,
    declaredWorkType,
    proceduralStageClues,
    hasPriorAnalysis: Boolean(priorAnalysis),
    hasPriorDraft: Boolean(priorDraft),
    hasOpponentSubmission: Boolean(opponent),
    hasExplicitClientGoal: Boolean(clean(input.clientGoals, 4000)),
    context,
  };
}
