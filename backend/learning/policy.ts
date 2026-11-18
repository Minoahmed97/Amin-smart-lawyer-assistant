import type {
  LearningEventRecord,
  ProfessionalMemoryRecord,
  LearningTaskType,
} from './types.ts';

/**
 * Builds a server-side extraction instruction from an explicitly captured
 * lawyer correction. The returned candidate must remain proposed until the
 * lawyer approves it; this function does not train or update a model.
 */
export function buildLearningExtractionPrompt(event: LearningEventRecord): string {
  const task = String(event.task_type || 'other');
  const beforeText = String(event.before_text || '');
  const afterText = String(event.after_text || '');
  const reason = String(event.reason || '');
  const context = event.context && typeof event.context === 'object'
    ? JSON.stringify(event.context)
    : '{}';

  return [
    'مهمتك استخراج خبرة مهنية قابلة لإعادة الاستخدام من تصحيح المحامي، لا كتابة مذكرة ولا إصدار رأي في القضية.',
    'قارن النص السابق بالنص الذي عدّله المحامي، وحدد فقط ما يمكن إثباته من التعديل وسببه المصرح به.',
    'لا تعتبر كل حذف أو إضافة قاعدة عامة؛ قد يكون التعديل خاصاً بوقائع القضية أو بتصحيح لغوي أو تفضيل عابر.',
    'افصل بين: قاعدة مهنية عامة قابلة للنقل، وقرار خاص بهذه القضية لا يجوز نقله إلى قضية أخرى، وعدم وجود خبرة قابلة للاستخلاص.',
    'احذف أسماء الخصوم وأرقام القضايا والمحاكم والتواريخ والمبالغ والوقائع الخاصة عند صياغة قاعدة عامة.',
    'لا تستخلص أسلوب الصياغة من هذا السجل؛ نماذج المحامي وخزانة الأسلوب مصدر مستقل.',
    'لا تستنتج صحة استراتيجية من نتيجة قضية واحدة، ولا تحول رأياً احتماليّاً إلى قاعدة مؤكدة.',
    'إذا كان سبب التعديل غير واضح، اخفض الثقة أو أعد hasCandidate=false بدلاً من التخمين.',
    'أعد JSON فقط بالحقول: hasCandidate, scope (global أو case أو null), category, title, content, conditions, exceptions, confidence, reasonFromEdit.',
    'القواعد المستخلصة تظل مقترحات غير معتمدة حتى يوافق المحامي عليها صراحة.',
    '',
    'نوع المهمة: ' + task,
    'مرجع القضية الداخلي: ' + String(event.case_ref || 'غير محدد'),
    'سبب التصحيح الذي ذكره المحامي: ' + (reason || 'لم يذكر سبباً صريحاً'),
    'السياق المقدم: ' + context,
    '',
    'النص قبل التصحيح:',
    beforeText,
    '',
    'النص بعد تصحيح المحامي:',
    afterText,
  ].join('\n');
}

/**
 * Only approved memories are eligible for retrieval. Case-scoped memories
 * never cross into another case; global memories are professional preferences,
 * not legal authority, and never override the current file or explicit task.
 */
export function formatApprovedMemoryContext(
  memories: ProfessionalMemoryRecord[],
  options: { caseRef?: string | null; taskType?: LearningTaskType; maxCharacters?: number } = {},
): string {
  const caseRef = String(options.caseRef || '');
  const taskType = options.taskType || 'other';
  const maxCharacters = Math.max(1000, Math.min(30000, options.maxCharacters || 12000));

  const eligible = memories
    .filter((memory) => memory.status === 'approved')
    .filter((memory) => memory.scope === 'global' || (Boolean(caseRef) && memory.case_ref === caseRef))
    .filter((memory) => {
      const taskTypes = Array.isArray(memory.conditions?.taskTypes)
        ? memory.conditions.taskTypes.map(String)
        : [];
      return taskTypes.length === 0 || taskTypes.includes(taskType);
    })
    .sort((a, b) => {
      const scopeA = a.scope === 'case' ? 1 : 0;
      const scopeB = b.scope === 'case' ? 1 : 0;
      if (scopeA !== scopeB) return scopeB - scopeA;
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return (b.times_applied || 0) - (a.times_applied || 0);
    });

  if (!eligible.length) return '';

  const sections: string[] = [
    '[الخبرة المهنية المعتمدة للمحامي]',
    'هذه خبرات عمل وتفضيلات مهنية وليست مصادر قانونية أو وقائع ثابتة.',
    'طبّق ما ينطبق على المهمة الحالية فقط، ولا تجعلها تتغلب على مستندات القضية أو القانون أو تعليمات المحامي.',
    'الخبرة الخاصة بقضية لا تستخدم إلا داخل القضية ذات المرجع المطابق.',
  ];

  let used = sections.join('\n').length;
  for (const memory of eligible) {
    const block = [
      '',
      'نوع الخبرة: ' + memory.category,
      'النطاق: ' + (memory.scope === 'case' ? 'هذه القضية فقط' : 'خبرة مهنية عامة'),
      'العنوان: ' + memory.title,
      'القاعدة أو الخبرة: ' + memory.content,
      'شروط التطبيق: ' + JSON.stringify(memory.conditions || {}),
      'الاستثناءات والحدود: ' + JSON.stringify(memory.exceptions || {}),
      'درجة الثقة المسجلة: ' + String(memory.confidence),
    ].join('\n');

    if (used + block.length > maxCharacters) break;
    sections.push(block);
    used += block.length;
  }

  return sections.join('\n');
}
