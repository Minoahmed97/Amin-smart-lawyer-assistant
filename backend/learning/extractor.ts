import { executeWithKeyRotation } from '../keyRotation.ts';
import { buildLearningExtractionPrompt } from './policy.ts';
import {
  createProfessionalMemoryCandidate,
  getLearningEvent,
  markLearningEventProcessed,
} from './store.ts';
import type { LearningEventRecord, MemoryCategory } from './types.ts';

const ALLOWED_CATEGORIES: MemoryCategory[] = [
  'decision_rule',
  'strategy_rule',
  'risk_preference',
  'workflow_rule',
  'correction_pattern',
];

function extractJson(value: unknown): Record<string, any> {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('لم ينتج النموذج بيانات لاستخلاص الخبرة.');
  const cleaned = raw
    .replace(/^\uFEFF/, '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}

  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const parsed = JSON.parse(cleaned.slice(first, last + 1));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  }

  throw new Error('تعذر قراءة نتيجة استخلاص الخبرة بصيغة JSON.');
}

function boundedText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function boundedRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const serialized = JSON.stringify(value);
  if (serialized.length > 8000) return {};
  return value as Record<string, unknown>;
}

export async function extractLearningFromEvent(
  userId: string,
  eventId: string,
): Promise<{ hasCandidate: boolean; reason: string; memory?: unknown; event: LearningEventRecord }> {
  const event = await getLearningEvent(userId, eventId);
  if (!event) {
    const error: any = new Error('سجل التصحيح غير موجود ضمن حسابك.');
    error.statusCode = 404;
    throw error;
  }
  if (event.status !== 'pending_review') {
    const error: any = new Error('سجل التصحيح سبق التعامل معه ولا يمكن استخلاصه مرة أخرى.');
    error.statusCode = 409;
    throw error;
  }
  if (!event.before_text.trim() || !event.after_text.trim()) {
    const error: any = new Error('سجل التصحيح لا يحتوي النصين اللازمين للمقارنة.');
    error.statusCode = 400;
    throw error;
  }

  const prompt = buildLearningExtractionPrompt(event);
  const extracted = await executeWithKeyRotation(async (ai, _key, model) => {
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        temperature: 0.1,
        maxOutputTokens: 1400,
      },
    });
    return extractJson(response?.text);
  });

  const hasCandidate = extracted.hasCandidate === true;
  const reason = boundedText(extracted.reasonFromEdit || extracted.reason, 1200);

  if (!hasCandidate) {
    const updatedEvent = await markLearningEventProcessed(userId, eventId, 'processed');
    return {
      hasCandidate: false,
      reason: reason || 'لم يظهر من التصحيح نمط مهني قابل لإعادة الاستخدام.',
      event: updatedEvent,
    };
  }

  const scope = extracted.scope === 'case' ? 'case' : extracted.scope === 'global' ? 'global' : null;
  const category = String(extracted.category || '') as MemoryCategory;
  const title = boundedText(extracted.title, 240);
  const memoryContent = boundedText(extracted.content, 8000);

  if (!scope || !ALLOWED_CATEGORIES.includes(category) || !title || !memoryContent) {
    const error: any = new Error('نتيجة استخلاص الخبرة غير مكتملة؛ لم يتم حفظ أي مقترح.');
    error.statusCode = 422;
    throw error;
  }
  if (scope === 'case' && !event.case_ref) {
    const error: any = new Error('صُنّف التصحيح كخبرة خاصة بقضية، لكن سجل التصحيح لا يحتوي مرجع قضية.');
    error.statusCode = 422;
    throw error;
  }

  const confidenceValue = Number(extracted.confidence);
  const confidence = Number.isFinite(confidenceValue)
    ? Math.max(0, Math.min(1, confidenceValue))
    : 0.35;

  const memory = await createProfessionalMemoryCandidate(userId, {
    scope,
    caseRef: scope === 'case' ? event.case_ref : null,
    category,
    title,
    content: memoryContent,
    conditions: boundedRecord(extracted.conditions),
    exceptions: boundedRecord(extracted.exceptions),
    sourceEventIds: [event.id],
    confidence,
  });

  const updatedEvent = await markLearningEventProcessed(userId, eventId, 'processed');
  return { hasCandidate: true, reason, memory, event: updatedEvent };
}
