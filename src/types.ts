export type CourtJurisdiction = string;
export type BriefType = string;

export type CaseMaterialKind = 'case_facts' | 'opponent_pleading' | 'prior_legal_analysis' | 'supporting_document';

export interface LegalCaseMaterial {
  id: string;
  kind: CaseMaterialKind;
  title: string;
  content: string;
  sourceView: 'qualification' | 'deconstruction' | 'drafting';
  capturedAt: string;
}

export interface LegalCaseContext {
  schemaVersion: 1;
  caseId: string;
  updatedAt: string;
  court: string;
  circuit: string;
  caseNumber: string;
  clientName: string;
  clientRole: string;
  opponentName: string;
  caseNature: string;
  selectedDocumentType: string;
  sessionDate: string;
  defenses: string;
  requests: string;
  proceduralStage: string;
  proceduralStageSource: 'lawyer_provided' | 'not_provided';
  clientGoals: string;
  materials: LegalCaseMaterial[];
  priorAnalysis: Array<{
    type: 'qualification' | 'deconstruction';
    content: string;
    capturedAt: string;
  }>;
  verificationNotes: string[];
}

export interface DraftingFormData {
  courtType: string;
  circuit: string;
  briefType: string;
  judicialWorkType?: string;
  customJudicialWorkType?: string;
  clientRole: string;
  clientName: string;
  opponentName: string;
  caseNumber: string;
  sessionDate: string;
  facts: string;
  defenses: string;
  requests: string;
  customInstructions?: string;
  caseAnalysisContext?: string;
  caseContext?: LegalCaseContext;
  exemplarBrief?: string;
  useFewShot?: boolean;
}

export interface OpponentDeconstructionResult {
  detectedWorkType: string;
  closingRequests: string[];
  legalGrounds: string[];
  substantiveDefensesAndFlaws: string[];
  recommendedRebuttalStrategy: string[];
  counterBrief: string;
  appliedModelName?: string;
  rawAnalysisText?: string;
}

export interface LegalDefense {
  id: string;
  category: 'مدني' | 'جنائي' | 'إداري مجلس دولة' | 'أسرة وأحوال شخصية' | 'شيكات وإيصالات أمانة' | 'إجراءات ومواعيد';
  name: string;
  statute: string;
  article: string;
  legalBasis: string;
  cassationRule: string;
  draftingSnippet: string;
}

export interface CasePreset {
  id: string;
  title: string;
  description: string;
  category: 'مدني' | 'جنائي' | 'إداري' | 'أسرة';
  data: Partial<DraftingFormData> & { opponentBrief?: string; ourPosition?: string };
}

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  credits: number;
  planName: string;
}

export interface LawModelItem {
  id: string;
  title: string;
  category: string;
  judicialWorkType?: string;
  content: string;
  weight: number; // 1 to 5
  notes?: string;
  fileName?: string;
  createdAt: string;
  source: 'uploaded' | 'custom' | 'system';
}

export interface PlatformPackage {
  id: string;
  name: string;
  credits: number;
  price: string;
  numericPrice?: number;
  badge?: string;
  popular?: boolean;
  description: string;
  features: string[];
  enabled?: boolean;
}
