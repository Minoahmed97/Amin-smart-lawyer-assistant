import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, BookOpen, BrainCircuit, BriefcaseBusiness, CheckCircle2,
  FilePlus2, Loader2, Plus, RefreshCw,
  Save, ShieldAlert, Sparkles,
} from 'lucide-react';
import type { UnifiedCaseFile, StrategicStage, CaseAnalysisSnapshot } from '../strategic/types.ts';
import { FileUploadZone } from './FileUploadZone.tsx';
import {
  addCaseDocument, addCaseFact, addCaseParty, addCaseRequest, createCaseFile, createEmptyCaseFile, enqueueStrategicAnalysis,
  getCaseFile, getStrategicAnalysisJob, listCaseFiles, makeCaseDocument, makeCaseFact, makeCaseParty, setActiveStrategicCase,
} from '../strategic/caseFileService.ts';

const STAGES: { id: StrategicStage; label: string }[] = [
  { id: 'intake', label: 'فهم القضية والطلبات' },
  { id: 'evidence_review', label: 'فحص الأدلة والمستندات' },
  { id: 'legal_qualification', label: 'التكييف والمسائل القانونية' },
  { id: 'defense_analysis', label: 'الدفوع وأسانيدها' },
  { id: 'opponent_analysis', label: 'موقف الخصم والرد عليه' },
  { id: 'strategy', label: 'الاستراتيجية والبدائل والمخاطر' },
  { id: 'final_review', label: 'المراجعة النهائية والنواقص' },
];

type ParsedJobResult = {
  result?: {
    completedStages?: StrategicStage[];
    stageResults?: Partial<Record<StrategicStage, CaseAnalysisSnapshot>>;
    strategy?: UnifiedCaseFile['strategy'];
    warnings?: string[];
    requiresAttorneyReview?: boolean;
  };
  persisted?: boolean;
};

interface StrategicAssistantViewProps {
  userId: string;
  theme: 'warm-light' | 'dark';
}

