import type {
  CaseMemoryInput,
  CaseMemoryRecord,
  LearningEventInput,
  LearningEventRecord,
  LearningEventStatus,
  ProfessionalMemoryInput,
  ProfessionalMemoryRecord,
} from './types.ts';

function getSupabaseConfig() {
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = (
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    ''
  ).trim();

  if (!url || !key) {
    const error: any = new Error('إعدادات التخزين الدائم لذاكرة أمين غير مكتملة على الخادم.');
    error.statusCode = 503;
    throw error;
  }
  return { url, key };
}

function assertUserId(userId: string): string {
  const value = String(userId || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
    const error: any = new Error('معرّف الحساب غير صالح لعمليات ذاكرة أمين.');
    error.statusCode = 400;
    throw error;
  }
  return value;
}

async function supabaseRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { url, key } = getSupabaseConfig();
  const headers: Record<string, string> = {
    apikey: key,
    'Content-Type': 'application/json',
    ...(key.startsWith('sb_') ? {} : { Authorization: 'Bearer ' + key }),
    ...(init.headers as Record<string, string> || {}),
  };

  let response: Response;
  try {
    response = await fetch(url + '/rest/v1/' + path, {
      ...init,
      headers,
      signal: init.signal || AbortSignal.timeout(15000),
    });
  } catch {
    const error: any = new Error('تعذر الاتصال بتخزين ذاكرة أمين.');
    error.statusCode = 503;
    throw error;
  }

  if (!response.ok) {
    const error: any = new Error('تعذر تنفيذ عملية التخزين الدائم لذاكرة أمين (HTTP ' + response.status + ').');
    error.statusCode = response.status >= 500 ? 503 : 400;
    throw error;
  }

  if (response.status === 204) return [] as unknown as T;
  return await response.json() as T;
}

function queryString(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

function requireReturnedRow<T>(rows: unknown, message: string): T {
  if (!Array.isArray(rows) || !rows[0]) {
    const error: any = new Error(message);
    error.statusCode = 404;
    throw error;
  }
  return rows[0] as T;
}

export async function recordLearningEvent(
  userIdInput: string,
  input: LearningEventInput,
): Promise<LearningEventRecord> {
  const userId = assertUserId(userIdInput);
  const payload = {
    user_id: userId,
    case_ref: input.caseRef || null,
    task_type: input.taskType,
    event_type: input.eventType || 'correction',
    status: 'pending_review',
    before_text: input.beforeText || '',
    after_text: input.afterText || '',
    reason: input.reason || '',
    context: input.context || {},
  };

  const rows = await supabaseRequest<LearningEventRecord[]>(
    'amin_learning_events',
    {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(payload),
    },
  );

  return requireReturnedRow<LearningEventRecord>(rows, 'لم يتم حفظ سجل التعلم.');
}

export async function listLearningEvents(
  userIdInput: string,
  status: LearningEventStatus = 'pending_review',
  limit = 30,
): Promise<LearningEventRecord[]> {
  const userId = assertUserId(userIdInput);
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const query = queryString({
    select: '*',
    user_id: 'eq.' + userId,
    status: 'eq.' + status,
    order: 'created_at.desc',
    limit: String(safeLimit),
  });

  return await supabaseRequest<LearningEventRecord[]>('amin_learning_events?' + query);
}

export async function markLearningEventProcessed(
  userIdInput: string,
  eventId: string,
  status: 'processed' | 'ignored',
): Promise<LearningEventRecord> {
  const userId = assertUserId(userIdInput);
  const query = queryString({
    id: 'eq.' + eventId,
    user_id: 'eq.' + userId,
    status: 'eq.pending_review',
    select: '*',
  });
  const rows = await supabaseRequest<LearningEventRecord[]>(
    'amin_learning_events?' + query,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ status, reviewed_at: new Date().toISOString() }),
    },
  );
  return requireReturnedRow<LearningEventRecord>(rows, 'سجل التعلم غير موجود أو سبق مراجعته.');
}

async function assertSourceEventsBelongToUser(userId: string, eventIds: string[]): Promise<void> {
  if (!eventIds.length) return;
  const uniqueIds = [...new Set(eventIds)];
  const query = queryString({
    select: 'id',
    user_id: 'eq.' + userId,
    id: 'in.(' + uniqueIds.join(',') + ')',
  });
  const rows = await supabaseRequest<Array<{ id: string }>>('amin_learning_events?' + query);
  if (!Array.isArray(rows) || rows.length !== uniqueIds.length) {
    const error: any = new Error('بعض سجلات التعلم المرتبطة غير موجودة ضمن حسابك.');
    error.statusCode = 400;
    throw error;
  }
}

