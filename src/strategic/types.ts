/**
 * Additive domain model for the Strategic Legal Assistant.
 * This module is intentionally isolated from existing application types so
 * current screens and API contracts remain backward-compatible.
 */

export type CaseDataOrigin =
  | 'attorney_input'
  | 'document_extraction'
  | 'ai_analysis'
  | 'legal_recommendation'
  | 'attorney_edit'
  | 'legacy_import';

export type VerificationStatus =
  | 'verified'
  | 'supported_inference'
  | 'unverified'
  | 'disputed'
  | 'rejected';

export type CaseDocumentKind =
  | 'pleading'
  | 'memo'
  | 'contract'
  | 'official_record'
  | 'correspondence'
  | 'judgment'
  | 'administrative_decision'
  | 'evidence'
  | 'other';

export type LegalDefenseCategory =
  | 'procedural'
  | 'jurisdiction'
  | 'limitation'
  | 'formal'
  | 'substantive'
  | 'evidentiary'
  | 'counterclaim'
  | 'other';

export type StrategicStage =
  | 'intake'
  | 'evidence_review'
  | 'legal_qualification'
  | 'defense_analysis'
  | 'opponent_analysis'
  | 'strategy'
  | 'final_review';

export interface CaseParty {
  id: string;
  name: string;
  role: 'client' | 'opponent' | 'intervenor' | 'other';
  capacity?: string;
  notes?: string;
}

export interface CaseTimelineEvent {
  id: string;
  date?: string;
  dateText?: string;
  title: string;
  description?: string;
  sourceDocumentIds: string[];
  origin: CaseDataOrigin;
  verification: VerificationStatus;
}

export interface CaseFact {
  id: string;
  text: string;
  origin: CaseDataOrigin;
  verification: VerificationStatus;
  sourceDocumentIds: string[];
  relatedFactIds: string[];
  createdAt: string;
  updatedAt: string;
  attorneyConfirmedAt?: string;
}

export interface DocumentFactLink {
  factId: string;
  relation: 'supports' | 'contradicts' | 'mentions' | 'unclear';
  explanation?: string;
  pageNumber?: number;
}

export interface CaseDocument {
  id: string;
  name: string;
  kind: CaseDocumentKind;
  mimeType?: string;
  storageRef?: string;
  extractedText?: string;
  extractionStatus: 'pending' | 'completed' | 'partial' | 'failed' | 'not_required';
  pageCount?: number;
  sourceTaskId?: string;
  factLinks: DocumentFactLink[];
  notes?: string;
  addedAt: string;
  updatedAt: string;
  origin: CaseDataOrigin;
}

export interface CaseEvidenceItem {
  id: string;
  description: string;
  documentIds: string[];
  factIds: string[];
  evidentiaryValue?: string;
  limitations?: string;
  verification: VerificationStatus;
}

export interface CaseLegalIssue {
  id: string;
  question: string;
  qualification?: string;
  alternativeQualifications: string[];
  relevantFacts: string[];
  supportingDocumentIds: string[];
  status: VerificationStatus;
  legalSources: string[];
}

export interface CaseDefense {
  id: string;
  title: string;
  category: LegalDefenseCategory;
  legalBasis?: string;
  factualBasis: string[];
  supportingDocumentIds: string[];
  strength: 'high' | 'medium' | 'low' | 'undetermined';
  status: VerificationStatus;
  priority: number;
  isPrimary: boolean;
  isAlternative: boolean;
  opponentResponse?: string;
  notes?: string;
}

export interface CaseRisk {
  id: string;
  description: string;
  likelihood: 'high' | 'medium' | 'low' | 'undetermined';
  impact: 'high' | 'medium' | 'low' | 'undetermined';
  mitigation?: string;
  requiresVerification: boolean;
}

export interface CaseRecommendation {
  id: string;
  action: string;
  reason: string;
  priority: number;
  relatedFactIds: string[];
  relatedDocumentIds: string[];
  status: 'proposed' | 'accepted' | 'rejected' | 'completed';
}

export interface OpponentIntentHypothesis {
  hypothesis: string;
  indicators: string[];
  confidence: 'high' | 'medium' | 'low' | 'undetermined';
  alternativeExplanation: string;
}

