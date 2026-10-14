import { getCurrentAccount } from '../services/authService.ts';
import React, { useState, useEffect } from 'react';
import { DraftingFormData } from '../types.ts';
import { FileUploadZone } from './FileUploadZone.tsx';
import { VoiceDictateButton } from './VoiceDictateButton.tsx';
import {
  refineDraftText,
  draftCounterBrief,
  resumeDraftCounterBrief,
} from '../services/aiService.ts';
import { getAllLawModels } from '../utils/legalVaultService.ts';
import { getCurrentStoredCredits } from '../utils/deviceFingerprint.ts';
import {
  FileText,
  Sparkles,
  Copy,
  Check,
  Printer,
  Scale,
  Loader2,
  ShieldCheck,
  FileCheck2,
  Eye,
  Edit3,
  ZoomIn,
  ZoomOut,
  Type,
  FolderArchive,
  Download,
  RotateCcw,
  Share2,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react';
import { copyTextSafely, shareLegalDoc } from '../utils/clipboardHelper.ts';
import { exportLegalDocToWord } from '../utils/exportHelper.ts';
import { persistentStorage } from '../utils/persistentStorage.ts';
import { AppliedRulesAuditBadge } from './AppliedRulesAuditBadge.tsx';

interface DraftingViewProps {
  initialFormData?: Partial<DraftingFormData>;
  userId: string;
  onOpenSubscribe: () => void;
  onCreditsUpdated: (credits: number) => void;
  onSwitchTab?: (tab: 'draft' | 'deconstruct' | 'qualify' | 'defenses' | 'packages' | 'vault') => void;
}

export const DraftingView: React.FC<DraftingViewProps> = ({
  initialFormData,
  userId,
  onOpenSubscribe,
  onCreditsUpdated,
  onSwitchTab,
}) => {
  const [formData, setFormData] = useState<DraftingFormData>(() => {
    const saved = persistentStorage.getJSON<DraftingFormData>('amin_judicial_draft_form');
    if (saved) {
      return {
        ...saved,
        ...(initialFormData && Object.keys(initialFormData).length > 0 ? initialFormData : {}),
      };
    }
    return {
      courtType: initialFormData?.courtType || '',
      circuit: initialFormData?.circuit || '',
      briefType: initialFormData?.briefType || '',
      judicialWorkType: initialFormData?.judicialWorkType || '',
      customJudicialWorkType: initialFormData?.customJudicialWorkType || '',
      clientRole: initialFormData?.clientRole || 'مدعى عليه',
      clientName: initialFormData?.clientName || '',
      opponentName: initialFormData?.opponentName || '',
      caseNumber: initialFormData?.caseNumber || '',
      sessionDate: initialFormData?.sessionDate || '',
      facts: initialFormData?.facts || '',
      defenses: initialFormData?.defenses || '',
      requests: initialFormData?.requests || '',
      customInstructions: initialFormData?.customInstructions || '',
    };
  });

  const [uploadedDocName, setUploadedDocName] = useState<string>(() => {
    return persistentStorage.getItem('amin_judicial_draft_docname', '');
  });
  const [isUploadingDoc, setIsUploadingDoc] = useState<boolean>(false);
  const [generatedBrief, setGeneratedBrief] = useState<string>(() => {
    return persistentStorage.getItem('amin_judicial_draft_result', '');
  });
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isRefining, setIsRefining] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const [refineNote, setRefineNote] = useState<string>('');
  const [fontSizePt, setFontSizePt] = useState<number>(18);
  const [fontFamily, setFontFamily] = useState<'traditional' | 'amiri'>('traditional');
  const [isLiveEditing, setIsLiveEditing] = useState<boolean>(false);
  const [vaultModelsCount, setVaultModelsCount] = useState<number>(0);

  // General task types only. The AI decides which vault references are useful;
  // the user is not asked to choose an internal template/subtype.
  const judicialWorkCategories = [
    {
      categoryId: 'general',
      categoryTitle: 'المهام القانونية',
      options: [
        { id: 'إنشاء صيغة قانونية', label: 'إنشاء صيغة قانونية', roleHint: '' },
        { id: 'صحيفة دعوى', label: 'كتابة دعوى / صحيفة دعوى', roleHint: 'مدعٍ' },
        { id: 'طلب قانوني', label: 'إعداد طلب قانوني', roleHint: 'طالب' },
        { id: 'مذكرة', label: 'كتابة مذكرة', roleHint: '' },
        { id: 'تفنيد مستند أو مذكرة', label: 'تفنيد مستند أو مذكرة', roleHint: '' },
        { id: 'الرد على مستند أو مذكرة', label: 'الرد على مستند أو مذكرة', roleHint: '' },
        { id: 'عقد أو اتفاقية', label: 'كتابة عقد / اتفاقية', roleHint: '' },
        { id: 'إنذار أو مكاتبة قانونية', label: 'إنذار / مكاتبة قانونية', roleHint: 'منذر' },
        { id: 'طعن أو استئناف', label: 'طعن / استئناف', roleHint: 'طاعن' },
        { id: '__custom__', label: 'مهمة قانونية أخرى (اكتبها باليد)', roleHint: 'طالب' },
      ],
    },
  ];

  useEffect(() => {
    const models = getAllLawModels(userId);
    setVaultModelsCount(models.length);
  }, [userId]);

  useEffect(() => {
    persistentStorage.setJSON('amin_judicial_draft_form', formData);
  }, [formData]);

  useEffect(() => {
    persistentStorage.setItem('amin_judicial_draft_result', generatedBrief || '');
  }, [generatedBrief]);

  useEffect(() => {
    persistentStorage.setItem('amin_judicial_draft_docname', uploadedDocName || '');
  }, [uploadedDocName]);

  useEffect(() => {
    if (initialFormData && Object.keys(initialFormData).length > 0) {
      setFormData((prev) => ({
        ...prev,
        ...initialFormData,
      }));
    }
  }, [initialFormData]);

  const clearForm = () => {
    setFormData({
      courtType: '',
      circuit: '',
      briefType: '',
      judicialWorkType: '',
      customJudicialWorkType: '',
      clientRole: '',
      clientName: '',
      opponentName: '',
      caseNumber: '',
      sessionDate: '',
      facts: '',
      defenses: '',
      requests: '',
      customInstructions: '',
    });
    setUploadedDocName('');
    setGeneratedBrief('');
    setRefineNote('');
    persistentStorage.removeItem('amin_judicial_draft_form');
    persistentStorage.removeItem('amin_judicial_draft_result');
    persistentStorage.removeItem('amin_judicial_draft_docname');
  };

  const [draftError, setDraftError] = useState<string>('');

  // Recover an in-flight server-side job after refresh, app backgrounding, or reopening.
  useEffect(() => {
    let active = true;
    let jobId = '';
    try { jobId = localStorage.getItem(`amin_judicial_draft_job_id_${String(userId || 'default')}`) || ''; } catch {}
    if (!jobId) return () => { active = false; };
    setIsLoading(true);
    setDraftError('');
    setGeneratedBrief('');
    void resumeDraftCounterBrief(jobId, (chunk) => {
      if (active) setGeneratedBrief((current) => current + chunk);
    }, userId).then(async (result) => {
      if (!active) return;
      setGeneratedBrief(result);
      persistentStorage.setItem('amin_judicial_draft_result', result);
      try {
        const account = await getCurrentAccount();
        onCreditsUpdated(account.credits);
        setRefineNote(`اكتملت المهمة المحفوظة. الرصيد المتبقي: ${account.credits}.`);
      } catch {
        setRefineNote('اكتملت مهمة الصياغة المحفوظة.');
      }
    }).catch((err: any) => {
      if (active) setDraftError(err?.message || 'تعذر استعادة مهمة الصياغة المحفوظة.');
    }).finally(() => {
      if (active) setIsLoading(false);
    });
    return () => { active = false; };
  }, [userId]);


  const generateDraft = async () => {
    if (isUploadingDoc) return;
    if (!formData.facts.trim()) {
      setDraftError('يرجى كتابة وقائع الدعوى أو رفع ملف المستندات أولاً.');
      return;
    }

    const availableCredits = getCurrentStoredCredits();
    if (availableCredits <= 0) {
      if (onOpenSubscribe) onOpenSubscribe();
      return;
    }

    setIsLoading(true);
    setRefineNote('');
    setDraftError('');
    setGeneratedBrief('');
    try {
      const aiText = await draftCounterBrief({
        ...formData,
        judicialWorkType: formData.judicialWorkType === '__custom__' ? '' : formData.judicialWorkType,
        customJudicialWorkType: formData.customJudicialWorkType,
        userId,
      }, (chunk) => {
        setGeneratedBrief((current) => current + chunk);
      });
      if (aiText) {
        setGeneratedBrief(aiText);
        persistentStorage.setItem('amin_judicial_draft_result', aiText);
        try {
          const account = await getCurrentAccount();
          onCreditsUpdated(account.credits);
          setRefineNote(`تم تحديث الرصيد. المتبقي: ${account.credits}.`);
        } catch {
          setRefineNote('تمت العملية بنجاح.');
        }
      }
    } catch (err: any) {
      console.warn('Draft error:', err);
      const rawMessage = String(err?.message || '');
      const looksLikeNetworkFailure = /failed to fetch|network request failed|networkerror|load failed|fetch failed/i.test(rawMessage);
      if (looksLikeNetworkFailure) {
        const partialText = persistentStorage.getItem('amin_judicial_draft_result', '');
        setDraftError(partialText
          ? 'انقطع الاتصال أثناء التوليد. تم الاحتفاظ بالجزء الذي وصل بالفعل؛ راجعه قبل إعادة المحاولة حتى لا تكرر طلباً أو تستهلك رصيداً إضافياً.'
          : 'انقطع الاتصال أثناء التوليد قبل وصول النتيجة. تحقق من الاتصال قبل إعادة المحاولة لتجنب تكرار الطلب.');
      } else {
        setDraftError(err?.message || 'تعذر استكمال الصياغة حالياً.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleRefine = async (type: 'moreDecisive' | 'addPrecedents' | 'addProceduralDefenses' | 'auditCheck') => {
    if (!generatedBrief) return;
    setIsRefining(true);
    setRefineNote('');
    const previousDraft = generatedBrief;
    setGeneratedBrief('');
    try {
      const refined = await refineDraftText(previousDraft, type, (chunk) => {
        setGeneratedBrief((current) => current + chunk);
      }, userId);
      if (refined) {
        setGeneratedBrief(refined);
        persistentStorage.setItem('amin_judicial_draft_result', refined);
        const notes: Record<string, string> = {
          moreDecisive: 'تم تعزيز العبارات القضائية وجعل الصياغة أكثر حسماً.',
          addPrecedents: 'تم تدعيم المذكرة بأحدث مبادئ وأحكام محكمة النقض المصرية.',
          addProceduralDefenses: 'تم إدراج الدفوع الشكلية والإجرائية المتعلقة بالنظام العام.',
          auditCheck: 'تم تدقيق التماسك اللغوي والقانوني واكتمال الطلبات الختامية.',
        };
        setRefineNote(notes[type] || 'تم تحسين المسودة بنجاح.');
      }
    } catch (err: any) {
      console.warn('Refine attempt handled silently:', err);
    } finally {
      setIsRefining(false);
    }
  };

  const copyToClipboard = async () => {
    if (!generatedBrief) return;
    const ok = await copyTextSafely(generatedBrief);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const exportToWord = () => {
    if (!generatedBrief) return;
    const briefTitle = formData.briefType || 'مذكرة_قضائية';
    exportLegalDocToWord(generatedBrief, briefTitle);
  };

  const handlePrintPdfDirectly = () => {
    window.print();
  };

  const shareBrief = async () => {
    if (!generatedBrief) return;
    await shareLegalDoc(generatedBrief, 'صياغة قضائية معتمدة', () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-3 sm:py-5 space-y-4 sm:space-y-5" style={{ fontFamily: 'Cairo, sans-serif' }}>
      {/* Top Judicial Action Bar */}
      <div className="bg-[#0f172a] border-2 border-[#b45309] rounded-2xl p-4 shadow-xl flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-400">
            <Scale className="w-5 h-5" />
          </div>
          <div>
            <h2 className="font-bold text-white text-sm sm:text-base flex items-center gap-2 flex-wrap">
              <span>الصياغة القضائية الشاملة وإعداد المذكرات</span>
              <span className="text-[11px] bg-amber-950 text-amber-300 px-2 py-0.5 rounded border border-amber-500/40 font-semibold">
                وفق أصول المرافعات المصرية
              </span>
            </h2>
            <p className="text-xs text-slate-400">
              صياغة دقيقة لكافة مذكرات الدفاع، صحف الدعاوى، والطعون بالنقض.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {onSwitchTab && (
            <button
              onClick={() => onSwitchTab('vault')}
              className="px-3 py-1.5 bg-gradient-to-r from-amber-600/30 to-amber-700/40 hover:bg-amber-800 border border-amber-500/60 text-amber-300 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer shadow-sm"
              title="خزينة النماذج القضائية"
            >
              <FolderArchive className="w-4 h-4 text-amber-400" />
              <span>الخزينة ({vaultModelsCount})</span>
            </button>
          )}

          <button
            type="button"
            onClick={clearForm}
            className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white text-xs font-semibold flex items-center gap-1.5 border border-slate-700 transition-all cursor-pointer"
            title="تفريغ الحقول"
          >
            <RotateCcw className="w-3.5 h-3.5 text-slate-400" />
            <span>تفريغ</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 sm:gap-6 items-start">
        {/* Input Panel (5 cols) */}
        <div className="lg:col-span-5 bg-[#0f172a] border border-slate-800 rounded-2xl p-4 sm:p-5 shadow-xl text-white space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <h3 className="font-bold text-white text-sm flex items-center gap-2">
              <FileText className="w-4 h-4 text-[#b45309]" />
              <span>بيانات وموضوع العمل القضائي</span>
            </h3>
            <span className="text-[11px] text-amber-300 bg-[#b45309]/20 px-2 py-0.5 rounded border border-[#b45309]/40 font-semibold">
              إعداد القضية
            </span>
          </div>

          {/* Immediate Auto-Paste File Upload Zone */}
          <FileUploadZone
            onProcessingChange={setIsUploadingDoc}
            onTextExtracted={(extractedText, fileName) => {
              const trimmed = extractedText.trim();
              if (!trimmed) return;
              setFormData((prev) => {
                const updatedFacts = prev.facts
                  ? `${prev.facts}\n\n========================================\n[مستند: ${fileName}]:\n${trimmed}`
                  : trimmed;
                persistentStorage.setJSON('amin_judicial_draft_form', { ...prev, facts: updatedFacts });
                return {
                  ...prev,
                  facts: updatedFacts,
                };
              });
              setUploadedDocName((prev) => {
                const updated = prev ? `${prev} | ${fileName}` : fileName;
                persistentStorage.setItem('amin_judicial_draft_docname', updated);
                return updated;
              });
            }}
            title="إدراج مستندات القضية (Word / PDF / صور)"
            description="ارفع عقود أو إنذارات أو محاضر شرطة ليتم استخراج نصوصها وإدراجها فوراً."
          />

          {uploadedDocName && (
            <div className="flex items-center justify-between bg-emerald-950/60 border border-emerald-500/40 rounded-xl px-3 py-2 text-xs text-emerald-300">
              <span className="font-semibold truncate">المستند: {uploadedDocName}</span>
              <button
                type="button"
                onClick={() => {
                  setUploadedDocName('');
                  setFormData((prev) => {
                    const updated = { ...prev, facts: '' };
                    persistentStorage.setJSON('amin_judicial_draft_form', updated);
                    return updated;
                  });
                  persistentStorage.removeItem('amin_judicial_draft_docname');
                }}
                className="text-rose-400 hover:text-rose-300 text-[11px] font-bold underline cursor-pointer ml-2 flex-shrink-0"
              >
                حذف المستند
              </button>
            </div>
          )}

          {/* General Judicial Task Selector — no manual template selection */}
          <div className="bg-slate-900/90 border border-amber-600/40 rounded-xl p-3.5 space-y-3 text-xs">
            <div className="flex items-center justify-between">
              <label className="block text-xs font-bold text-amber-300 flex items-center gap-1.5">
                <Scale className="w-4 h-4 text-amber-400" />
                <span>ماذا تريد أن يكتب أو يفعل المساعد؟</span>
              </label>
              <span className="text-[10px] bg-amber-500/20 text-amber-300 px-2 py-0.5 rounded border border-amber-500/30 font-bold">
                يختار المرجع تلقائياً
              </span>
            </div>

            <select
              value={formData.judicialWorkType || ''}
              onChange={(e) => {
                const val = e.target.value;
                if (val === '__custom__') {
                  setFormData((prev) => ({
                    ...prev,
                    judicialWorkType: '__custom__',
                  }));
                } else {
                  const roleHint = judicialWorkCategories[0].options.find((o) => o.id === val)?.roleHint || '';
                  setFormData((prev) => ({
                    ...prev,
                    judicialWorkType: val,
                    briefType: val,
                    clientRole: (!prev.clientRole || prev.clientRole === 'مدعى عليه') && roleHint ? roleHint : prev.clientRole,
                  }));
                }
              }}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2.5 text-xs text-white focus:outline-none focus:border-[#b45309] cursor-pointer"
            >
              <option value="">-- اختر المهمة العامة أو اتركها للتحديد التلقائي --</option>
              {judicialWorkCategories[0].options.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>

            {(formData.judicialWorkType === '__custom__' || formData.customJudicialWorkType) && (
              <div className="bg-gradient-to-r from-amber-950/60 via-slate-900 to-amber-950/60 border-2 border-amber-500/60 rounded-xl p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-bold text-amber-300 flex items-center gap-1.5">
                    <Edit3 className="w-3.5 h-3.5 text-amber-400" />
                    <span>اكتب المهمة المطلوبة بالتحديد:</span>
                  </label>
                  <span className="text-[10px] text-amber-200 bg-amber-900/80 px-2 py-0.5 rounded border border-amber-500/50 font-semibold">
                    مهمة مخصصة
                  </span>
                </div>
                <input
                  type="text"
                  value={formData.customJudicialWorkType || ''}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      customJudicialWorkType: e.target.value,
                      judicialWorkType: '__custom__',
                      briefType: e.target.value || prev.briefType,
                    }))
                  }
                  placeholder="مثال: إعداد طلب عارض أو الرد على مستند محدد..."
                  className="w-full bg-slate-950 border border-amber-400/60 rounded-lg p-2.5 text-xs text-white placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-amber-400"
                />
              </div>
            )}

            <p className="text-[11px] text-slate-400 leading-relaxed">
              لا تحتاج إلى اختيار نموذج. بعد تحديد المهمة، يفحص المساعد خزنة حسابك فقط ويستخدم النموذج المطابق أو الأقرب إن كان مفيداً، وإلا يكتب من الصفر.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div>
              <label className="block text-[11px] font-bold text-slate-300 mb-1">المحكمة المختصة:</label>
              <input
                type="text"
                value={formData.courtType}
                onChange={(e) => setFormData({ ...formData, courtType: e.target.value })}
                placeholder="محكمة استئناف القاهرة..."
                className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-[#b45309]"
              />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-slate-300 mb-1">وصف المهمة / عنوان العمل:</label>
              <input
                type="text"
                value={formData.briefType}
                onChange={(e) => setFormData({ ...formData, briefType: e.target.value })}
                placeholder="اختياري: وصف مختصر للمهمة الحالية..."
                className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-[#b45309]"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div>
              <label className="block text-[11px] font-bold text-slate-300 mb-1">الدائرة:</label>
              <input
                type="text"
                value={formData.circuit}
                onChange={(e) => setFormData({ ...formData, circuit: e.target.value })}
                placeholder="الدائرة (7) مدني..."
                className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-xs text-white focus:outline-none focus:border-[#b45309]"
              />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-slate-300 mb-1">رقم الدعوى والسنة:</label>
              <input
                type="text"
                value={formData.caseNumber}
                onChange={(e) => setFormData({ ...formData, caseNumber: e.target.value })}
                placeholder="مثال: 1420 لسنة 2024..."
                className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-xs text-white focus:outline-none focus:border-[#b45309]"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div>
              <label className="block text-[11px] font-bold text-slate-300 mb-1">اسم الموكل وصفته:</label>
              <input
                type="text"
                value={formData.clientName}
                onChange={(e) => setFormData({ ...formData, clientName: e.target.value })}
                placeholder="السيد / ... (مدعى عليه)..."
                className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-xs text-white focus:outline-none focus:border-[#b45309]"
              />
            </div>
            <div>
              <label className="block text-[11px] font-bold text-slate-300 mb-1">اسم الخصم وصفته:</label>
              <input
                type="text"
                value={formData.opponentName}
                onChange={(e) => setFormData({ ...formData, opponentName: e.target.value })}
                placeholder="السيد / ... (المدعي)..."
                className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-xs text-white focus:outline-none focus:border-[#b45309]"
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-bold text-amber-300">وقائع الدعوى:</label>
              <div className="flex items-center gap-2">
                <VoiceDictateButton
                  onTranscript={(text) => {
                    setFormData((prev) => {
                      const updated = {
                        ...prev,
                        facts: prev.facts ? `${prev.facts} ${text}` : text,
                      };
                      persistentStorage.setJSON('amin_judicial_draft_form', updated);
                      return updated;
                    });
                  }}
                  title="إملاء وقائع الدعوى"
                />
                <span className="text-[10px] text-slate-400 font-mono">
                  {formData.facts.length} حرف
                </span>
              </div>
            </div>
            <textarea
              rows={6}
              value={formData.facts}
              onChange={(e) => {
                const val = e.target.value;
                setFormData((prev) => {
                  const updated = { ...prev, facts: val };
                  persistentStorage.setJSON('amin_judicial_draft_form', updated);
                  return updated;
                });
              }}
              className="w-full bg-slate-900 text-white border border-slate-700 rounded-xl p-3 text-xs sm:text-sm leading-relaxed focus:outline-none focus:border-[#b45309] font-sans"
              placeholder="اكتب وقائع الدعوى هنا أو ارفع ملف Word أو PDF..."
            ></textarea>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-bold text-slate-300">أوجه الدفاع والدفوع القانونية:</label>
              <VoiceDictateButton
                onTranscript={(text) => {
                  setFormData((prev) => {
                    const updated = {
                      ...prev,
                      defenses: prev.defenses ? `${prev.defenses} ${text}` : text,
                    };
                    persistentStorage.setJSON('amin_judicial_draft_form', updated);
                    return updated;
                  });
                }}
                title="إملاء الدفوع"
              />
            </div>
            <textarea
              rows={3}
              value={formData.defenses}
              onChange={(e) => {
                const val = e.target.value;
                setFormData((prev) => {
                  const updated = { ...prev, defenses: val };
                  persistentStorage.setJSON('amin_judicial_draft_form', updated);
                  return updated;
                });
              }}
              className="w-full bg-slate-900 text-white border border-slate-700 rounded-xl p-2.5 text-xs leading-relaxed focus:outline-none focus:border-[#b45309]"
              placeholder="الدفع بعدم القبول، التقادم، بطلان الإعلان..."
            ></textarea>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-300 mb-1">الطلبات الختامية:</label>
            <input
              type="text"
              value={formData.requests}
              onChange={(e) => {
                const val = e.target.value;
                setFormData((prev) => {
                  const updated = { ...prev, requests: val };
                  persistentStorage.setJSON('amin_judicial_draft_form', updated);
                  return updated;
                });
              }}
              placeholder="رفض الدعوى وإلزام رافعها المصاريف..."
              className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-xs text-white focus:outline-none focus:border-[#b45309]"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-amber-300 mb-1">تعليمات خاصة للمساعد القضائي:</label>
            <input
              type="text"
              value={formData.customInstructions || ''}
              onChange={(e) => {
                const val = e.target.value;
                setFormData((prev) => {
                  const updated = { ...prev, customInstructions: val };
                  persistentStorage.setJSON('amin_judicial_draft_form', updated);
                  return updated;
                });
              }}
              placeholder="مثال: التركيز على حكم نقض محدد، أسلوب شديد الحزم..."
              className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-xs text-white focus:outline-none focus:border-[#b45309]"
            />
          </div>

          <button
            type="button"
            onClick={generateDraft}
            disabled={isLoading || isUploadingDoc}
            className="w-full py-3.5 px-4 rounded-xl bg-gradient-to-r from-[#b45309] via-amber-600 to-[#b45309] hover:from-amber-600 hover:to-amber-700 text-white font-bold text-sm sm:text-base shadow-xl shadow-[#b45309]/30 border border-amber-400/50 flex items-center justify-center gap-2 transition-all disabled:opacity-50 cursor-pointer active:scale-[0.98]"
          >
            {isUploadingDoc ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin text-amber-200" />
                <span>جارٍ معالجة المستند...</span>
              </>
            ) : isLoading ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin text-amber-200" />
                <span>جارٍ الصياغة القضائية المكتملة...</span>
              </>
            ) : (
              <>
                <Sparkles className="w-5 h-5 text-amber-200" />
                <span>الصياغة القانونية</span>
              </>
            )}
          </button>
          {vaultModelsCount === 0 && (
            <div role="status" className="mt-2 rounded-lg border border-amber-500/40 bg-amber-950/30 px-3 py-2 text-xs leading-relaxed text-amber-200">
              تنبيه: لا توجد نماذج شخصية محفوظة في خزنة هذا الحساب. لن يبدأ التوليد حتى تضيف نموذجاً من مكتبتك، وذلك لمنع إنشاء صياغة عامة على أنها مستند مستند إلى أسلوبك.
            </div>
          )}
        </div>

        {/* Output Panel (7 cols) */}
        <div className="lg:col-span-7 flex flex-col gap-3">
          <div className="bg-[#0f172a] border-2 border-[#b45309] rounded-2xl p-4 sm:p-5 shadow-2xl flex-1 flex flex-col min-h-[520px] sm:min-h-[680px]">
            <div className="flex flex-wrap items-center justify-between gap-3 pb-3 mb-3 border-b border-slate-800">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-emerald-950/80 border border-emerald-500/40 flex items-center justify-center text-emerald-400">
                  <FileCheck2 className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-bold text-white text-base flex items-center gap-2">
                    <span>المحرر القضائي النهائي</span>
                    <span className="text-[10px] bg-amber-950/80 text-amber-300 px-2 py-0.5 rounded border border-amber-500/40 font-semibold">
                      جاهز للإيداع والطباعة
                    </span>
                  </h3>
                  {generatedBrief && (
                    <span className="text-[11px] text-slate-400">
                      {generatedBrief.split(/\s+/).filter(Boolean).length} كلمة | {generatedBrief.length} حرف
                    </span>
                  )}
                </div>
              </div>

              {generatedBrief && (
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={copyToClipboard}
                    className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer border border-slate-700 shadow-sm"
                    title="نسخ"
                  >
                    {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copied ? 'تم النسخ!' : 'نسخ النص'}</span>
                  </button>
                  <button
                    onClick={exportToWord}
                    className="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-bold flex items-center gap-1.5 shadow-md transition-colors cursor-pointer"
                    title="تصدير بصيغة Word (.doc)"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>تصدير Word (.doc)</span>
                  </button>
                  <button
                    onClick={handlePrintPdfDirectly}
                    className="px-3 py-1.5 rounded-lg bg-[#b45309] hover:bg-amber-600 text-white text-xs font-bold flex items-center gap-1.5 shadow-md transition-colors cursor-pointer"
                    title="طباعة / PDF"
                  >
                    <Printer className="w-3.5 h-3.5" />
                    <span>طباعة / PDF</span>
                  </button>
                </div>
              )}
            </div>

            {generatedBrief && (
              <AppliedRulesAuditBadge
                workType={formData.customJudicialWorkType || formData.judicialWorkType || formData.briefType || 'مذكرة بدفاع'}
                courtType={formData.courtType}
                circuit={formData.circuit}
                customInstructions={formData.customInstructions}
              />
            )}

            {/* Quick Refinements Bar */}
            {generatedBrief && (
              <div className="bg-slate-900 border border-slate-700 rounded-xl p-2.5 mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-xs text-amber-300 font-bold">
                  <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                  <span>تحسينات فورية بنقرة واحدة:</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    onClick={() => handleRefine('moreDecisive')}
                    disabled={isRefining}
                    className="text-xs px-2.5 py-1 rounded bg-slate-800 hover:bg-[#b45309]/40 border border-slate-700 text-slate-200 cursor-pointer disabled:opacity-50"
                  >
                    أكثر حسماً وقوة
                  </button>
                  <button
                    onClick={() => handleRefine('addPrecedents')}
                    disabled={isRefining}
                    className="text-xs px-2.5 py-1 rounded bg-slate-800 hover:bg-[#b45309]/40 border border-slate-700 text-slate-200 cursor-pointer disabled:opacity-50"
                  >
                    تعزيز بأحكام النقض
                  </button>
                  <button
                    onClick={() => handleRefine('addProceduralDefenses')}
                    disabled={isRefining}
                    className="text-xs px-2.5 py-1 rounded bg-slate-800 hover:bg-[#b45309]/40 border border-slate-700 text-slate-200 cursor-pointer disabled:opacity-50"
                  >
                    إضافة دفوع شكلية
                  </button>
                  <button
                    onClick={() => handleRefine('auditCheck')}
                    disabled={isRefining}
                    className="text-xs px-2.5 py-1 rounded bg-emerald-950 hover:bg-emerald-900 border border-emerald-600/40 text-emerald-200 cursor-pointer disabled:opacity-50"
                  >
                    تدقيق شامل
                  </button>
                </div>
              </div>
            )}

            {refineNote && (
              <div className="bg-emerald-950/70 border border-emerald-500/40 rounded-lg px-3 py-2 text-xs text-emerald-200 mb-3 flex items-center gap-2 animate-in fade-in">
                <ShieldCheck className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                <span>{refineNote}</span>
              </div>
            )}

            {generatedBrief && (
              <div className="bg-[#1e293b] border border-slate-700 rounded-xl p-2.5 mb-3 flex flex-wrap items-center justify-between gap-3 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-slate-300 font-bold flex items-center gap-1">
                    <Type className="w-3.5 h-3.5 text-amber-400" />
                    نوع الخط:
                  </span>
                  <div className="bg-slate-900 p-0.5 rounded-lg border border-slate-700 flex">
                    <button
                      type="button"
                      onClick={() => setFontFamily('traditional')}
                      className={`px-3 py-1 rounded text-xs transition-all cursor-pointer ${
                        fontFamily === 'traditional'
                          ? 'bg-[#b45309] text-white font-bold shadow'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      Traditional Arabic
                    </button>
                    <button
                      type="button"
                      onClick={() => setFontFamily('amiri')}
                      className={`px-3 py-1 rounded text-xs transition-all cursor-pointer ${
                        fontFamily === 'amiri'
                          ? 'bg-[#b45309] text-white font-bold shadow'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      Amiri (النسخ)
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1">
                    <span className="text-slate-300 font-bold">الحجم:</span>
                    <div className="flex items-center bg-slate-900 border border-slate-700 rounded-lg p-0.5">
                      <button
                        type="button"
                        onClick={() => setFontSizePt((prev) => Math.max(14, prev - 1))}
                        className="p-1 hover:bg-slate-800 rounded text-slate-300 cursor-pointer"
                        title="تصغير"
                      >
                        <ZoomOut className="w-3.5 h-3.5" />
                      </button>
                      <span className="px-2 text-xs font-bold text-amber-300 min-w-[2.5rem] text-center font-mono">
                        {fontSizePt}pt
                      </span>
                      <button
                        type="button"
                        onClick={() => setFontSizePt((prev) => Math.min(26, prev + 1))}
                        className="p-1 hover:bg-slate-800 rounded text-slate-300 cursor-pointer"
                        title="تكبير"
                      >
                        <ZoomIn className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => setIsLiveEditing(!isLiveEditing)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
                      isLiveEditing
                        ? 'bg-amber-600 text-white shadow'
                        : 'bg-slate-800 text-slate-300 hover:text-white border border-slate-700'
                    }`}
                  >
                    {isLiveEditing ? <Eye className="w-3.5 h-3.5" /> : <Edit3 className="w-3.5 h-3.5" />}
                    <span>{isLiveEditing ? 'معاينة القراءة' : 'تعديل النص مباشرة'}</span>
                  </button>
                </div>
              </div>
            )}

            <div className="flex-1 bg-[#1e293b] border-2 border-slate-700/80 rounded-2xl p-4 sm:p-6 overflow-y-auto max-h-[850px] shadow-inner text-slate-100 relative">
              {isLoading ? (
                <div className="h-full flex flex-col items-center justify-center py-24 sm:py-28 text-center gap-4">
                  <div className="w-16 h-16 rounded-2xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-400 animate-pulse">
                    <Scale className="w-8 h-8" />
                  </div>
                  <div>
                    <h4 className="text-white font-bold text-base mb-1">
                      جارٍ صياغة العمل القضائي وفق الأصول المصرية...
                    </h4>
                    <p className="text-xs text-slate-400 max-w-md">
                      تطبيق نصوص القانون وأحكام النقض ومحاكاة نموذجك المختار.
                    </p>
                  </div>
                  <Loader2 className="w-6 h-6 animate-spin text-amber-400 mt-2" />
                </div>
              ) : generatedBrief ? (
                isLiveEditing ? (
                  <textarea
                    rows={26}
                    value={generatedBrief}
                    onChange={(e) => {
                      setGeneratedBrief(e.target.value);
                      persistentStorage.setItem('amin_judicial_draft_result', e.target.value);
                    }}
                    className="w-full p-4 border border-amber-500/60 rounded-xl text-white bg-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-500 font-sans"
                    style={{
                      fontSize: `${fontSizePt}pt`,
                      lineHeight: 2.2,
                    }}
                  ></textarea>
                ) : (
                  <div
                    className="text-slate-100 whitespace-pre-wrap text-justify tracking-wide leading-[2.4] select-text selection:bg-amber-500/40 selection:text-white"
                    style={{
                      fontFamily:
                        fontFamily === 'traditional'
                          ? "'Traditional Arabic', 'Amiri', serif"
                          : "'Amiri', serif",
                      fontSize: `${fontSizePt}pt`,
                    }}
                  >
                    {generatedBrief}
                  </div>
                )
              ) : draftError ? (
                <div className="h-full flex flex-col items-center justify-center py-16 sm:py-20 text-center gap-3 max-w-md mx-auto">
                  <div className="w-14 h-14 rounded-2xl bg-rose-950/60 border border-rose-500/50 flex items-center justify-center text-rose-400">
                    <AlertTriangle className="w-8 h-8" />
                  </div>
                  <h4 className="text-base font-bold text-rose-300">
                    تعذر إتمام الصياغة
                  </h4>
                  <p className="text-xs text-rose-200/90 leading-relaxed bg-rose-950/40 p-3 rounded-xl border border-rose-900">
                    {draftError}
                  </p>
                  <button
                    type="button"
                    onClick={generateDraft}
                    className="mt-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-amber-300 border border-slate-600 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>إعادة المحاولة</span>
                  </button>
                </div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center py-24 sm:py-28 text-center text-slate-400 gap-3">
                  <FileText className="w-14 h-14 text-slate-600" />
                  <h4 className="text-base font-bold text-slate-300">
                    نص العمل القضائي سيظهر هنا
                  </h4>
                  <p className="text-xs max-w-md leading-relaxed text-slate-400">
                    املأ البيانات والوقائع على اليمين ثم اضغط زر الصياغة القضائية لإنشاء المذكرة كاملة.
                  </p>
                </div>
              )}
            </div>

            {generatedBrief && (
              <div className="bg-slate-900/90 border border-slate-700/80 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3 shadow-md">
                <div className="flex items-center gap-2 text-xs text-emerald-300 font-bold">
                  <Sparkles className="w-4 h-4 text-emerald-400" />
                  <span>خيارات التصدير:</span>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={copyToClipboard}
                    className="px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer border border-slate-600 shadow"
                    title="نسخ النص"
                  >
                    {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-amber-300" />}
                    <span>{copied ? 'تم النسخ!' : 'نسخ النص'}</span>
                  </button>
                  <button
                    onClick={shareBrief}
                    className="px-3.5 py-1.5 rounded-lg bg-blue-700 hover:bg-blue-600 text-white text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer shadow border border-blue-500/50"
                    title="مشاركة"
                  >
                    <Share2 className="w-3.5 h-3.5" />
                    <span>مشاركة</span>
                  </button>
                  <button
                    onClick={exportToWord}
                    className="px-3.5 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-bold flex items-center gap-1.5 shadow transition-all cursor-pointer"
                    title="تصدير بصيغة Word"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>تصدير Word</span>
                  </button>
                  <button
                    onClick={handlePrintPdfDirectly}
                    className="px-3.5 py-1.5 rounded-lg bg-[#b45309] hover:bg-amber-600 text-white text-xs font-bold flex items-center gap-1.5 shadow transition-all cursor-pointer"
                    title="طباعة"
                  >
                    <Printer className="w-3.5 h-3.5" />
                    <span>طباعة</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
