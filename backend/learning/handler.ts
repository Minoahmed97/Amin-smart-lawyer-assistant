import { requireActiveSession } from '../auth.ts';
import { limitBodyString, rateLimit, requirePostJson } from '../security.ts';
import {
  createProfessionalMemoryCandidate,
  getCaseMemory,
  listApprovedProfessionalMemories,
  listLearningEvents,
  markLearningEventProcessed,
  recordLearningEvent,
  reviewProfessionalMemory,
  saveCaseMemory,
} from './store.ts';
import { formatApprovedMemoryContext } from './policy.ts';
import {
  LEARNING_MEMORY_CATEGORIES,
  LEARNING_TASK_TYPES,
  type LearningEventInput,
  type LearningTaskType,
  type MemoryCategory,
} from './types.ts';

function parseBody(req: any): Record<string, any> {
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      const error: any = new Error('بيانات الطلب ليست بصيغة JSON صحيحة.');
      error.statusCode = 400;
      throw error;
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const error: any = new Error('بيانات الطلب غير صالحة.');
    error.statusCode = 400;
    throw error;
  }
  return body;
}

function requireText(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    const error: any = new Error('حقل ' + field + ' مطلوب.');
    error.statusCode = 400;
    throw error;
  }
  limitBodyString(value, max, field);
  return value.trim();
}

function optionalText(value: unknown, max: number, field: string): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') {
    const error: any = new Error('حقل ' + field + ' غير صالح.');
    error.statusCode = 400;
    throw error;
  }
  limitBodyString(value, max, field);
  return value.trim();
}

function requireRecord(value: unknown, maxCharacters: number, field: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    const error: any = new Error('حقل ' + field + ' يجب أن يكون كائن بيانات.');
    error.statusCode = 400;
    throw error;
  }
  const serialized = JSON.stringify(value);
  limitBodyString(serialized, maxCharacters, field);
  return value as Record<string, unknown>;
}

function validateCaseRef(value: unknown, required = false): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) {
      const error: any = new Error('مرجع القضية الداخلي مطلوب.');
      error.statusCode = 400;
      throw error;
    }
    return null;
  }
  const caseRef = requireText(value, 160, 'مرجع القضية');
  if (/[\r\n]/.test(caseRef)) {
    const error: any = new Error('مرجع القضية غير صالح.');
    error.statusCode = 400;
    throw error;
  }
  return caseRef;
}

function validateMemoryId(value: unknown): string {
  const id = requireText(value, 64, 'معرّف الخبرة');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    const error: any = new Error('معرّف الخبرة غير صالح.');
    error.statusCode = 400;
    throw error;
  }
  return id;
}