export interface OpponentNextMove {
  move: string;
  trigger: string;
  likelihood: 'high' | 'medium' | 'low' | 'undetermined';
  preparation: string;
}

export interface StrategicTimingRecommendation {
  action: string;
  timing: string;
  reason: string;
  riskOfActingEarly: string;
  riskOfDelay: string;
}

export interface CourtScenario {
  scenario: string;
  likelyConcern: string;
  possibleEffect: string;
  preparation: string;
}

export interface CaseStrategy {
  objective: string;
  primaryApproach: string;
  alternativeApproaches: string[];
  primaryDefenseIds: string[];
  alternativeDefenseIds: string[];
  opponentArguments: string[];
  opponentIntentHypotheses?: OpponentIntentHypothesis[];
  opponentNextMoves?: OpponentNextMove[];
  rebuttalPoints: string[];
  timingRecommendations?: StrategicTimingRecommendation[];
  courtScenarios?: CourtScenario[];
  strategicBlindSpots?: string[];
  avoidActions?: string[];
  nextBestAction?: string;
  evidenceGaps: string[];
  proceduralSteps: CaseRecommendation[];
  risks: CaseRisk[];
  priorities: string[];
  reviewedAt?: string;
}

export interface CaseAnalysisSnapshot {
  id: string;
  version: number;
  stage: StrategicStage;
  summary: string;
  findings: string[];
  unresolvedQuestions: string[];
  contradictions: string[];
  missingEvidence: string[];
  createdAt: string;
  modelId?: string;
  inputFingerprint: string;
}

export interface CaseMemoryEntry {
  id: string;
  caseId: string;
  category:
    | 'attorney_fact'
    | 'extracted_information'
    | 'model_finding'
    | 'legal_conclusion'
    | 'recommendation'
    | 'attorney_edit'
    | 'context_change';
  content: string;
  origin: CaseDataOrigin;
  verification: VerificationStatus;
  sourceDocumentIds: string[];
  relatedFactIds: string[];
  relatedAnalysisId?: string;
  supersedesEntryId?: string;
  createdAt: string;
  createdBy?: string;
}

export interface CaseContextChange {
  id: string;
  caseId: string;
  changeType:
    | 'fact_added'
    | 'fact_updated'
    | 'document_added'
    | 'document_updated'
    | 'party_updated'
    | 'request_updated'
    | 'date_updated'
    | 'attorney_correction';
  description: string;
  affectedFactIds: string[];
  affectedDocumentIds: string[];
  createdAt: string;
  reevaluationStatus: 'pending' | 'completed' | 'failed';
}

export interface UnifiedCaseFile {
  schemaVersion: 1;
  id: string;
  ownerUserId: string;
  title: string;
  court?: string;
  circuit?: string;
  caseNumber?: string;
  caseType?: string;
  clientRole?: string;
  parties: CaseParty[];
  requests: string[];
  decisions: string[];
  keyDates: CaseTimelineEvent[];
  originalFacts: CaseFact[];
  documents: CaseDocument[];
  evidence: CaseEvidenceItem[];
  legalIssues: CaseLegalIssue[];
  defenses: CaseDefense[];
  opponentPosition: string[];
  analysisSnapshots: CaseAnalysisSnapshot[];
  strategy?: CaseStrategy;
  memory: CaseMemoryEntry[];
  contextChanges: CaseContextChange[];
  createdAt: string;
  updatedAt: string;
  lastAnalyzedAt?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface StrategicAnalysisInput {
  caseFile: UnifiedCaseFile;
  requestedStages?: StrategicStage[];
  additionalInstructions?: string;
  priorAnalysis?: CaseAnalysisSnapshot[];
}

export interface StrategicAnalysisOutput {
  caseId: string;
  completedStages: StrategicStage[];
  stageResults: Partial<Record<StrategicStage, CaseAnalysisSnapshot>>;
  updatedFacts: CaseFact[];
  updatedIssues: CaseLegalIssue[];
  updatedDefenses: CaseDefense[];
  strategy?: CaseStrategy;
  memoryEntries: CaseMemoryEntry[];
  warnings: string[];
  requiresAttorneyReview: boolean;
}
