import type {
  CaseAnalysisSnapshot,
  StrategicAnalysisInput,
  StrategicAnalysisOutput,
  StrategicStage,
  UnifiedCaseFile,
} from '../../src/strategic/types.ts';
import { executeWithKeyRotation } from '../keyRotation.ts';

const MAX_ANALYSIS_CONTEXT_CHARS = 180_000;
const STRATEGIC_MODEL_TEMPERATURE = 0.15;
const STRATEGIC_OUTPUT_TOKENS = 24_000;

const STAGE_LABELS: Record<StrategicStage, string> = {
  intake: 'فهم القضية وتحديد نطاق النزاع وصفات الأطراف والطلبات',
  evidence_review: 'فحص المستندات والأدلة وربطها بالوقائع والتناقضات والنواقص',
  legal_qualification: 'التكييف القانوني والمسائل القانونية والاختصاص والإجراءات والمواعيد عند توافر بياناتها',
  defense_analysis: 'استخراج الدفوع الجوهرية والمساندة وربط كل دفع بوقائعه وأدلته',
  opponent_analysis: 'بناء أقوى موقف ممكن للخصم واختبار الردود عليه',
  strategy: 'بناء استراتيجية أصلية وبدائلها والمخاطر والخطوات العملية',
  final_review: 'مراجعة التناقضات والافتراضات والنواقص ومنع الجزم بما لا تسنده الأوراق',
};

const SYSTEM_INSTRUCTION = `أنت المحرك التحليلي الاستراتيجي داخل منظومة «أمين» للمحاماة المصرية. دورك تحليل ملف قضية منظم، لا صياغة مذكرة ولا اختراع بيانات. التزم بالقواعد الآتية:
1. اعتبر الوقائع المدخلة من المحامي منفصلة عن المعلومات المستخرجة من المستندات وعن استنتاجاتك. لا تدمج مصادرها ولا تغير مصدر أي معلومة.
2. لا تحول ادعاء أحد الخصوم إلى حقيقة ثابتة لمجرد وروده. ميّز دائماً بين الثابت بالمستند، والقول المنسوب لصاحبه، والاستنتاج المدعوم، والاحتمال، والمعلومة الناقصة.
3. اربط كل نتيجة جوهرية بمعرّف واقعة أو مستند متاح متى أمكن. لا تنشئ معرّفات لمصادر غير موجودة.
4. لا تختلق نصوص مواد أو أرقام قوانين أو أحكام أو طعون أو تواريخ أو وقائع أو مستندات أو سوابق قضائية. إذا لم يتوافر سند قانوني موثوق في المدخلات، صغ المسألة باعتبارها نقطة تحقق ولا تنسب إليها نصاً أو حكماً.
5. لا تفترض صفة الموكل أو طلباته أو المحكمة المختصة أو فوات ميعاد. إذا لم تكف البيانات، اذكر السؤال الناقص وأثره.
6. لا تنشئ دفعاً لمجرد أنه شائع. رتّب الدفوع بحسب أثرها وقوة سندها، واذكر صراحة عند عدم ظهور دفع جوهري إضافي مدعوم.
7. ابنِ أقوى موقف للخصم قبل ترجيح موقف الموكل. اذكر ما قد يضعف استراتيجية الموكل وما يمكن أن يقلب الترجيح.
8. لا تعدّل الوقائع الأصلية ولا تمحو أو تستبدل بيانات المحامي. قدم النتائج والتوصيات كتحليل مستقل قابل لمراجعة المحامي.
9. أخرج JSON صالحاً فقط، بلا Markdown أو أسوار كود أو مقدمة. استخدم المفاتيح المحددة في الطلب ولا تضف مفاتيح خارجها.
10. اللغة العربية القانونية المصرية الواضحة هي لغة جميع النصوص التفسيرية.`;

function uniqueStages(stages: StrategicStage[] | undefined): StrategicStage[] {
  const allowed = Object.keys(STAGE_LABELS) as StrategicStage[];
  const requested = Array.isArray(stages) && stages.length ? stages : allowed;
  return [...new Set(requested)].filter((stage) => allowed.includes(stage));
}