export default async function handler(req: any, res: any) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    requirePostJson(req);
    const { session } = await requireActiveSession(req);
    rateLimit(req, 'amin-learning-memory', 60, 10 * 60 * 1000, { identity: session.userId });

    const body = parseBody(req);
    const action = String(body.action || '');

    if (action === 'record-correction') {
      const taskType = String(body.taskType || 'other') as LearningTaskType;
      if (!LEARNING_TASK_TYPES.includes(taskType)) {
        return res.status(400).json({ error: 'نوع المهمة غير صالح.' });
      }

      const input: LearningEventInput = {
        caseRef: validateCaseRef(body.caseRef),
        taskType,
        eventType: 'correction',
        beforeText: requireText(body.beforeText, 150000, 'النص قبل التصحيح'),
        afterText: requireText(body.afterText, 150000, 'النص بعد التصحيح'),
        reason: optionalText(body.reason, 8000, 'سبب التصحيح'),
        context: requireRecord(body.context, 16000, 'سياق التصحيح'),
      };
      const event = await recordLearningEvent(session.userId, input);
      return res.status(201).json({ ok: true, event });
    }

    if (action === 'create-memory-candidate') {
      const scope = body.scope === 'case' ? 'case' : body.scope === 'global' ? 'global' : '';
      if (!scope) return res.status(400).json({ error: 'نطاق الخبرة غير صالح.' });

      const category = String(body.category || '') as MemoryCategory;
      if (!LEARNING_MEMORY_CATEGORIES.includes(category)) {
        return res.status(400).json({ error: 'تصنيف الخبرة غير صالح.' });
      }

      const caseRef = validateCaseRef(body.caseRef, scope === 'case');
      const sourceEventIds = Array.isArray(body.sourceEventIds)
        ? body.sourceEventIds.slice(0, 20).map((id: unknown) => validateMemoryId(id))
        : [];

      const memory = await createProfessionalMemoryCandidate(session.userId, {
        scope,
        caseRef,
        category,
        title: requireText(body.title, 240, 'عنوان الخبرة'),
        content: requireText(body.content, 8000, 'محتوى الخبرة'),
        conditions: requireRecord(body.conditions, 8000, 'شروط التطبيق'),
        exceptions: requireRecord(body.exceptions, 8000, 'الاستثناءات'),
        sourceEventIds,
        confidence: Number.isFinite(Number(body.confidence)) ? Number(body.confidence) : 0.5,
      });
      return res.status(201).json({ ok: true, memory });
    }

    if (action === 'review-memory') {
      const decision = body.decision === 'approved' ? 'approved' : body.decision === 'rejected' ? 'rejected' : '';
      if (!decision) return res.status(400).json({ error: 'قرار مراجعة الخبرة غير صالح.' });
      const memory = await reviewProfessionalMemory(session.userId, validateMemoryId(body.memoryId), decision);
      return res.status(200).json({ ok: true, memory });
    }

    if (action === 'review-event') {
      const decision = body.decision === 'processed' ? 'processed' : body.decision === 'ignored' ? 'ignored' : '';
      if (!decision) return res.status(400).json({ error: 'قرار مراجعة سجل التعلم غير صالح.' });
      const event = await markLearningEventProcessed(session.userId, validateMemoryId(body.eventId), decision);
      return res.status(200).json({ ok: true, event });
    }

    if (action === 'save-case-context') {
      const caseRef = validateCaseRef(body.caseRef, true) as string;
      const caseState = requireRecord(body.caseState, 40000, 'ملف القضية');
      const sourceMetadata = requireRecord(body.sourceMetadata, 8000, 'بيانات مصادر القضية');
      const record = await saveCaseMemory(session.userId, {
        caseRef,
        title: optionalText(body.title, 240, 'عنوان القضية'),
        caseState,
        sourceMetadata,
      });
      return res.status(200).json({ ok: true, caseMemory: record });
    }

    if (action === 'get-learning-context') {
      const caseRef = validateCaseRef(body.caseRef);
      const taskType = body.taskType ? String(body.taskType) as LearningTaskType : 'other';
      if (!LEARNING_TASK_TYPES.includes(taskType)) {
        return res.status(400).json({ error: 'نوع المهمة غير صالح.' });
      }

      const [caseMemory, memories] = await Promise.all([
        caseRef ? getCaseMemory(session.userId, caseRef) : Promise.resolve(null),
        listApprovedProfessionalMemories(session.userId, 120),
      ]);
      const applicableMemories = memories.filter((memory) =>
        memory.scope === 'global' || (Boolean(caseRef) && memory.case_ref === caseRef)
      );
      const memoryContext = formatApprovedMemoryContext(applicableMemories, { caseRef, taskType });
      return res.status(200).json({
        ok: true,
        caseMemory,
        memories: applicableMemories,
        memoryContext,
      });
    }

    if (action === 'list-review-queue') {
      const [events, memories] = await Promise.all([
        listLearningEvents(session.userId, 'pending_review', 50),
        listApprovedProfessionalMemories(session.userId, 1),
      ]);
      return res.status(200).json({ ok: true, events, approvedMemoryCount: memories.length });
    }

    return res.status(400).json({ error: 'إجراء ذاكرة أمين غير معروف.' });
  } catch (error: any) {
    const statusCode = Number(error?.statusCode) || 500;
    if (statusCode >= 500) {
      console.error('Amin learning request failed; status=' + statusCode);
    }
    return res.status(statusCode).json({
      error: statusCode < 500
        ? (error?.message || 'بيانات الطلب غير صالحة.')
        : 'تعذر تنفيذ عملية ذاكرة أمين حالياً.',
    });
  }
}
