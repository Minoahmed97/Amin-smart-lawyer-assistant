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
  circuit?: string;
  opponentName?: string;
  selectedDocumentType?: string;
  proceduralStage?: string;
  proceduralStageSource?: 'lawyer_provided' | 'not_provided';
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

  const explicitProceduralStage = clean(input.proceduralStage, 500);
  const proceduralStageClues = STAGE_CLUES
    .filter(({ pattern }) => pattern.test(combined))
    .map(({ label }) => label);

  const fields = [
    ['نوع المهمة الحالية', input.task],
    ['المحكمة', clean(input.courtType, 300) || 'غير محددة في المدخلات'],
    ['الدائرة', clean(input.circuit, 300) || 'غير محددة في المدخلات'],
    ['الخصم', clean(input.opponentName, 500) || 'غير محدد في المدخلات'],
    ['نوع المستند الذي اختاره المحامي', clean(input.selectedDocumentType, 500) || declaredWorkType || 'لم يحدد صراحةً'],
    ['المرحلة الإجرائية التي قررها المحامي', explicitProceduralStage ? `${explicitProceduralStage} (مصدرها: ${input.proceduralStageSource === 'lawyer_provided' ? 'تحديد المحامي' : 'بيانات الملف'})` : 'غير محددة صراحةً؛ لا تعتبر مؤشرات النص إثباتاً للمرحلة الحالية'],
    ['طبيعة النزاع', clean(input.caseNature, 500) || 'تُستخلص بحذر من الوقائع'],
    ['رقم الدعوى', clean(input.caseNumber, 200) || 'غير وارد'],
    ['تاريخ الجلسة', clean(input.sessionDate, 200) || 'غير وارد'],
    ['صفة الموكل', clean(input.clientRole, 300) || 'غير محددة صراحةً؛ لا تفترضها'],
    ['نوع العمل الذي حدده المحامي', declaredWorkType || 'لم يحدده؛ قيّم الملاءمة قبل اقتراح النوع'],
    ['هدف الموكل', clean(input.clientGoals, 4000) || 'غير محدد صراحةً'],
    ['مؤشرات تاريخية أو نصية قد تتصل بالمرحلة', proceduralStageClues.length ? proceduralStageClues.join('؛ ') : 'لا توجد إشارات كافية'],
    ['هل يوجد تحليل سابق', priorAnalysis ? 'نعم؛ يجب مراجعته على ضوء البيانات الحالية' : 'لا'],
    ['هل توجد مسودة سابقة', priorDraft ? 'نعم؛ افحص ما عولج وما بقي' : 'لا'],
    ['هل يوجد مستند مقدم من الخصم', opponent ? 'نعم؛ افصل ادعاءات الخصم عن الوقائع الثابتة' : 'غير وارد في مدخلات المهمة'],
  ];

  const draftingCore = input.task === 'drafting' || input.task === 'refinement'
    ? [
        '',
        '[ركائز التحليل الاستراتيجي الملزمة للصياغة والمراجعة]',
        '- الفكرة القانونية والتكييف: حدّد التكييف الأرجح الذي تسنده الوقائع والمستندات، وافصل الثابت عن الاستنتاج.',
        '- الدفوع والأسانيد المحورية: رتّب أقوى الدفوع والروابط بين الواقعة والدليل والقاعدة والتطبيق، ولا تضف دفعاً بلا سند.',
        '- المحاذير ونقاط الضعف: حدّد التناقضات والنواقص وأقوى حجة مضادة وما يحتاج إلى تحقق، ولا تعرض الاحتمال كحقيقة.',
        '- الهدف النهائي: استخلصه من هدف الموكل والطلبات الصريحة وتعليمات المحامي؛ الطلبات المحددة لا تُستبدل ولا تُوسّع.',
      ]
    : [];

  const context = [
    '[ملف المعاون القانوني الاستراتيجي — بيانات منظمة من المدخلات الحالية]',
    ...fields.map(([label, value]) => `- ${label}: ${value}`),
    ...draftingCore,
    '',
    '[منهج القرار المطلوب]',
    '1. استخرج الوقائع والادعاءات والأدلة من نص المهمة نفسه، وميّز الثابت عن الاستنتاج والاحتمال والنقص.',
    '2. حدد الهدف الإجرائي في المرحلة الحالية، ولا تجزم بالمرحلة من مؤشر منفرد محتمل.',
    '3. عند وجود مستند للخصم، حلل الغرض المحتمل من كل دفع جوهري، وتوقع أقوى رد مضاد على دفاع الموكل؛ وسم التوقع بأنه تقدير لا حقيقة.',
    '4. قارن الجديد بما سبق تقديمه: ما الذي سبق الرد عليه؟ وما الذي استجد؟ وما الذي يستحق ردًا مستقلًا؟',
    '5. أصدر قراراً عملياً واضحاً، واختر الإجراء من بين: تقديم المستند المحدد، تعقيب محدود، مذكرة تكميلية/ختامية، طلب أو إجراء إثبات، حافظة مستندات، إنذار، طعن، مرافعة شفوية، إحالة إلى دفاع سابق، أو عدم تقديم مذكرة جديدة. لا تختر خياراً لا تسمح به المرحلة أو لا تسنده الأوراق.',
    '6. افصل بين (أ) الإجراء الذي توصي به للمحامي الآن، (ب) نوع المستند الذي طلبه المحامي للتنفيذ. إذا حدد المحامي نوع المستند، لا تغيّره ولا تستبدله؛ اذكر فقط إن كان توقيت تقديمه أو جدواه محل تحفظ، واعرض البديل منفصلاً.',
    '7. إذا لم تثبت المرحلة الإجرائية أو لم تتضح المذكرة السابقة أو تاريخ الجلسة، فلا تجزم بقرار نهائي؛ اذكر المعلومة الناقصة وأثرها، وقدم توصية مشروطة آمنة. لا تستنتج أن مذكرة الخصم الحالية هي آخر إجراء في الدعوى.',
    '8. لا تغيّر نوع العمل أو الطلبات التي حددها المحامي. اعرض البديل الأفضل كتوصية منفصلة ولا تنفذه دون تفويض.',
    '9. اربط كل توصية بواقعة أو مستند أو نقص محدد، وبيّن أثره ومخاطر البديل.',
    '10. لا تفترض ميعادًا أو إجراءً أو قاعدة قانونية غير متحقق منها، ولا تخترع مستندًا أو دفعًا.',
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