function makePrompt(input: StrategicAnalysisInput, stages: StrategicStage[]): string {
  const caseJson = JSON.stringify(input.caseFile);
  if (caseJson.length > MAX_ANALYSIS_CONTEXT_CHARS) {
    throw new Error('ملف القضية أكبر من سعة التحليل الواحد. قلّل النصوص المكررة أو حلّل المستندات على مراحل مع الاحتفاظ بروابطها في ملف القضية.');
  }

  const stageInstructions = stages
    .map((stage, index) => `${index + 1}. ${stage}: ${STAGE_LABELS[stage]}`)
    .join('\n');

  return `حلّل ملف القضية التالي وفق المراحل المطلوبة، مع الالتزام الكامل بتعليمات النظام.

المراحل المطلوبة:
${stageInstructions}

تعليمات إضافية من المحامي:
${input.additionalInstructions?.trim() || 'لا توجد تعليمات إضافية.'}

نتائج تحليل سابقة متاحة للمقارنة (لا تعتبرها حقائق غير قابلة للمراجعة):
${JSON.stringify(input.priorAnalysis || [])}

ملف القضية الموحد:
${caseJson}

أعد كائن JSON بهذه البنية فقط:
{
  "caseId": "معرّف القضية كما ورد حرفياً",
  "completedStages": ["أسماء المراحل التي أنجزتها من القائمة المطلوبة"],
  "stageResults": {
    "اسم_المرحلة": {
      "summary": "خلاصة مركزة",
      "findings": ["نتيجة مع بيان مصدرها أو معرّفها عند الإمكان"],
      "unresolvedQuestions": ["سؤال أو معلومة لازمة لم تحسمها البيانات"],
      "contradictions": ["تعارض محدد مع تحديد عناصره"],
      "missingEvidence": ["دليل أو مستند يلزم للتحقق دون افتراض أنه غير موجود"]
    }
  },
  "strategy": {
    "objective": "الهدف الإجرائي أو الموضوعي المستخلص من طلبات المحامي",
    "primaryApproach": "المسار الرئيسي وأسباب ترجيحه",
    "alternativeApproaches": ["بدائل مشروطة بوقائع أو مستندات محددة"],
    "primaryDefenseIds": ["معرّفات دفوع موجودة فقط في الملف، أو مصفوفة فارغة"],
    "alternativeDefenseIds": ["معرّفات دفوع موجودة فقط في الملف، أو مصفوفة فارغة"],
    "opponentArguments": ["أقوى حجج الخصم المحتملة مع بيان أساسها"],
    "rebuttalPoints": ["ردود مرتبطة بوقائع أو أدلة محددة"],
    "evidenceGaps": ["الفجوات الإثباتية"],
    "proceduralSteps": [],
    "risks": [],
    "priorities": ["أولويات مرتبة"]
  },
  "warnings": ["تحفظات وحدود التحليل"],
  "requiresAttorneyReview": true
}

قواعد إخراج مهمة:
- لا تضع إلا نتائج المراحل المطلوبة في stageResults.
- لا تنشئ معرّفات دفوع أو وقائع أو مستندات. استخدم المعرّفات الموجودة فقط.
- إذا تعذر الجزم، اكتب ذلك في unresolvedQuestions أو warnings ولا تخترع إجابة.
- لا تملأ proceduralSteps أو risks بكائنات ناقصة؛ استخدم مصفوفة فارغة إذا لم تتوافر بيانات منظمة كافية.
- لا تضع نصوصاً قانونية أو أرقام أحكام أو مواد إلا إذا وردت في بيانات القضية ويمكن التحقق منها داخلها.
- اجعل requiresAttorneyReview = true دائماً؛ فالنتيجة مسودة تحليلية لا تعتمد دون مراجعة المحامي.`;
}

function extractText(response: any): string {
  if (typeof response?.text === 'string') return response.text.trim();
  const parts = response?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) return parts.map((part: any) => String(part?.text || '')).join('').trim();
  return '';
}

function stripJsonFence(value: string): string {
  return value.trim()
    .replace(/^\uFEFF/, '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

function parseModelJson(raw: string): any {
  const clean = stripJsonFence(raw);
  try { return JSON.parse(clean); } catch {}
  const first = clean.indexOf('{');
  const last = clean.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(clean.slice(first, last + 1)); } catch {}
  }
  throw new Error('لم يُرجع النموذج نتيجة تحليل منظمة صالحة. لم يتم حفظ أي تعديل على ملف القضية.');
}

function normalizeSnapshot(
  caseId: string,
  stage: StrategicStage,
  raw: any,
  inputFingerprint: string,
): CaseAnalysisSnapshot {
  const safeArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : [];
  return {
    id: `analysis_${stage}_${Date.now().toString(36)}`,
    version: 1,
    stage,
    summary: typeof raw?.summary === 'string' ? raw.summary.trim() : '',
    findings: safeArray(raw?.findings),
    unresolvedQuestions: safeArray(raw?.unresolvedQuestions),
    contradictions: safeArray(raw?.contradictions),
    missingEvidence: safeArray(raw?.missingEvidence),
    createdAt: new Date().toISOString(),
    modelId: 'gemini',
    inputFingerprint,
  };
}

function stableFingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export async function runStrategicAnalysis(input: StrategicAnalysisInput): Promise<StrategicAnalysisOutput> {
  if (!input?.caseFile?.id || input.caseFile.schemaVersion !== 1) {
    throw new Error('ملف القضية غير صالح للتحليل الاستراتيجي.');
  }

  const stages = uniqueStages(input.requestedStages);
  if (!stages.length) throw new Error('لم يتم تحديد مرحلة تحليل صالحة.');

  const prompt = makePrompt(input, stages);
  const response = await executeWithKeyRotation(
    async (ai, _key, model) => ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        temperature: STRATEGIC_MODEL_TEMPERATURE,
        maxOutputTokens: STRATEGIC_OUTPUT_TOKENS,
        responseMimeType: 'application/json',
      },
    }),
    undefined,
    undefined,
    true,
  );

  const rawText = extractText(response);
  if (!rawText) throw new Error('لم يصل نص من Gemini للتحليل الاستراتيجي.');
  const parsed = parseModelJson(rawText);
  if (parsed?.caseId !== input.caseFile.id) {
    throw new Error('معرّف القضية في استجابة التحليل لا يطابق الملف المطلوب. لم يتم اعتماد النتيجة.');
  }

  const fingerprint = stableFingerprint(prompt);
  const stageResults: Partial<Record<StrategicStage, CaseAnalysisSnapshot>> = {};
  for (const stage of stages) {
    const stageRaw = parsed?.stageResults?.[stage];
    if (!stageRaw || typeof stageRaw !== 'object') continue;
    stageResults[stage] = normalizeSnapshot(input.caseFile.id, stage, stageRaw, fingerprint);
  }

  const completedStages = stages.filter((stage) => Boolean(stageResults[stage]));
  if (!completedStages.length) {
    throw new Error('لم ينتج Gemini أي مرحلة تحليل مكتملة بالبنية المطلوبة. لم يتم حفظ أي تعديل على ملف القضية.');
  }

  const allowedDefenseIds = new Set(input.caseFile.defenses.map((defense) => defense.id));
  const safeIds = (value: unknown) => Array.isArray(value)
    ? value.filter((id): id is string => typeof id === 'string' && allowedDefenseIds.has(id))
    : [];

  const strategy = parsed?.strategy && typeof parsed.strategy === 'object'
    ? {
        objective: String(parsed.strategy.objective || ''),
        primaryApproach: String(parsed.strategy.primaryApproach || ''),
        alternativeApproaches: Array.isArray(parsed.strategy.alternativeApproaches)
          ? parsed.strategy.alternativeApproaches.filter((item: unknown) => typeof item === 'string')
          : [],
        primaryDefenseIds: safeIds(parsed.strategy.primaryDefenseIds),
        alternativeDefenseIds: safeIds(parsed.strategy.alternativeDefenseIds),
        opponentArguments: Array.isArray(parsed.strategy.opponentArguments)
          ? parsed.strategy.opponentArguments.filter((item: unknown) => typeof item === 'string')
          : [],
        rebuttalPoints: Array.isArray(parsed.strategy.rebuttalPoints)
          ? parsed.strategy.rebuttalPoints.filter((item: unknown) => typeof item === 'string')
          : [],
        evidenceGaps: Array.isArray(parsed.strategy.evidenceGaps)
          ? parsed.strategy.evidenceGaps.filter((item: unknown) => typeof item === 'string')
          : [],
        proceduralSteps: [],
        risks: [],
        priorities: Array.isArray(parsed.strategy.priorities)
          ? parsed.strategy.priorities.filter((item: unknown) => typeof item === 'string')
          : [],
        reviewedAt: new Date().toISOString(),
      }
    : undefined;

  const warnings = Array.isArray(parsed?.warnings)
    ? parsed.warnings.filter((item: unknown) => typeof item === 'string')
    : [];

  return {
    caseId: input.caseFile.id,
    completedStages,
    stageResults,
    updatedFacts: [],
    updatedIssues: [],
    updatedDefenses: [],
    ...(strategy ? { strategy } : {}),
    memoryEntries: [],
    warnings: [...warnings, 'نتيجة تحليل آلي تحتاج مراجعة المحامي قبل الاعتماد أو اتخاذ إجراء.'],
    requiresAttorneyReview: true,
  };
}
