import React, { useEffect, useMemo, useState } from 'react';
import { BookOpenCheck, BrainCircuit, CheckCircle2, Loader2, Plus, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { FileUploadZone } from './FileUploadZone.tsx';
import { getFileBatchItems } from '../utils/fileBatchStorage.ts';
import { getRequestHeaders } from '../services/aiService.ts';

type ArchiveCaseMeta = { id: string; title: string };
type LearningProposal = {
  id: string;
  title: string;
  content: string;
  scope: 'global' | 'case';
  category: string;
  confidence: number;
  case_ref?: string | null;
};

const caseStorageKey = (userId: string) => `amin_learning_archive_cases_${String(userId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
const archiveScope = (caseId: string) => `learning-case-archive-${caseId}`;

function createCaseId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {}
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.random() * 16 | 0;
    return (character === 'x' ? random : (random & 0x3 | 0x8)).toString(16);
  });
}

function readArchiveCases(userId: string): ArchiveCaseMeta[] {
  try {
    const rows = JSON.parse(localStorage.getItem(caseStorageKey(userId)) || '[]');
    return Array.isArray(rows) ? rows.filter((row) =>
      row && typeof row.id === 'string' && typeof row.title === 'string'
    ).slice(0, 8) : [];
  } catch {
    return [];
  }
}

export const CaseArchiveLearningView: React.FC<{ userId: string }> = ({ userId }) => {
  const [cases, setCases] = useState<ArchiveCaseMeta[]>(() => readArchiveCases(userId));
  const [activeCaseId, setActiveCaseId] = useState('');
  const [newCaseTitle, setNewCaseTitle] = useState('');
  const [documents, setDocuments] = useState<Array<{ name: string; text: string }>>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isLoadingQueue, setIsLoadingQueue] = useState(false);
  const [error, setError] = useState('');
  const [resultNote, setResultNote] = useState('');
  const [proposals, setProposals] = useState<LearningProposal[]>([]);
  const [analysisSummary, setAnalysisSummary] = useState<Array<{ title: string; summary: string; proposals: number }>>([]);
  const [globalProposalCount, setGlobalProposalCount] = useState(0);

  const activeCase = useMemo(() => cases.find((item) => item.id === activeCaseId) || cases[0] || null, [cases, activeCaseId]);

  useEffect(() => {
    try { localStorage.setItem(caseStorageKey(userId), JSON.stringify(cases)); } catch {}
  }, [cases, userId]);

  useEffect(() => {
    if (!activeCase) {
      setDocuments([]);
      setActiveCaseId('');
      return;
    }
    setActiveCaseId(activeCase.id);
    let active = true;
    void getFileBatchItems(userId, archiveScope(activeCase.id)).then((rows) => {
      if (!active) return;
      setDocuments(rows
        .filter((item) => item.status === 'completed' && Boolean(item.extractedText?.trim()))
        .map((item) => ({ name: item.fileName, text: String(item.extractedText || '') })));
    }).catch((loadError) => {
      if (active) setError(loadError?.message || 'تعذر استعادة مستندات القضية المحفوظة على هذا الجهاز.');
    });
    return () => { active = false; };
  }, [userId, activeCase?.id]);

  const loadReviewQueue = async () => {
    setIsLoadingQueue(true);
    try {
      const response = await fetch('/api/learning/memory', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ action: 'list-review-queue' }),
        cache: 'no-store',
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || 'تعذر تحميل مقترحات الخبرة.');
      setProposals(Array.isArray(data?.proposedMemories) ? data.proposedMemories : []);
    } catch (loadError: any) {
      setError(loadError?.message || 'تعذر تحميل مقترحات الخبرة.');
    } finally {
      setIsLoadingQueue(false);
    }
  };

  useEffect(() => { void loadReviewQueue(); }, [userId]);

  const addCase = () => {
    if (cases.length >= 8) {
      setError('يمكن تجهيز 8 قضايا كحد أقصى في هذه المجموعة.');
      return;
    }
    const next = { id: createCaseId(), title: newCaseTitle.trim() || `قضية سابقة ${cases.length + 1}` };
    setCases((previous) => [...previous, next]);
    setActiveCaseId(next.id);
    setNewCaseTitle('');
    setDocuments([]);
    setError('');
  };

  const refreshActiveDocuments = async () => {
    if (!activeCase) return;
    const rows = await getFileBatchItems(userId, archiveScope(activeCase.id));
    setDocuments(rows
      .filter((item) => item.status === 'completed' && Boolean(item.extractedText?.trim()))
      .map((item) => ({ name: item.fileName, text: String(item.extractedText || '') })));
  };

  const analyzeArchive = async () => {
    setError('');
    setResultNote('');
    setAnalysisSummary([]);
    setGlobalProposalCount(0);
    setIsAnalyzing(true);
    try {
      const preparedCases = [];
      let totalChars = 0;
      for (const item of cases) {
        const rows = await getFileBatchItems(userId, archiveScope(item.id));
        const extracted = rows
          .filter((row) => row.status === 'completed' && Boolean(row.extractedText?.trim()))
          .map((row) => ({ name: row.fileName, type: row.mimeType || 'غير محدد', text: String(row.extractedText || '') }));
        if (!extracted.length) continue;
        totalChars += extracted.reduce((sum, document) => sum + document.text.length, 0);
        if (totalChars > 500000) throw new Error('إجمالي النصوص تجاوز 500 ألف حرف. قسّم الأرشيف إلى مجموعات أصغر.');
        preparedCases.push({ caseRef: item.id, title: item.title, documents: extracted });
      }
      if (!preparedCases.length) throw new Error('ارفع مستندًا واحدًا على الأقل واستكمل استخراج نصه قبل بدء التعلّم.');
      if (preparedCases.length > 8) throw new Error('قسّم الأرشيف إلى مجموعات لا تتجاوز 8 قضايا.');
      const response = await fetch('/api/learning/memory', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ action: 'analyze-case-archive', cases: preparedCases }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || 'تعذر تحليل أرشيف القضايا.');
      const summaries = Array.isArray(data?.cases) ? data.cases : [];
      setAnalysisSummary(summaries.map((item: any) => ({
        title: String(item.title || 'قضية'),
        summary: String(item.caseSummary || 'اكتمل التحليل دون ملخص متاح.'),
        proposals: Number(item.caseMemoryProposals || 0),
      })));
      setGlobalProposalCount(Array.isArray(data?.globalMemories) ? data.globalMemories.length : 0);
      setResultNote(`اكتمل تحليل ${summaries.length} قضية. مقترحات الخبرة الجديدة: ${Number(data?.totalProposals || 0)}. راجع المقترحات أدناه لاعتماد المناسب منها.`);
      await loadReviewQueue();
    } catch (analysisError: any) {
      setError(analysisError?.message || 'تعذر تحليل أرشيف القضايا.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const reviewProposal = async (memoryId: string, decision: 'approved' | 'rejected') => {
    setError('');
    try {
      const response = await fetch('/api/learning/memory', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ action: 'review-memory', memoryId, decision }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || 'تعذرت مراجعة الخبرة.');
      setProposals((previous) => previous.filter((item) => item.id !== memoryId));
    } catch (reviewError: any) {
      setError(reviewError?.message || 'تعذرت مراجعة الخبرة.');
    }
  };

  return (
    <section className="bg-[#0f172a] border border-emerald-700/50 rounded-2xl p-4 sm:p-5 shadow-xl space-y-4" dir="rtl">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-emerald-950 border border-emerald-700 flex items-center justify-center text-emerald-300 shrink-0">
          <BrainCircuit className="w-5 h-5" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm sm:text-base font-black text-emerald-200">التعلّم من أرشيف القضايا السابقة</h3>
          <p className="text-[11px] sm:text-xs text-slate-300 leading-relaxed mt-1">
            اجمع مستندات كل قضية تحت ملف مستقل. أمين يقرأها ويربط مراحلها ويستنتج اختياراتك المهنية، دون أن تطلب منه شرح كل إضافة أو حذف.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2">
        <input
          value={newCaseTitle}
          onChange={(event) => setNewCaseTitle(event.target.value)}
          placeholder="عنوان داخلي للقضية (اختياري، دون اسم موكل أو رقم قضية)"
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-xs text-white outline-none focus:border-emerald-600"
          maxLength={240}
        />
        <button type="button" onClick={addCase} disabled={cases.length >= 8} className="rounded-lg border border-emerald-700 bg-emerald-950 px-3 py-2 text-xs font-bold text-emerald-200 hover:bg-emerald-900 disabled:opacity-50 flex items-center justify-center gap-1.5">
          <Plus className="w-4 h-4" /> إضافة قضية
        </button>
      </div>

      {cases.length > 0 && (
        <>
          <div className="flex flex-wrap gap-2">
            {cases.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveCaseId(item.id)}
                className={`rounded-lg border px-3 py-2 text-xs font-bold transition-colors ${activeCase?.id === item.id ? 'border-emerald-500 bg-emerald-950 text-emerald-100' : 'border-slate-700 bg-slate-950 text-slate-300 hover:border-slate-500'}`}
              >
                {item.title}
              </button>
            ))}
          </div>

          {activeCase && (
            <div className="rounded-xl border border-slate-700 bg-slate-950/60 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-xs font-bold text-white">مستندات: {activeCase.title}</h4>
                <span className="text-[10px] text-slate-400">{documents.length} مستندات مكتملة الاستخراج</span>
              </div>
              <FileUploadZone
                userId={userId}
                recoveryScope={archiveScope(activeCase.id)}
                maxFiles={30}
                onTextExtracted={async () => { await refreshActiveDocuments(); }}
                title="رفع مستندات القضية"
                description="يمكن رفع المذكرات، مستندات الخصم، تقارير الخبراء، المحاضر، القرارات والأحكام. تتم الاستفادة من مستخرج النصوص الحالي."
              />
              {documents.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {documents.map((document, index) => (
                    <span key={`${document.name}-${index}`} className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-[10px] text-slate-300">{document.name}</span>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      <div className="flex flex-col sm:flex-row gap-2 sm:items-center sm:justify-between">
        <p className="text-[10px] text-slate-400 leading-relaxed">
          النصوص المستخرجة تُرسل إلى Gemini لتحليلها. تُحفظ المستندات الأصلية محليًا على هذا الجهاز، بينما تُحفظ خلاصة التحليل والخبرات في حسابك.
        </p>
        <button type="button" onClick={() => void analyzeArchive()} disabled={isAnalyzing || !cases.length} className="shrink-0 rounded-xl bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 px-4 py-2.5 text-xs font-black text-white flex items-center justify-center gap-2">
          {isAnalyzing ? <><Loader2 className="w-4 h-4 animate-spin" /> أمين يدرس الأرشيف...</> : <><BookOpenCheck className="w-4 h-4" /> تحليل القضايا واستخلاص الخبرة</>}
        </button>
      </div>

      {error && <div className="rounded-lg border border-rose-800 bg-rose-950/50 px-3 py-2 text-xs text-rose-200">{error}</div>}
      {resultNote && (
        <div className="rounded-lg border border-emerald-700 bg-emerald-950/50 p-3 text-xs text-emerald-200 space-y-1">
          <div className="flex items-center gap-2 font-bold"><CheckCircle2 className="w-4 h-4" /> {resultNote}</div>
          {globalProposalCount > 0 && <p>خبرات عامة مقترحة من المقارنة بين القضايا: {globalProposalCount}</p>}
        </div>
      )}
      {analysisSummary.length > 0 && (
        <div className="space-y-2">
          {analysisSummary.map((item, index) => (
            <div key={index} className="rounded-lg border border-slate-700 bg-slate-950/50 p-3">
              <div className="text-xs font-bold text-white">{item.title}</div>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-300">{item.summary}</p>
              <p className="mt-1 text-[10px] text-emerald-300">خبرات خاصة بالقضية مقترحة: {item.proposals}</p>
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-slate-800 pt-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-xs font-black text-amber-200">مقترحات الخبرة التي تنتظر اعتمادك ({proposals.length})</h4>
          <button type="button" onClick={() => void loadReviewQueue()} disabled={isLoadingQueue} className="text-[10px] text-slate-300 hover:text-white flex items-center gap-1 disabled:opacity-50">
            <RefreshCw className={`w-3 h-3 ${isLoadingQueue ? 'animate-spin' : ''}`} /> تحديث
          </button>
        </div>
        {proposals.length === 0 ? (
          <p className="text-[10px] text-slate-400">لا توجد مقترحات معلقة حاليًا.</p>
        ) : proposals.map((proposal) => (
          <div key={proposal.id} className="rounded-lg border border-slate-700 bg-slate-950/60 p-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold text-white">{proposal.title}</span>
              <span className="text-[9px] rounded border border-slate-600 px-1.5 py-0.5 text-slate-300">{proposal.scope === 'global' ? 'خبرة عامة' : 'هذه القضية فقط'}</span>
              <span className="text-[9px] text-slate-400">الثقة: {Math.round(Number(proposal.confidence || 0) * 100)}%</span>
            </div>
            <p className="text-[11px] leading-relaxed text-slate-300 whitespace-pre-wrap">{proposal.content}</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => void reviewProposal(proposal.id, 'approved')} className="rounded-md bg-emerald-800 px-3 py-1.5 text-[10px] font-bold text-white hover:bg-emerald-700 flex items-center gap-1">
                <ShieldCheck className="w-3.5 h-3.5" /> اعتماد الخبرة
              </button>
              <button type="button" onClick={() => void reviewProposal(proposal.id, 'rejected')} className="rounded-md border border-rose-800 px-3 py-1.5 text-[10px] font-bold text-rose-200 hover:bg-rose-950 flex items-center gap-1">
                <XCircle className="w-3.5 h-3.5" /> رفض
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
};
