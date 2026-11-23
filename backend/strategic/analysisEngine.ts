import crypto from 'node:crypto';
import type {
  CaseAnalysisSnapshot,
  CaseRecommendation,
  CaseRisk,
  StrategicAnalysisInput,
  StrategicAnalysisOutput,
  StrategicStage,
  OpponentIntentHypothesis,
  OpponentNextMove,
  StrategicTimingRecommendation,
  CourtScenario,
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
8. نفّذ تحليلاً خصومياً منضبطاً: استخرج فرضيات النوايا أو الأهداف المحتملة للخصم من قرائن محددة في الأوراق، واذكر لكل فرضية القرائن ودرجة الثقة وتفسيراً بديلاً. لا تدّعِ معرفة النوايا الباطنة ولا تحول الاحتمال إلى حقيقة.
9. حاكِ الخطوات التالية المحتملة للخصم: ما الحركة المتوقعة، وما الذي قد يدفعه إليها، وما مؤشر ظهورها، وكيف يستعد المحامي لها.
10. اختبر استراتيجية الموكل كما لو كنت محامي الخصم: ابنِ أقوى اعتراض مضاد، وحدد الثغرة التي قد يكشفها، ثم اقترح معالجة واقعية أو اذكر أنه لا توجد معالجة مؤكدة.
11. حلّل توقيت الإجراء: متى يقدم المحامي الدفع أو المستند أو الطلب، وما مخاطر التعجيل وما مخاطر التأخير، مع مراعاة المواعيد القانونية وعدم اقتراح تفويت ميعاد.
12. حاكِ السيناريوهات القضائية المحتملة دون ادعاء التنبؤ بحكم المحكمة: ما المسألة التي قد تركز عليها المحكمة، وما الأثر المحتمل، وكيف يستعد المحامي.
8. لا تعدّل الوقائع الأصلية ولا تمحو أو تستبدل بيانات المحامي. قدم النتائج والتوصيات كتحليل مستقل قابل لمراجعة المحامي.
9. أخرج JSON صالحاً فقط، بلا Markdown أو أسوار كود أو مقدمة. استخدم المفاتيح المحددة في الطلب ولا تضف مفاتيح خارجها.
13. اللغة العربية القانونية المصرية الواضحة هي لغة جميع النصوص التفسيرية.`;

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

بروتوكول التفكير الاستراتيجي الإلزامي — نفّذ المراحل التالية بالترتيب قبل كتابة النتيجة:
أ) كوّن صورة محايدة للقضية وحدد ما هو ثابت وما هو ادعاء وما هو استنتاج وما هو مجهول.
ب) ارتدِ منظور الخصم: ابنِ أقوى رواية دفاعية ممكنة له، وحدد مصلحته الإجرائية أو الموضوعية المحتملة والقرائن التي تدعم كل فرضية، مع تفسير بديل ودرجة ثقة.
ج) اختبر موقف الموكل اختباراً مضاداً: ما أقوى نقطة يمكن أن يهدم بها الخصم حجته؟ وما المستند أو الواقعة التي لو ثبتت ستغير النتيجة؟
د) توقّع تحركات الخصم التالية والظروف التي قد تدفعه إليها، ولا تعرض توقعاً بلا مؤشر من الملف.
هـ) قارن توقيتات التحرك: الآن، لاحقاً عند تحقق شرط، أو عدم التحرك؛ لا تقترح تأخيراً يهدد ميعاداً أو حقاً.
و) حاكِ أكثر من مسار قضائي معقول، وبيّن ما الذي ينبغي إعداده لكل مسار دون الجزم بما ستقضي به المحكمة.
ز) أصدر توصية واحدة بالخطوة التالية الأفضل، مع سببها ودرجة الاستعجال وما يجب التحقق منه قبل تنفيذها.

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
    "opponentIntentHypotheses": [{"hypothesis":"الهدف المحتمل للخصم","indicators":["قرينة محددة من الملف"],"confidence":"undetermined","alternativeExplanation":"تفسير بديل غير اتهامي"}],
    "opponentNextMoves": [{"move":"الخطوة المحتملة التالية","trigger":"المؤشر أو الظرف الذي قد يدفع إليها","likelihood":"undetermined","preparation":"استعداد المحامي"}],
    "rebuttalPoints": ["ردود مرتبطة بوقائع أو أدلة محددة"],
    "timingRecommendations": [{"action":"الإجراء","timing":"التوقيت أو الشرط المحدد","reason":"سبب التوقيت","riskOfActingEarly":"مخاطر التعجيل","riskOfDelay":"مخاطر التأخير"}],
    "courtScenarios": [{"scenario":"سيناريو إجرائي أو موضوعي محتمل","likelyConcern":"المسألة التي قد تركز عليها المحكمة","possibleEffect":"الأثر المحتمل دون جزم","preparation":"استعداد المحامي"}],
    "strategicBlindSpots": ["نقطة ضعف أو افتراض لم يختبره المحامي"],
    "avoidActions": ["تصرف ينبغي تجنبه وسبب ذلك"],
    "nextBestAction": "الخطوة التالية الأفضل وسبب اختيارها",
    "evidenceGaps": ["الفجوات الإثباتية"],
    "proceduralSteps": [{"action":"إجراء عملي محدد","reason":"سبب الإجراء","priority":1,"relatedFactIds":[],"relatedDocumentIds":[]}],
    "risks": [{"description":"خطر محدد","likelihood":"undetermined","impact":"undetermined","mitigation":"طريقة التعامل معه","requiresVerification":true}],
    "priorities": ["أولويات مرتبة"]
  },
  "warnings": ["تحفظات وحدود التحليل"],
  "requiresAttorneyReview": true
}

قواعد إخراج مهمة:
- لا تضع إلا نتائج المراحل المطلوبة في stageResults.
- لا تنشئ معرّفات دفوع أو وقائع أو مستندات. استخدم المعرّفات الموجودة فقط.
- إذا تعذر الجزم، اكتب ذلك في unresolvedQuestions أو warnings ولا تخترع إجابة.
- أدرج في proceduralSteps إجراءات عملية مدعومة فقط، واربطها بمعرّفات الوقائع والمستندات الموجودة. أدرج في risks المخاطر الواقعية أو الإجرائية المحددة، ولا تنشئ خطراً افتراضياً لمجرد ملء القائمة. استخدم مصفوفة فارغة عند عدم وجود عناصر مدعومة.
- لا تضع نصوصاً قانونية أو أرقام أحكام أو مواد إلا إذا وردت في بيانات القضية ويمكن التحقق منها داخلها.
- لا تملأ حقول النوايا أو التوقعات أو السيناريوهات بعبارات عامة. إذا لم توجد قرائن كافية، أخرج مصفوفة فارغة أو درجة ثقة undetermined وصرّح بعدم كفاية البيانات.
- فرّق بين توقيت إجراء تقديري وبين ميعاد قانوني؛ لا تقترح تفويت أو تأخير ميعاد واجب.
- يجب أن تشرح nextBestAction إجراءً واحداً قابلاً للتنفيذ أو تذكر أن البيانات لا تسمح بتوصية آمنة.
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
  version: number,
): CaseAnalysisSnapshot {
  const safeArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : [];
  return {
    id: crypto.randomUUID(),
    version,
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
    const previousVersions = (input.priorAnalysis || [])
      .filter((snapshot) => snapshot.stage === stage)
      .map((snapshot) => Number(snapshot.version) || 0);
    const nextVersion = (previousVersions.length ? Math.max(...previousVersions) : 0) + 1;
    stageResults[stage] = normalizeSnapshot(input.caseFile.id, stage, stageRaw, fingerprint, nextVersion);
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
        opponentIntentHypotheses: (Array.isArray(parsed.strategy.opponentIntentHypotheses) ? parsed.strategy.opponentIntentHypotheses : [])
          .filter((item: any) => item && typeof item.hypothesis === 'string' && item.hypothesis.trim())
          .map((item: any): OpponentIntentHypothesis => ({
            hypothesis: item.hypothesis.trim(),
            indicators: Array.isArray(item.indicators) ? item.indicators.filter((value: unknown) => typeof value === 'string') : [],
            confidence: ['high', 'medium', 'low', 'undetermined'].includes(item.confidence) ? item.confidence : 'undetermined',
            alternativeExplanation: typeof item.alternativeExplanation === 'string' ? item.alternativeExplanation.trim() : '',
          })),
        opponentNextMoves: (Array.isArray(parsed.strategy.opponentNextMoves) ? parsed.strategy.opponentNextMoves : [])
          .filter((item: any) => item && typeof item.move === 'string' && item.move.trim())
          .map((item: any): OpponentNextMove => ({
            move: item.move.trim(),
            trigger: typeof item.trigger === 'string' ? item.trigger.trim() : '',
            likelihood: ['high', 'medium', 'low', 'undetermined'].includes(item.likelihood) ? item.likelihood : 'undetermined',
            preparation: typeof item.preparation === 'string' ? item.preparation.trim() : '',
          })),
        timingRecommendations: (Array.isArray(parsed.strategy.timingRecommendations) ? parsed.strategy.timingRecommendations : [])
          .filter((item: any) => item && typeof item.action === 'string' && item.action.trim())
          .map((item: any): StrategicTimingRecommendation => ({
            action: item.action.trim(),
            timing: typeof item.timing === 'string' ? item.timing.trim() : '',
            reason: typeof item.reason === 'string' ? item.reason.trim() : '',
            riskOfActingEarly: typeof item.riskOfActingEarly === 'string' ? item.riskOfActingEarly.trim() : '',
            riskOfDelay: typeof item.riskOfDelay === 'string' ? item.riskOfDelay.trim() : '',
          })),
        courtScenarios: (Array.isArray(parsed.strategy.courtScenarios) ? parsed.strategy.courtScenarios : [])
          .filter((item: any) => item && typeof item.scenario === 'string' && item.scenario.trim())
          .map((item: any): CourtScenario => ({
            scenario: item.scenario.trim(),
            likelyConcern: typeof item.likelyConcern === 'string' ? item.likelyConcern.trim() : '',
            possibleEffect: typeof item.possibleEffect === 'string' ? item.possibleEffect.trim() : '',
            preparation: typeof item.preparation === 'string' ? item.preparation.trim() : '',
          })),
        strategicBlindSpots: Array.isArray(parsed.strategy.strategicBlindSpots) ? parsed.strategy.strategicBlindSpots.filter((item: unknown) => typeof item === 'string') : [],
        avoidActions: Array.isArray(parsed.strategy.avoidActions) ? parsed.strategy.avoidActions.filter((item: unknown) => typeof item === 'string') : [],
        nextBestAction: typeof parsed.strategy.nextBestAction === 'string' ? parsed.strategy.nextBestAction.trim() : '',
        rebuttalPoints: Array.isArray(parsed.strategy.rebuttalPoints)
          ? parsed.strategy.rebuttalPoints.filter((item: unknown) => typeof item === 'string')
          : [],
        evidenceGaps: Array.isArray(parsed.strategy.evidenceGaps)
          ? parsed.strategy.evidenceGaps.filter((item: unknown) => typeof item === 'string')
          : [],
        proceduralSteps: (Array.isArray(parsed.strategy.proceduralSteps) ? parsed.strategy.proceduralSteps : [])
          .filter((item: any) => item && typeof item.action === 'string' && item.action.trim())
          .map((item: any): CaseRecommendation => ({
            id: crypto.randomUUID(),
            action: item.action.trim(),
            reason: typeof item.reason === 'string' ? item.reason.trim() : '',
            priority: Math.max(1, Math.min(5, Math.floor(Number(item.priority) || 3))),
            relatedFactIds: Array.isArray(item.relatedFactIds)
              ? item.relatedFactIds.filter((id: unknown) => typeof id === 'string' && input.caseFile.originalFacts.some((fact) => fact.id === id))
              : [],
            relatedDocumentIds: Array.isArray(item.relatedDocumentIds)
              ? item.relatedDocumentIds.filter((id: unknown) => typeof id === 'string' && input.caseFile.documents.some((document) => document.id === id))
              : [],
            status: 'proposed',
          })),
        risks: (Array.isArray(parsed.strategy.risks) ? parsed.strategy.risks : [])
          .filter((item: any) => item && typeof item.description === 'string' && item.description.trim())
          .map((item: any): CaseRisk => ({
            id: crypto.randomUUID(),
            description: item.description.trim(),
            likelihood: ['high', 'medium', 'low', 'undetermined'].includes(item.likelihood) ? item.likelihood : 'undetermined',
            impact: ['high', 'medium', 'low', 'undetermined'].includes(item.impact) ? item.impact : 'undetermined',
            mitigation: typeof item.mitigation === 'string' ? item.mitigation.trim() : '',
            requiresVerification: item.requiresVerification !== false,
          })),
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
