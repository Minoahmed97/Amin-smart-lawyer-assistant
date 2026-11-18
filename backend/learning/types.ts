export type LearningTaskType = 'deconstruct' | 'qualify' | 'draft' | 'chat' | 'other';
export type LearningEventType = 'correction' | 'manual_note' | 'outcome';
export type LearningEventStatus = 'pending_review' | 'processed' | 'ignored';
export type MemoryScope = 'global' | 'case';
export type MemoryCategory = 'decision_rule' | 'strategy_rule' | 'risk_preference' | 'workflow_rule' | 'correction_pattern';
export type MemoryStatus = 'proposed' | 'approved' | 'rejected' | 'archived';

export interface LearningEventInput {
  caseRef?: string | null;
  taskType: LearningTaskType;
  eventType?: LearningEventType;
  beforeText?: string;
  afterText?: string;
  reason?: string;
  context?: Record<string, unknown>;
}

export interface LearningEventRecord extends LearningEventInput {
  id: string;
  user_id: string;
  event_type: LearningEventType;
  status: LearningEventStatus;
  created_at: string;
  reviewed_at?: string | null;
}

export interface ProfessionalMemoryInput {
  scope: MemoryScope;
  caseRef?: string | null;
  category: MemoryCategory;
  title: string;
  content: string;
  conditions?: Record<string, unknown>;
  exceptions?: Record<string, unknown>;
  sourceEventIds?: string[];
  confidence?: number;
}

export interface ProfessionalMemoryRecord {
  id: string;
  user_id: string;
  scope: MemoryScope;
  case_ref: string | null;
  category: MemoryCategory;
  title: string;
  content: string;
  conditions: Record<string, unknown>;
  exceptions: Record<string, unknown>;
  source_event_ids: string[];
  confidence: number;
  status: MemoryStatus;
  times_applied: number;
  last_applied_at: string | null;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
}

export interface CaseMemoryInput {
  caseRef: string;
  title?: string;
  caseState: Record<string, unknown>;
  sourceMetadata?: Record<string, unknown>;
}

export interface CaseMemoryRecord {
  id: string;
  user_id: string;
  case_ref: string;
  title: string;
  case_state: Record<string, unknown>;
  source_metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export const LEARNING_TASK_TYPES: LearningTaskType[] = [
  'deconstruct',
  'qualify',
  'draft',
  'chat',
  'other',
];

export const LEARNING_MEMORY_CATEGORIES: MemoryCategory[] = [
  'decision_rule',
  'strategy_rule',
  'risk_preference',
  'workflow_rule',
  'correction_pattern',
];