export async function createProfessionalMemoryCandidate(
  userIdInput: string,
  input: ProfessionalMemoryInput,
): Promise<ProfessionalMemoryRecord> {
  const userId = assertUserId(userIdInput);
  const sourceEventIds = input.sourceEventIds || [];
  await assertSourceEventsBelongToUser(userId, sourceEventIds);

  const payload = {
    user_id: userId,
    scope: input.scope,
    case_ref: input.scope === 'case' ? input.caseRef : null,
    category: input.category,
    title: input.title,
    content: input.content,
    conditions: input.conditions || {},
    exceptions: input.exceptions || {},
    source_event_ids: [...new Set(sourceEventIds)],
    confidence: Number.isFinite(input.confidence) ? Math.max(0, Math.min(1, Number(input.confidence))) : 0.5,
    status: 'proposed',
  };

  const rows = await supabaseRequest<ProfessionalMemoryRecord[]>(
    'amin_professional_memories',
    {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(payload),
    },
  );

  return requireReturnedRow<ProfessionalMemoryRecord>(rows, 'لم يتم حفظ مقترح الخبرة المهنية.');
}

export async function reviewProfessionalMemory(
  userIdInput: string,
  memoryId: string,
  decision: 'approved' | 'rejected',
): Promise<ProfessionalMemoryRecord> {
  const userId = assertUserId(userIdInput);
  const query = queryString({
    id: 'eq.' + memoryId,
    user_id: 'eq.' + userId,
    status: 'eq.proposed',
    select: '*',
  });
  const rows = await supabaseRequest<ProfessionalMemoryRecord[]>(
    'amin_professional_memories?' + query,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        status: decision,
        reviewed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    },
  );
  return requireReturnedRow<ProfessionalMemoryRecord>(rows, 'مقترح الخبرة غير موجود أو سبق مراجعته.');
}

export async function listProposedProfessionalMemories(
  userIdInput: string,
  limit = 50,
): Promise<ProfessionalMemoryRecord[]> {
  const userId = assertUserId(userIdInput);
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const query = queryString({
    select: '*',
    user_id: 'eq.' + userId,
    status: 'eq.proposed',
    order: 'created_at.desc',
    limit: String(safeLimit),
  });
  return await supabaseRequest<ProfessionalMemoryRecord[]>('amin_professional_memories?' + query);
}

export async function listApprovedProfessionalMemories(
  userIdInput: string,
  limit = 100,
): Promise<ProfessionalMemoryRecord[]> {
  const userId = assertUserId(userIdInput);
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  const query = queryString({
    select: '*',
    user_id: 'eq.' + userId,
    status: 'eq.approved',
    order: 'confidence.desc,updated_at.desc',
    limit: String(safeLimit),
  });
  return await supabaseRequest<ProfessionalMemoryRecord[]>('amin_professional_memories?' + query);
}

export async function saveCaseMemory(
  userIdInput: string,
  input: CaseMemoryInput,
): Promise<CaseMemoryRecord> {
  const userId = assertUserId(userIdInput);
  const query = queryString({ on_conflict: 'user_id,case_ref' });
  const payload = {
    user_id: userId,
    case_ref: input.caseRef,
    title: input.title || '',
    case_state: input.caseState,
    source_metadata: input.sourceMetadata || {},
    updated_at: new Date().toISOString(),
  };
  const rows = await supabaseRequest<CaseMemoryRecord[]>(
    'amin_case_memory?' + query,
    {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(payload),
    },
  );
  return requireReturnedRow<CaseMemoryRecord>(rows, 'لم يتم حفظ سياق القضية.');
}

export async function getCaseMemory(
  userIdInput: string,
  caseRef: string,
): Promise<CaseMemoryRecord | null> {
  const userId = assertUserId(userIdInput);
  const query = queryString({
    select: '*',
    user_id: 'eq.' + userId,
    case_ref: 'eq.' + caseRef,
    limit: '1',
  });
  const rows = await supabaseRequest<CaseMemoryRecord[]>('amin_case_memory?' + query);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}