export const StrategicAssistantView: React.FC<StrategicAssistantViewProps> = ({ userId, theme }) => {
  const isLight = theme === 'warm-light';
  const panel = isLight ? 'bg-white border-slate-200 text-slate-900' : 'bg-[#111827] border-slate-700 text-slate-100';
  const muted = isLight ? 'text-slate-600' : 'text-slate-400';
  const inputClass = isLight
    ? 'w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-slate-900 outline-none focus:border-amber-500'
    : 'w-full rounded-xl border border-slate-600 bg-slate-900 px-3 py-2.5 text-slate-100 outline-none focus:border-amber-500';

  const [cases, setCases] = useState<UnifiedCaseFile[]>([]);
  const [activeCase, setActiveCase] = useState<UnifiedCaseFile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [caseTitle, setCaseTitle] = useState('');
  const [court, setCourt] = useState('');
  const [caseNumber, setCaseNumber] = useState('');
  const [newFact, setNewFact] = useState('');
  const [partyName, setPartyName] = useState('');
  const [partyRole, setPartyRole] = useState<'client' | 'opponent' | 'intervenor' | 'other'>('client');
  const [partyCapacity, setPartyCapacity] = useState('');
  const [requestText, setRequestText] = useState('');
  const [instructions, setInstructions] = useState('');
  const [selectedStages, setSelectedStages] = useState<StrategicStage[]>(STAGES.map((stage) => stage.id));
  const [jobId, setJobId] = useState('');
  const [jobStatus, setJobStatus] = useState('');
  const [jobError, setJobError] = useState('');
  const [jobResult, setJobResult] = useState<ParsedJobResult | null>(null);
  const [showAllFacts, setShowAllFacts] = useState(false);

  const refreshCases = useCallback(async (selectId?: string) => {
    setLoading(true);
    setError('');
    try {
      const items = await listCaseFiles();
      setCases(items);
      const targetId = selectId || activeCase?.id;
      if (targetId) {
        const selected = items.find((item) => item.id === targetId);
        if (selected) {
          const fullCase = await getCaseFile(selected.id);
          setActiveCase(fullCase);
          setActiveStrategicCase(userId, fullCase.id);
        } else {
          setActiveCase(null);
          setActiveStrategicCase(userId, '');
        }
      } else if (items.length && !activeCase) {
        const fullCase = await getCaseFile(items[0].id);
        setActiveCase(fullCase);
        setActiveStrategicCase(userId, fullCase.id);
      } else if (!items.length) {
        setActiveCase(null);
        setActiveStrategicCase(userId, '');
      }
    } catch (e: any) {
      setError(e?.message || 'تعذر تحميل ملفات القضايا.');
    } finally {
      setLoading(false);
    }
  }, [activeCase?.id]);

  useEffect(() => { void refreshCases(); }, [userId]);

  const handleCreateCase = async () => {
    if (!caseTitle.trim()) { setError('أدخل عنواناً واضحاً لملف القضية.'); return; }
    setCreating(true);
    setError('');
    try {
      const blank = createEmptyCaseFile(userId, caseTitle);
      blank.court = court.trim() || undefined;
      blank.caseNumber = caseNumber.trim() || undefined;
      const created = await createCaseFile(blank);
      setCaseTitle('');
      setCourt('');
      setCaseNumber('');
      setActiveCase(created);
      setActiveStrategicCase(userId, created.id);
      setCases((previous) => [created, ...previous]);
    } catch (e: any) {
      setError(e?.message || 'تعذر إنشاء ملف القضية.');
    } finally {
      setCreating(false);
    }
  };

  const handleAddFact = async () => {
    if (!activeCase || !newFact.trim()) return;
    setSaving(true);
    setError('');
    try {
      const updated = await addCaseFact(activeCase, makeCaseFact(newFact.trim()));
      setActiveCase(updated);
      setCases((previous) => previous.map((item) => item.id === updated.id ? updated : item));
      setNewFact('');
      setJobResult(null);
    } catch (e: any) {
      setError(e?.message || 'تعذر حفظ الواقعة.');
    } finally {
      setSaving(false);
    }
  };

  const handleDocumentExtracted = async (text: string, fileName: string, fileType?: string) => {
    if (!activeCase || !text.trim()) return;
    setSaving(true);
    setError('');
    try {
      const document = makeCaseDocument({
        name: fileName,
        kind: 'other',
        mimeType: fileType || undefined,
        extractedText: text.trim(),
        extractionStatus: 'completed',
        factLinks: [],
        origin: 'document_extraction',
      });
      const updated = await addCaseDocument(activeCase, document);
      setActiveCase(updated);
      setCases((previous) => previous.map((item) => item.id === updated.id ? updated : item));
      setJobResult(null);
    } catch (e: any) {
      setError(e?.message || 'تم استخراج النص، لكن تعذر ربط المستند بملف القضية. أعد المحاولة دون حذف الملف الأصلي.');
    } finally {
      setSaving(false);
    }
  };

  const handleAddParty = async () => {
    if (!activeCase || !partyName.trim()) return;
    setSaving(true);
    setError('');
    try {
      const updated = await addCaseParty(activeCase, makeCaseParty(partyName, partyRole, partyCapacity));
      setActiveCase(updated);
      setCases((previous) => previous.map((item) => item.id === updated.id ? updated : item));
      setPartyName('');
      setPartyCapacity('');
      setJobResult(null);
    } catch (e: any) {
      setError(e?.message || 'تعذر حفظ بيانات الطرف.');
    } finally {
      setSaving(false);
    }
  };

  const handleAddRequest = async () => {
    if (!activeCase || !requestText.trim()) return;
    setSaving(true);
    setError('');
    try {
      const updated = await addCaseRequest(activeCase, requestText);
      setActiveCase(updated);
      setCases((previous) => previous.map((item) => item.id === updated.id ? updated : item));
      setRequestText('');
      setJobResult(null);
    } catch (e: any) {
      setError(e?.message || 'تعذر حفظ الطلب.');
    } finally {
      setSaving(false);
    }
  };

  const handleStartAnalysis = async () => {
    if (!activeCase) return;
    if (!selectedStages.length) { setError('اختر مرحلة تحليل واحدة على الأقل.'); return; }
    setError('');
    setJobError('');
    setJobResult(null);
    setJobStatus('queued');
    try {
      const queued = await enqueueStrategicAnalysis(activeCase.id, selectedStages, instructions);
      if (!queued.jobId) throw new Error('لم يُرجع الخادم معرّف مهمة التحليل.');
      setJobId(queued.jobId);
      setJobStatus(queued.status || 'queued');
    } catch (e: any) {
      setJobStatus('');
      setError(e?.message || 'تعذر بدء التحليل الاستراتيجي.');
    }
  };

  useEffect(() => {
    if (!jobId || !['queued', 'running'].includes(jobStatus)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const status = await getStrategicAnalysisJob(jobId);
        if (cancelled) return;
        setJobStatus(status.status);
        if (status.status === 'completed') {
          try {
            const parsed = JSON.parse(status.result || '{}') as ParsedJobResult;
            setJobResult(parsed);
            if (activeCase) {
              const latest = await getCaseFile(activeCase.id);
              if (!cancelled) {
                setActiveCase(latest);
                setCases((previous) => previous.map((item) => item.id === latest.id ? latest : item));
              }
            }
          } catch {
            setJobError('اكتملت المهمة، لكن تعذر قراءة النتيجة المنظمة. أعد تحميل ملف القضية للتحقق من حفظها.');
          }
        } else if (status.status === 'failed') {
          setJobError(status.error || 'تعذر إكمال التحليل الاستراتيجي.');
        } else {
          timer = setTimeout(poll, 4000);
        }
      } catch (e: any) {
        if (!cancelled) {
          setJobError(e?.message || 'تعذر متابعة حالة التحليل. يمكنك إعادة المحاولة دون فقد ملف القضية.');
          timer = setTimeout(poll, 7000);
        }
      }
    };
    timer = setTimeout(poll, 1200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [jobId, jobStatus, activeCase?.id]);

  const toggleStage = (stage: StrategicStage) => {
    setSelectedStages((previous) => previous.includes(stage)
      ? previous.filter((item) => item !== stage)
      : [...previous, stage]);
  };

  const strategy = jobResult?.result?.strategy || activeCase?.strategy;
  const snapshots = activeCase?.analysisSnapshots || [];
  const pendingContextChanges = activeCase?.contextChanges.filter((change) => change.reevaluationStatus === 'pending') || [];
  const visibleFacts = showAllFacts ? activeCase?.originalFacts || [] : (activeCase?.originalFacts || []).slice(-5);
  const stageSummary = (stage: StrategicStage) => [...snapshots].reverse().find((item) => item.stage === stage);

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 space-y-5" dir="rtl">
      <div className={`rounded-2xl border p-4 sm:p-6 ${panel}`}>
        <div className="flex items-start gap-3">
          <div className="w-11 h-11 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center shrink-0">
            <BrainCircuit className="w-6 h-6 text-amber-500" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-xl sm:text-2xl font-black text-amber-500">المعاون القانوني الاستراتيجي الذكي</h2>
            <p className={`mt-1 text-sm leading-7 ${muted}`}>ملف موحد لكل قضية، وذاكرة قانونية مستمرة، وتحليل متعدد المراحل يعمل في الخلفية باستخدام Gemini.</p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-emerald-600">Gemini فقط</span>
          <span className={`rounded-full border px-3 py-1 ${isLight ? 'border-slate-300' : 'border-slate-600'}`}>ذاكرة منفصلة لمصادر المعلومات</span>
          <span className={`rounded-full border px-3 py-1 ${isLight ? 'border-slate-300' : 'border-slate-600'}`}>مراجعة المحامي إلزامية</span>
        </div>
      </div>

      {error && <div role="alert" className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-500">{error}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.7fr)] gap-4 items-start">
        <aside className={`rounded-2xl border p-4 space-y-4 ${panel}`}>
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-bold flex items-center gap-2"><BriefcaseBusiness className="w-4 h-4 text-amber-500" /> ملفات القضايا</h3>
            <button onClick={() => void refreshCases()} disabled={loading} className="p-2 rounded-lg hover:bg-slate-500/10 disabled:opacity-50" title="تحديث القائمة"><RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /></button>
          </div>

          <div className={`rounded-xl border p-3 space-y-2 ${isLight ? 'border-slate-200 bg-slate-50' : 'border-slate-700 bg-slate-900/60'}`}>
            <h4 className="text-sm font-bold flex items-center gap-2"><FilePlus2 className="w-4 h-4 text-amber-500" /> إنشاء قضية جديدة</h4>
            <input className={inputClass} value={caseTitle} onChange={(event) => setCaseTitle(event.target.value)} placeholder="اسم أو عنوان القضية" maxLength={180} />
            <input className={inputClass} value={court} onChange={(event) => setCourt(event.target.value)} placeholder="المحكمة (اختياري)" maxLength={180} />
            <input className={inputClass} value={caseNumber} onChange={(event) => setCaseNumber(event.target.value)} placeholder="رقم الدعوى (اختياري)" maxLength={80} />
            <button onClick={() => void handleCreateCase()} disabled={creating || !caseTitle.trim()} className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-bold px-3 py-2.5 disabled:opacity-50">
              {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} إنشاء ملف القضية
            </button>
          </div>

          {loading ? <div className={`text-sm py-4 text-center ${muted}`}>جارٍ تحميل ملفات القضايا...</div> : cases.length ? (
            <div className="space-y-2 max-h-[420px] overflow-y-auto">
              {cases.map((item) => (
                <button key={item.id} onClick={() => { setActiveCase(item); setActiveStrategicCase(userId, item.id); setJobResult(null); setJobError(''); setJobId(''); setJobStatus(''); }} className={`w-full text-right rounded-xl border p-3 transition-colors ${activeCase?.id === item.id ? 'border-amber-500 bg-amber-500/10' : isLight ? 'border-slate-200 hover:bg-slate-50' : 'border-slate-700 hover:bg-slate-800'}`}>
                  <span className="block font-bold text-sm truncate">{item.title}</span>
                  <span className={`block mt-1 text-xs ${muted}`}>{item.caseNumber || 'رقم الدعوى غير محدد'} · {item.originalFacts.length} واقعة · {item.documents.length} مستند</span>
                </button>
              ))}
            </div>
          ) : <p className={`text-sm text-center py-4 ${muted}`}>لا توجد ملفات قضايا بعد. أنشئ أول ملف للبدء.</p>}
        </aside>

        <section className="space-y-4 min-w-0">
          {!activeCase ? (
            <div className={`rounded-2xl border p-8 text-center ${panel}`}>
              <BriefcaseBusiness className="w-10 h-10 text-amber-500 mx-auto mb-3" />
              <p className="font-bold">اختر ملف قضية أو أنشئ ملفاً جديداً للبدء.</p>
            </div>
          ) : (
            <>
              <div className={`rounded-2xl border p-4 sm:p-5 space-y-3 ${panel}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-lg font-black break-words">{activeCase.title}</h3>
                    <p className={`text-xs mt-1 ${muted}`}>{[activeCase.court, activeCase.caseNumber ? `الدعوى رقم ${activeCase.caseNumber}` : ''].filter(Boolean).join(' · ') || 'لم تُستكمل بيانات المحكمة ورقم الدعوى'}</p>
                  </div>
                  <button onClick={() => void refreshCases(activeCase.id)} className="p-2 rounded-lg hover:bg-slate-500/10" title="إعادة تحميل ملف القضية"><RefreshCw className="w-4 h-4" /></button>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {[
                    ['الوقائع', activeCase.originalFacts.length],
                    ['المستندات', activeCase.documents.length],
                    ['المسائل', activeCase.legalIssues.length],
                    ['الدفوع', activeCase.defenses.length],
                  ].map(([label, count]) => <div key={label} className={`rounded-xl p-3 text-center ${isLight ? 'bg-slate-50' : 'bg-slate-900'}`}><strong className="block text-xl text-amber-500">{count}</strong><span className={`text-xs ${muted}`}>{label}</span></div>)}
                </div>

                <div className={`rounded-xl border p-3 space-y-3 ${isLight ? 'border-slate-200 bg-slate-50' : 'border-slate-700 bg-slate-900/50'}`}>
                  <div>
                    <h4 className="text-sm font-bold">مستندات القضية واستخراج النصوص</h4>
                    <p className={`mt-1 text-xs leading-6 ${muted}`}>ارفع المستندات من خلال مسار OCR الحالي. بعد اكتمال الاستخراج يُحفظ النص واسم الملف داخل القضية ويرتبط بذاكرتها، دون استبدال النسخة الأصلية في مسارات الرفع الأخرى.</p>
                  </div>
                  <FileUploadZone
                    userId={userId}
                    recoveryScope="strategic"
                    title="إضافة مستندات إلى ملف القضية"
                    description="PDF وWord والصور — تُضاف نتيجة الاستخراج إلى هذه القضية."
                    onTextExtracted={handleDocumentExtracted}
                  />
                  {activeCase.documents.length > 0 && (
                    <div className="space-y-2">
                      <h5 className="text-xs font-bold">المستندات المرتبطة بالقضية ({activeCase.documents.length})</h5>
                      {activeCase.documents.map((document) => (
                        <details key={document.id} className={`rounded-lg border p-3 ${isLight ? 'border-slate-200' : 'border-slate-700'}`}>
                          <summary className="cursor-pointer text-sm font-semibold">{document.name} · {document.extractionStatus === 'completed' ? 'اكتمل استخراج النص' : 'حالة الاستخراج: ' + document.extractionStatus}</summary>
                          <p className={`mt-2 whitespace-pre-wrap text-xs leading-6 ${muted}`}>{document.extractedText ? document.extractedText.slice(0, 6000) : 'لا يوجد نص مستخرج محفوظ لهذا المستند.'}</p>
                        </details>
                      ))}
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className={`rounded-xl border p-3 space-y-2 ${isLight ? 'border-slate-200 bg-slate-50' : 'border-slate-700 bg-slate-900/50'}`}>
                    <h4 className="text-sm font-bold">أطراف القضية</h4>
                    <input className={inputClass} value={partyName} onChange={(event) => setPartyName(event.target.value)} placeholder="اسم الطرف" maxLength={180} />
                    <select className={inputClass} value={partyRole} onChange={(event) => setPartyRole(event.target.value as typeof partyRole)}>
                      <option value="client">الموكل</option>
                      <option value="opponent">الخصم</option>
                      <option value="intervenor">متدخل</option>
                      <option value="other">طرف آخر</option>
                    </select>
                    <input className={inputClass} value={partyCapacity} onChange={(event) => setPartyCapacity(event.target.value)} placeholder="الصفة القانونية (اختياري)" maxLength={180} />
                    <button onClick={() => void handleAddParty()} disabled={saving || !partyName.trim()} className="w-full rounded-lg border border-amber-500/50 px-3 py-2 text-sm font-bold text-amber-600 disabled:opacity-50">إضافة الطرف</button>
                    {activeCase.parties.length > 0 && <ul className="space-y-1 text-xs leading-6">{activeCase.parties.map((party) => <li key={party.id}>• {party.name} — {party.role === 'client' ? 'الموكل' : party.role === 'opponent' ? 'الخصم' : party.role === 'intervenor' ? 'متدخل' : 'طرف آخر'}{party.capacity ? ` (${party.capacity})` : ''}</li>)}</ul>}
                  </div>
                  <div className={`rounded-xl border p-3 space-y-2 ${isLight ? 'border-slate-200 bg-slate-50' : 'border-slate-700 bg-slate-900/50'}`}>
                    <h4 className="text-sm font-bold">طلبات الموكل</h4>
                    <textarea className={inputClass} rows={3} value={requestText} onChange={(event) => setRequestText(event.target.value)} placeholder="أدخل طلباً أصلياً أو احتياطياً كما حدده المحامي." />
                    <button onClick={() => void handleAddRequest()} disabled={saving || !requestText.trim()} className="w-full rounded-lg border border-amber-500/50 px-3 py-2 text-sm font-bold text-amber-600 disabled:opacity-50">إضافة الطلب</button>
                    {activeCase.requests.length > 0 && <ol className="list-decimal pr-5 space-y-1 text-xs leading-6">{activeCase.requests.map((request, index) => <li key={index}>{request}</li>)}</ol>}
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-bold">إضافة واقعة أو معلومة أدخلها المحامي</label>
                  <textarea className={inputClass} rows={3} value={newFact} onChange={(event) => setNewFact(event.target.value)} placeholder="اكتب الواقعة كما تريد إثباتها في ملف القضية. ستُحفظ بوصفها مدخلاً من المحامي، لا حقيقة مستخرجة آلياً." />
                  <div className="flex justify-end">
                    <button onClick={() => void handleAddFact()} disabled={saving || !newFact.trim()} className="inline-flex items-center gap-2 rounded-xl border border-amber-500/50 px-4 py-2 text-sm font-bold text-amber-600 hover:bg-amber-500/10 disabled:opacity-50">
                      {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} حفظ الواقعة
                    </button>
                  </div>
                </div>

                {activeCase.originalFacts.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between"><h4 className="text-sm font-bold">الوقائع المسجلة</h4><button onClick={() => setShowAllFacts((value) => !value)} className="text-xs text-amber-600">{showAllFacts ? 'عرض الأحدث فقط' : 'عرض الكل'}</button></div>
                    <div className="space-y-2">
                      {visibleFacts.map((fact) => <div key={fact.id} className={`rounded-lg border p-3 text-sm leading-7 ${isLight ? 'border-slate-200' : 'border-slate-700'}`}><p>{fact.text}</p><p className={`mt-1 text-[11px] ${muted}`}>المصدر: {fact.origin === 'attorney_input' ? 'إدخال المحامي' : fact.origin} · التحقق: {fact.verification}</p></div>)}
                    </div>
                  </div>
                )}
              </div>

              <div className={`rounded-2xl border p-4 sm:p-5 space-y-4 ${panel}`}>
                <div className="flex items-center gap-2"><Sparkles className="w-5 h-5 text-amber-500" /><h3 className="font-black">إعداد التحليل الاستراتيجي</h3></div>
                {pendingContextChanges.length > 0 && (
                  <div className={`rounded-xl border p-3 text-sm leading-6 ${isLight ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-amber-500/40 bg-amber-950/30 text-amber-100'}`}>
                    <strong>توجد تغييرات لم يُعَد تقييم أثرها بعد ({pendingContextChanges.length}).</strong>
                    <p className="mt-1">أُضيفت وقائع أو مستندات أو تعديلات بعد آخر تحليل. شغّل التحليل مجدداً لتحديث النتائج؛ لن تُمحى النسخ السابقة.</p>
                  </div>
                )}
                <p className={`text-sm leading-6 ${muted}`}>اختر المراحل التي تريد تنفيذها. يبدأ التحليل كمهمة خلفية، وتُحفظ النتيجة في ذاكرة القضية عند اكتمالها.</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {STAGES.map((stage) => <label key={stage.id} className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm cursor-pointer ${isLight ? 'border-slate-200' : 'border-slate-700'}`}><input type="checkbox" checked={selectedStages.includes(stage.id)} onChange={() => toggleStage(stage.id)} className="accent-amber-600" /><span>{stage.label}</span></label>)}
                </div>
                <textarea className={inputClass} rows={2} value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="تعليمات إضافية للمحرك (اختياري)" maxLength={12000} />
                <button onClick={() => void handleStartAnalysis()} disabled={['queued', 'running'].includes(jobStatus) || !selectedStages.length} className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-black px-4 py-3 disabled:opacity-50">
                  {['queued', 'running'].includes(jobStatus) ? <Loader2 className="w-5 h-5 animate-spin" /> : <BrainCircuit className="w-5 h-5" />}
                  {jobStatus === 'running' ? 'جارٍ تحليل القضية...' : jobStatus === 'queued' ? 'التحليل في قائمة الانتظار...' : (pendingContextChanges.length ? 'أعد تقييم القضية بعد التغييرات' : 'ابدأ التحليل الاستراتيجي')}
                </button>
                {jobError && <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-500">{jobError}</div>}
                {jobStatus === 'completed' && <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-600 flex items-center gap-2"><CheckCircle2 className="w-4 h-4 shrink-0" /> اكتمل التحليل. {jobResult?.persisted ? 'تم حفظ النتائج في ملف القضية.' : 'يرجى مراجعة حالة الحفظ والتنبيهات أدناه.'}</div>}
                {jobResult?.result?.warnings?.length ? (
                  <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm leading-6 text-amber-600">
                    <strong>تنبيهات المحرك:</strong>
                    <ul className="mt-1 list-disc pr-5">{jobResult.result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
                  </div>
                ) : null}
              </div>

              {strategy && (
                <div className={`rounded-2xl border p-4 sm:p-5 space-y-4 ${panel}`}>
                  <h3 className="font-black flex items-center gap-2"><BookOpen className="w-5 h-5 text-amber-500" /> خلاصة الاستراتيجية الحالية</h3>
                  {strategy.objective && <div><h4 className="text-sm font-bold text-amber-600">الهدف</h4><p className="text-sm leading-7 mt-1">{strategy.objective}</p></div>}
                  {strategy.primaryApproach && <div><h4 className="text-sm font-bold text-amber-600">المسار الرئيسي</h4><p className="text-sm leading-7 mt-1">{strategy.primaryApproach}</p></div>}
                  {strategy.alternativeApproaches?.length > 0 && <div><h4 className="text-sm font-bold text-amber-600">البدائل</h4><ul className="list-disc pr-5 text-sm leading-7">{strategy.alternativeApproaches.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
                  {strategy.opponentArguments?.length > 0 && <div><h4 className="text-sm font-bold text-amber-600">أقوى حجج الخصم المحتملة</h4><ul className="list-disc pr-5 text-sm leading-7">{strategy.opponentArguments.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
                  {strategy.rebuttalPoints?.length > 0 && <div><h4 className="text-sm font-bold text-amber-600">نقاط الرد</h4><ul className="list-disc pr-5 text-sm leading-7">{strategy.rebuttalPoints.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
                  {strategy.evidenceGaps?.length > 0 && <div><h4 className="text-sm font-bold text-amber-600">الفجوات الإثباتية</h4><ul className="list-disc pr-5 text-sm leading-7">{strategy.evidenceGaps.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
                  {strategy.priorities?.length > 0 && <div><h4 className="text-sm font-bold text-amber-600">الأولويات</h4><ol className="list-decimal pr-5 text-sm leading-7">{strategy.priorities.map((item, index) => <li key={index}>{item}</li>)}</ol></div>}
                  {strategy.risks?.length > 0 && <div><h4 className="text-sm font-bold text-amber-600 flex items-center gap-2"><ShieldAlert className="w-4 h-4" /> المخاطر</h4><div className="space-y-2 mt-2">{strategy.risks.map((risk) => <div key={risk.id} className={`rounded-lg border p-3 text-sm ${isLight ? 'border-amber-200 bg-amber-50' : 'border-amber-500/20 bg-amber-950/20'}`}><p className="font-semibold">{risk.description}</p>{risk.mitigation && <p className={`mt-1 ${muted}`}>التعامل المقترح: {risk.mitigation}</p>}</div>)}</div></div>}
                  {strategy.proceduralSteps?.length > 0 && <div><h4 className="text-sm font-bold text-amber-600">الإجراءات العملية المقترحة</h4><div className="space-y-2 mt-2">{strategy.proceduralSteps.map((step) => <div key={step.id} className={`rounded-lg border p-3 text-sm ${isLight ? 'border-slate-200' : 'border-slate-700'}`}><p className="font-semibold">{step.action}</p><p className={`mt-1 ${muted}`}>{step.reason}</p></div>)}</div></div>}
                  <div className={`rounded-lg p-3 text-xs leading-6 ${isLight ? 'bg-amber-50 text-amber-900' : 'bg-amber-950/30 text-amber-100'}`}><AlertTriangle className="w-4 h-4 inline ml-1" /> هذه النتائج تحليل آلي أولي وليست رأياً قانونياً نهائياً. يجب مراجعة المستندات والنصوص والمواعيد بمعرفة المحامي.</div>
                </div>
              )}

              {snapshots.length > 0 && (
                <div className={`rounded-2xl border p-4 sm:p-5 space-y-3 ${panel}`}>
                  <h3 className="font-black">نتائج مراحل التحليل المحفوظة</h3>
                  {STAGES.map((stage) => {
                    const snapshot = stageSummary(stage.id);
                    if (!snapshot) return null;
                    return <details key={stage.id} className={`rounded-xl border p-3 ${isLight ? 'border-slate-200' : 'border-slate-700'}`}><summary className="cursor-pointer text-sm font-bold">{stage.label} · الإصدار {snapshot.version}</summary><div className="pt-3 space-y-2 text-sm leading-7"><p>{snapshot.summary}</p>{snapshot.findings.map((finding, index) => <p key={index}>• {finding}</p>)}{snapshot.unresolvedQuestions.map((question, index) => <p key={`q${index}`} className="text-amber-600">سؤال مفتوح: {question}</p>}{snapshot.contradictions.map((item, index) => <p key={`c${index}`} className="text-red-500">تعارض: {item}</p>)}{snapshot.missingEvidence.map((item, index) => <p key={`m${index}`} className={muted}>دليل مطلوب للتحقق: {item}</p>)}</div></details>;
                  })}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
};
