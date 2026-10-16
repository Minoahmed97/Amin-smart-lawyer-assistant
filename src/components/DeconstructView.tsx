import { getCurrentAccount } from '../services/authService.ts';
import React, { useState, useEffect } from 'react';
import { deconstructBrief, resumeSavedAiTask } from '../services/aiService.ts';
import { getCurrentStoredCredits } from '../utils/deviceFingerprint.ts';
import { FileUploadZone } from './FileUploadZone.tsx';
import { StyleTemplateSelector } from './StyleTemplateSelector.tsx';
import { VoiceDictateButton } from './VoiceDictateButton.tsx';
import { StyleTemplate, DEFAULT_STYLE_TEMPLATES } from '../data/styleTemplates.ts';
import { AppliedRulesAuditBadge } from './AppliedRulesAuditBadge.tsx';
import { persistentStorage } from '../utils/persistentStorage.ts';
import {
  ShieldAlert,
  Loader2,
  Copy,
  Check,
  Printer,
  RotateCcw,
  FileCheck,
  Crosshair,
  Table,
  FileText,
  ListOrdered,
  ZoomIn,
  ZoomOut,
  Download,
  Sparkles,
  Scale,
  ArrowRight,
  Share2,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react';
import { copyTextSafely, shareLegalDoc } from '../utils/clipboardHelper.ts';
import { exportLegalDocToWord } from '../utils/exportHelper.ts';

interface DeconstructViewProps {
  userId: string;
  onSwitchTab?: (tab: 'draft' | 'deconstruct' | 'qualify' | 'defenses' | 'packages' | 'vault') => void;
  onOpenSubscribe?: () => void;
  onCreditsUpdated?: (newCredits: number) => void;
  onTransferToDrafting?: (facts: string, defenses: string, caseNature?: string, responseWorkType?: string) => void;
}

export const DeconstructView: React.FC<DeconstructViewProps> = ({
  userId,
  onSwitchTab,
  onOpenSubscribe,
  onCreditsUpdated,
  onTransferToDrafting,
}) => {
  const [opponentBriefText, setOpponentBriefText] = useState<string>(() => {
    return persistentStorage.getItem('judicial_deconstruct_brief', '');
  });
  const [courtType, setCourtType] = useState<string>(() => {
    return persistentStorage.getItem('judicial_deconstruct_court', '');
  });
  const [caseNature, setCaseNature] = useState<string>(() => {
    return persistentStorage.getItem('judicial_deconstruct_nature', '');
  });
  const [responseWorkType, setResponseWorkType] = useState<string>(() => {
    return persistentStorage.getItem('judicial_deconstruct_response_work_type', '__smart__') || '__smart__';
  });
  const [ourPosition, setOurPosition] = useState<string>(() => {
    return persistentStorage.getItem('judicial_deconstruct_position', '');
  });
  const [additionalFacts, setAdditionalFacts] = useState<string>(() => {
    return persistentStorage.getItem('judicial_deconstruct_addfacts', '');
  });
  const [analysisResult, setAnalysisResult] = useState<string>(() => {
    return persistentStorage.getItem('judicial_deconstruct_result', '');
  });
  const [uploadedDocName, setUploadedDocName] = useState<string>(() => {
    return persistentStorage.getItem('judicial_deconstruct_docname', '');
  });
  const [selectedTemplate, setSelectedTemplate] = useState<StyleTemplate>(DEFAULT_STYLE_TEMPLATES[0]);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isUploadingDoc, setIsUploadingDoc] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const [activeOutputTab, setActiveOutputTab] = useState<'full' | 'counterBrief' | 'analysis' | 'table'>('full');
  const [fontFamily, setFontFamily] = useState<'traditional' | 'amiri'>('traditional');
  const [fontSizePt, setFontSizePt] = useState<number>(18);
  const [isLiveEditing, setIsLiveEditing] = useState<boolean>(false);

  useEffect(() => {
    persistentStorage.setItem('judicial_deconstruct_brief', opponentBriefText);
  }, [opponentBriefText]);
  useEffect(() => {
    persistentStorage.setItem('judicial_deconstruct_court', courtType);
  }, [courtType]);
  useEffect(() => {
    persistentStorage.setItem('judicial_deconstruct_nature', caseNature);
  }, [caseNature]);
  useEffect(() => {
    persistentStorage.setItem('judicial_deconstruct_response_work_type', responseWorkType);
  }, [responseWorkType]);
  useEffect(() => {
    persistentStorage.setItem('judicial_deconstruct_position', ourPosition);
  }, [ourPosition]);
  useEffect(() => {
    persistentStorage.setItem('judicial_deconstruct_addfacts', additionalFacts);
  }, [additionalFacts]);
  useEffect(() => {
    persistentStorage.setItem('judicial_deconstruct_result', analysisResult);
  }, [analysisResult]);
  useEffect(() => {
    persistentStorage.setItem('judicial_deconstruct_docname', uploadedDocName);
  }, [uploadedDocName]);

  const clearAllFields = () => {
    setOpponentBriefText('');
    setCourtType('');
    setCaseNature('');
    setResponseWorkType('__smart__');
    setOurPosition('');
    setAdditionalFacts('');
    setAnalysisResult('');
    setUploadedDocName('');
    persistentStorage.removeItem('judicial_deconstruct_brief');
    persistentStorage.removeItem('judicial_deconstruct_worktype');
    persistentStorage.removeItem('judicial_deconstruct_court');
    persistentStorage.removeItem('judicial_deconstruct_nature');
    persistentStorage.removeItem('judicial_deconstruct_response_work_type');
    persistentStorage.removeItem('judicial_deconstruct_position');
    persistentStorage.removeItem('judicial_deconstruct_addfacts');
    persistentStorage.removeItem('judicial_deconstruct_result');
    persistentStorage.removeItem('judicial_deconstruct_docname');
  };

  const [deconstructError, setDeconstructError] = useState<string>('');

  // استرجاع مهمة ذكاء اصطناعي محفوظة مسبقاً إذا تم إعادة فتح الواجهة
  useEffect(() => {
    let active = true;
    let jobId = '';
    try {
      jobId = localStorage.getItem(`amin_ai_job_deconstruct_${String(userId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_')}`) || '';
    } catch {}
    if (!jobId) return () => { active = false; };
    setIsLoading(true);
    setAnalysisResult('');
    setDeconstructError('');
    void resumeSavedAiTask('deconstruct', jobId, (chunk) => {
      if (active) setAnalysisResult((current) => current + chunk);
    }, userId).then((result) => {
      if (!active) return;
      setAnalysisResult(result);
      persistentStorage.setItem('judicial_deconstruct_result', result);
    }).catch((err: any) => {
      if (active) setDeconstructError(err?.message || 'تعذر استعادة المهمة المحفوظة.');
    }).finally(() => {
      if (active) setIsLoading(false);
    });
    return () => { active = false; };
  }, [userId]);

  const handleDeconstruct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isUploadingDoc) return;
    if (!opponentBriefText.trim()) {
      setDeconstructError('يرجى لصق نص مذكرة الخصم أو رفع مستند Word أو PDF.');
      return;
    }

    const availableCredits = getCurrentStoredCredits();
    if (availableCredits <= 0) {
      if (onOpenSubscribe) onOpenSubscribe();
      return;
    }

    setIsLoading(true);
    setDeconstructError('');
    setAnalysisResult('');
    try {
      const result = await deconstructBrief({
        opponentBriefText,
        courtType,
        caseNature,
        judicialWorkType: responseWorkType === '__smart__' ? '' : responseWorkType,
        ourPosition,
        additionalFacts,
        userId,
      }, (chunk) => {
        setAnalysisResult((current) => current + chunk);
      });
      if (result) {
        setAnalysisResult(result);
        try {
          const account = await getCurrentAccount();
          if (onCreditsUpdated) onCreditsUpdated(account.credits);
        } catch {}
      }
    } catch (err: any) {
      console.warn('Deconstruct error:', err);
      setDeconstructError(err?.message || 'تعذر استكمال تفكيك المذكرة.');
    } finally {
      setIsLoading(false);
    }
  };

  const extractTableSection = (text: string) => {
    const lines = text.split('\n');
    const tableLines = lines.filter((l) => l.trim().startsWith('|'));
    if (tableLines.length > 1) {
      return tableLines.join('\n');
    }
    return '';
  };

  const extractCounterBrief = (text: string) => {
    const markers = [
      '2- [المذكرة المقابلة المقترحة]:',
      '[المذكرة المقابلة المقترحة]:',
      'باسم الشعب',
      'مذكرة بدفاع'
    ];
    for (const m of markers) {
      const idx = text.indexOf(m);
      if (idx !== -1) {
        return text.substring(idx);
      }
    }
    return text;
  };

  const extractDeconstructOnly = (text: string) => {
    const markers = [
      '12- [المذكرة المقابلة المقترحة]:',
      '12- المذكرة المقابلة المقترحة:',
      '2- [المذكرة المقابلة المقترحة]:',
      '[المذكرة المقابلة المقترحة]:',
    ];
    const indexes = markers
      .map((marker) => text.indexOf(marker))
      .filter((idx) => idx !== -1);
    const idx = indexes.length ? Math.min(...indexes) : -1;
    if (idx !== -1) {
      return text.substring(0, idx).trim();
    }
    return text;
  };

  const extractProposedWorkType = (text: string) => {
    const match = text.match(/(?:نوع العمل القضائي المقابل المقترح|نوع المستند المقابل المقترح)\s*[:：-]\s*([^\n]+)/i);
    return match?.[1]?.trim() || '';
  };

  const displayedContent = () => {
    if (activeOutputTab === 'counterBrief') {
      return extractCounterBrief(analysisResult);
    }
    if (activeOutputTab === 'analysis') {
      return extractDeconstructOnly(analysisResult);
    }
    if (activeOutputTab === 'table') {
      const tbl = extractTableSection(analysisResult);
      return tbl || analysisResult;
    }
    return analysisResult;
  };

  const copyResult = async () => {
    const textToCopy = displayedContent();
    if (!textToCopy) return;
    const ok = await copyTextSafely(textToCopy);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const exportToWord = () => {
    const content = displayedContent();
    if (!content) return;
    exportLegalDocToWord(content, 'تقرير_تفكيك_مذكرة_الخصم');
  };

  const handlePrint = () => {
    window.print();
  };

  const shareResult = async () => {
    const shareText = displayedContent();
    if (!shareText) return;
    await shareLegalDoc(shareText, 'تقرير التفنيد والرد على المستندات', () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-3 sm:py-5 space-y-4 sm:space-y-5" style={{ fontFamily: 'Cairo, sans-serif' }}>
      {/* Top Judicial Banner */}
      <div className="bg-[#0f172a] border-2 border-[#b45309] rounded-2xl p-4 sm:p-5 shadow-xl">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-start gap-3.5">
            <div className="w-11 h-11 sm:w-12 sm:h-12 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-400 flex-shrink-0">
              <Crosshair className="w-5 h-5 sm:w-6 sm:h-6 text-amber-400" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-base sm:text-xl font-bold text-white">
                  التفنيد والرد على المستندات
                </h2>
                <span className="text-[11px] bg-[#b45309]/30 text-amber-300 px-2 py-0.5 rounded border border-[#b45309] font-semibold">
                  تحليل استراتيجي متقدم
                </span>
                <span className="text-[11px] bg-emerald-950 text-emerald-300 px-2 py-0.5 rounded border border-emerald-500 font-semibold">
                  صياغة الرد المقابل فوراً
                </span>
              </div>
              <p className="text-xs sm:text-sm text-slate-300 mt-1">
                الصق نص المستند أو ارفعه بصيغة Word أو PDF، وسيقوم المساعد بتفنيد محتواه واستخراج نقاط الضعف وإعداد الرد القانوني المناسب.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={clearAllFields}
              className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-rose-950 text-slate-200 hover:text-rose-200 text-xs font-semibold flex items-center gap-1.5 border border-slate-700 hover:border-rose-500/50 transition-colors whitespace-nowrap cursor-pointer"
              title="تفريغ الحقول"
            >
              <RotateCcw className="w-4 h-4 text-slate-400" />
              <span>تفريغ الحقول</span>
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 sm:gap-6 items-start">
        {/* Input Panel (5 cols) */}
        <div className="lg:col-span-5 bg-[#0f172a] border border-slate-800 rounded-2xl p-4 sm:p-5 shadow-xl text-white space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <h3 className="font-bold text-white text-sm flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-[#b45309]" />
              <span>مذكرة الخصم وبيانات القضية</span>
            </h3>
            <span className="text-[11px] text-amber-300 bg-amber-950/60 px-2 py-0.5 rounded border border-amber-500/30">
              بيانات الإدخال
            </span>
          </div>

          <FileUploadZone
            onProcessingChange={setIsUploadingDoc}
            onTextExtracted={(text, fileName) => {
              const trimmed = text.trim();
              if (!trimmed) return;
              setOpponentBriefText((prev) => {
                const updated = prev ? `${prev}\n\n========================================\n[مستند: ${fileName}]:\n${trimmed}` : trimmed;
                persistentStorage.setItem('judicial_deconstruct_brief', updated);
                return updated;
              });
              setUploadedDocName((prev) => {
                const updatedDoc = prev ? `${prev} | ${fileName}` : fileName;
                persistentStorage.setItem('judicial_deconstruct_docname', updatedDoc);
                return updatedDoc;
              });
            }}
            title="رفع مذكرة الخصم (Word / PDF / صور)"
            description="يدعم ملفات Word القديمة والحديثة والمستندات المصورة بدقة 100%."
          />

          {uploadedDocName && (
            <div className="flex items-center justify-between bg-emerald-950/60 border border-emerald-500/40 rounded-xl px-3 py-2 text-xs text-emerald-300">
              <span className="font-semibold truncate">الملف المرفق: {uploadedDocName}</span>
              <button
                type="button"
                onClick={() => {
                  setUploadedDocName('');
                  setOpponentBriefText('');
                  persistentStorage.removeItem('judicial_deconstruct_brief');
                  persistentStorage.removeItem('judicial_deconstruct_docname');
                }}
                className="text-rose-400 hover:text-rose-300 text-[11px] font-bold underline cursor-pointer ml-2 flex-shrink-0"
              >
                حذف المستند
              </button>
            </div>
          )}

          <form onSubmit={handleDeconstruct} className="space-y-4 text-sm">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-bold text-amber-300">
                  نص مذكرة أو طلبات الخصم:
                </label>
                <div className="flex items-center gap-2">
                  <VoiceDictateButton
                    onTranscript={(text) => {
                      setOpponentBriefText((prev) => {
                        const updated = prev ? `${prev} ${text}` : text;
                        persistentStorage.setItem('judicial_deconstruct_brief', updated);
                        return updated;
                      });
                    }}
                    title="إملاء نص مذكرة الخصم"
                  />
                  <span className="text-[11px] text-slate-400 font-mono">
                    {opponentBriefText.length} حرف
                  </span>
                </div>
              </div>
              <textarea
                rows={8}
                value={opponentBriefText}
                onChange={(e) => setOpponentBriefText(e.target.value)}
                placeholder="الصق نص مذكرة الخصم هنا أو ارفع ملف Word أو PDF أعلاه..."
                className="w-full bg-slate-900 border border-slate-700 rounded-xl p-3 text-white text-xs sm:text-sm font-sans leading-relaxed focus:outline-none focus:border-[#b45309]"
              ></textarea>
            </div>

            <div className="bg-slate-900/90 border border-amber-600/40 rounded-xl p-3 space-y-2">
              <div className="flex items-center justify-between">
                <label className="block text-xs font-bold text-amber-300 flex items-center gap-1.5">
                  <Scale className="w-3.5 h-3.5 text-amber-400" />
                  <span>مهمة التفنيد والرد</span>
                </label>
                <span className="text-[10px] bg-amber-500/20 text-amber-300 px-2 py-0.5 rounded border border-amber-500/30 font-bold">
                  اختيار المرجع تلقائياً
                </span>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                يفحص المساعد خزنة الحساب الحالي تلقائياً بحثاً عن نموذج مطابق أو قريب ومفيد. وإذا لم يجد نموذجاً مناسباً، ينشئ التفنيد والرد من الصفر دون توقف ودون طلب اختيار نموذج.
              </p>
              <div className="mt-3">
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  نوع المستند الذي تريد الرد به:
                </label>
                <select
                  value={responseWorkType}
                  onChange={(e) => setResponseWorkType(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-[#b45309]"
                >
                  <option value="__smart__">تحديد ذكي حسب القضية والمستند</option>
                  <option value="مذكرة رد أو دفوع">مذكرة رد أو دفوع</option>
                  <option value="عريضة أو صحيفة دعوى">عريضة أو صحيفة دعوى</option>
                  <option value="صحيفة طعن">صحيفة طعن</option>
                  <option value="حافظة مستندات">حافظة مستندات</option>
                  <option value="إنذار">إنذار</option>
                  <option value="تعقيب">تعقيب</option>
                  <option value="إجراء أو مستند قانوني آخر">إجراء أو مستند قانوني آخر</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  المحكمة المنظورة أمامها:
                </label>
                <input
                  type="text"
                  value={courtType}
                  onChange={(e) => setCourtType(e.target.value)}
                  placeholder="مثال: محكمة استئناف القاهرة..."
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-[#b45309]"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  موقفنا باختصار (طلب الرد):
                </label>
                <input
                  type="text"
                  value={ourPosition}
                  onChange={(e) => setOurPosition(e.target.value)}
                  placeholder="مثال: رفض الدعوى لعدم الصحة..."
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-[#b45309]"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-semibold text-slate-300">
                  وقائع وأدلة إضافية لصالحنا (اختياري):
                </label>
                <VoiceDictateButton
                  onTranscript={(text) => {
                    setAdditionalFacts((prev) => (prev ? `${prev} ${text}` : text));
                  }}
                  title="إملاء وقائع إضافية"
                />
              </div>
              <textarea
                rows={2}
                value={additionalFacts}
                onChange={(e) => setAdditionalFacts(e.target.value)}
                placeholder="أي مستندات أو إيصالات سداد أو وقائع إضافية ترغب في استخدامها للدفاع..."
                className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-white text-xs focus:outline-none focus:border-[#b45309]"
              ></textarea>
            </div>

            <div className="pt-1">
              <StyleTemplateSelector
                onSelectTemplate={(tmpl) => setSelectedTemplate(tmpl)}
                selectedTemplateId={selectedTemplate.id}
                onExemplarChange={() => {}}
                currentExemplarText={selectedTemplate.content}
              />
            </div>

            <button
              type="submit"
              disabled={isLoading || isUploadingDoc}
              className="w-full py-3.5 px-4 rounded-xl bg-gradient-to-r from-[#b45309] via-amber-600 to-[#b45309] hover:from-amber-600 hover:to-amber-700 text-white font-bold text-sm sm:text-base shadow-xl shadow-[#b45309]/30 border border-amber-400/50 flex items-center justify-center gap-2 transition-all disabled:opacity-50 cursor-pointer active:scale-[0.98]"
            >
              {isUploadingDoc ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin text-amber-200" />
                  <span>جاري معالجة المستند...</span>
                </>
              ) : isLoading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin text-amber-200" />
                  <span>جاري تفنيد المستند وصياغة الرد القضائي...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-5 h-5 text-amber-200" />
                  <span>التفنيد والرد على المستندات</span>
                </>
              )}
            </button>
          </form>
        </div>

        {/* Output Panel (7 cols) */}
        <div className="lg:col-span-7 flex flex-col gap-3">
          <div className="bg-[#0f172a] border-2 border-[#b45309] rounded-2xl p-4 sm:p-5 shadow-2xl flex-1 flex flex-col min-h-[520px] sm:min-h-[680px]">
            <div className="flex flex-wrap items-center justify-between gap-3 pb-3 mb-3 border-b border-slate-800">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg bg-amber-950/80 border border-amber-500/40 flex items-center justify-center text-amber-400">
                  <FileCheck className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-bold text-white text-base">
                    تقرير التفكيك والمذكرة المقابلة
                  </h3>
                  <span className="text-[11px] text-slate-400">
                    استراتيجية الدفاع والمذكرة الجوابية الكاملة
                  </span>
                </div>
              </div>

              {analysisResult && !isLoading && !deconstructError && (
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={copyResult}
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
                    onClick={handlePrint}
                    className="px-3 py-1.5 rounded-lg bg-[#b45309] hover:bg-amber-600 text-white text-xs font-bold flex items-center gap-1.5 shadow-md transition-colors cursor-pointer"
                    title="طباعة / PDF"
                  >
                    <Printer className="w-3.5 h-3.5" />
                    <span>طباعة / PDF</span>
                  </button>
                  {onSwitchTab && (
                    <button
                      onClick={() => {
                        if (onTransferToDrafting) {
                          const selectedResponseType =
                            responseWorkType && responseWorkType !== '__smart__'
                              ? responseWorkType
                              : extractProposedWorkType(analysisResult);
                          onTransferToDrafting(
                            opponentBriefText,
                            extractCounterBrief(analysisResult),
                            caseNature,
                            selectedResponseType,
                          );
                        }
                        onSwitchTab('draft');
                      }}
                      className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-amber-300 text-xs font-bold flex items-center gap-1 border border-slate-700 transition-colors cursor-pointer"
                      title="نقل إلى الصياغة الشاملة"
                    >
                      <span>نقل للصياغة</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              )}
            </div>

            {analysisResult && !isLoading && !deconstructError && (
              <AppliedRulesAuditBadge
                workType="تفنيد مذكرة الخصم والرد عليها"
                courtType={courtType}
                customInstructions="تفكيك ادعاءات الخصم والرد وفق الأصول القضائية"
              />
            )}

            {analysisResult && !isLoading && !deconstructError && (
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-1.5 mb-3 flex flex-wrap items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <button
                    onClick={() => setActiveOutputTab('full')}
                    className={`px-3 py-1.5 rounded-lg font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
                      activeOutputTab === 'full'
                        ? 'bg-[#b45309] text-white shadow'
                        : 'text-slate-300 hover:text-white hover:bg-slate-800'
                    }`}
                  >
                    <ListOrdered className="w-3.5 h-3.5" />
                    <span>التقرير كاملاً</span>
                  </button>
                  <button
                    onClick={() => setActiveOutputTab('counterBrief')}
                    className={`px-3 py-1.5 rounded-lg font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
                      activeOutputTab === 'counterBrief'
                        ? 'bg-emerald-700 text-white shadow'
                        : 'text-slate-300 hover:text-white hover:bg-slate-800'
                    }`}
                  >
                    <FileText className="w-3.5 h-3.5" />
                    <span>المذكرة المقابلة فقط</span>
                  </button>
                  <button
                    onClick={() => setActiveOutputTab('analysis')}
                    className={`px-3 py-1.5 rounded-lg font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
                      activeOutputTab === 'analysis'
                        ? 'bg-rose-700 text-white shadow'
                        : 'text-slate-300 hover:text-white hover:bg-slate-800'
                    }`}
                  >
                    <Crosshair className="w-3.5 h-3.5" />
                    <span>التحليل والتفكيك فقط</span>
                  </button>
                  <button
                    onClick={() => setActiveOutputTab('table')}
                    className={`px-3 py-1.5 rounded-lg font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
                      activeOutputTab === 'table'
                        ? 'bg-blue-700 text-white shadow'
                        : 'text-slate-300 hover:text-white hover:bg-slate-800'
                    }`}
                  >
                    <Table className="w-3.5 h-3.5" />
                    <span>جدول الثغرات</span>
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <div className="flex items-center bg-slate-950 border border-slate-800 rounded-lg p-0.5">
                    <button
                      type="button"
                      onClick={() => setFontSizePt((prev) => Math.max(14, prev - 1))}
                      className="p-1 hover:bg-slate-800 rounded text-slate-300 cursor-pointer"
                    >
                      <ZoomOut className="w-3.5 h-3.5" />
                    </button>
                    <span className="px-2 text-xs font-bold text-amber-300 font-mono">
                      {fontSizePt}pt
                    </span>
                    <button
                      type="button"
                      onClick={() => setFontSizePt((prev) => Math.min(26, prev + 1))}
                      className="p-1 hover:bg-slate-800 rounded text-slate-300 cursor-pointer"
                    >
                      <ZoomIn className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsLiveEditing(!isLiveEditing)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                      isLiveEditing ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-300 border border-slate-700'
                    }`}
                  >
                    {isLiveEditing ? 'معاينة القراءة' : 'تعديل النص مباشرة'}
                  </button>
                </div>
              </div>
            )}

            <div className="flex-1 bg-[#1e293b] border-2 border-slate-700/80 rounded-2xl p-4 sm:p-6 overflow-y-auto max-h-[850px] shadow-inner text-slate-100">
              {isLoading && analysisResult && (
                <div className="mb-3 rounded-lg border border-amber-500/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">التحليل ما زال قيد التوليد؛ النص الظاهر مسودة جزئية، انتظر اكتمال المهمة قبل الاعتماد عليه أو تصديره.</div>
              )}
              {deconstructError && analysisResult && (
                <div className="mb-3 rounded-lg border border-rose-500/40 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">{deconstructError} النص الظاهر غير مضمون الاكتمال.</div>
              )}
              {isLoading && !analysisResult ? (
                <div className="h-full flex flex-col items-center justify-center py-24 sm:py-28 text-center gap-4">
                  <div className="w-16 h-16 rounded-2xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-400 animate-pulse">
                    <Crosshair className="w-8 h-8" />
                  </div>
                  <div>
                    <h4 className="text-white font-bold text-base mb-1">
                      جاري تفكيك ادعاءات الخصم واستخراج الثغرات...
                    </h4>
                    <p className="text-xs text-slate-400 max-w-md">
                      يتم فحص الثغرات الإجرائية والموضوعية وصياغة الدفوع المقابلة.
                    </p>
                  </div>
                  <Loader2 className="w-6 h-6 animate-spin text-amber-400 mt-2" />
                </div>
              ) : analysisResult ? (
                isLiveEditing ? (
                  <textarea
                    rows={26}
                    value={analysisResult}
                    onChange={(e) => {
                      setAnalysisResult(e.target.value);
                      persistentStorage.setItem('judicial_deconstruct_result', e.target.value);
                    }}
                    className="w-full p-4 border border-amber-500/60 rounded-xl text-white bg-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-500 font-sans"
                    style={{
                      fontSize: `${fontSizePt}pt`,
                      lineHeight: 2.2,
                    }}
                  ></textarea>
                ) : (
                  <div
                    className="whitespace-pre-wrap text-justify tracking-wide leading-[2.4] select-text selection:bg-amber-500/40 selection:text-white"
                    style={{
                      fontFamily:
                        fontFamily === 'traditional'
                          ? "'Traditional Arabic', 'Amiri', serif"
                          : "'Amiri', serif",
                      fontSize: `${fontSizePt}pt`,
                    }}
                  >
                    {displayedContent()}
                  </div>
                )
              ) : deconstructError ? (
                <div className="h-full flex flex-col items-center justify-center py-16 sm:py-20 text-center gap-3 max-w-md mx-auto">
                  <div className="w-14 h-14 rounded-2xl bg-rose-950/60 border border-rose-500/50 flex items-center justify-center text-rose-400">
                    <AlertTriangle className="w-8 h-8" />
                  </div>
                  <h4 className="text-base font-bold text-rose-300">
                    تعذر إتمام التفكيك
                  </h4>
                  <p className="text-xs text-rose-200/90 leading-relaxed bg-rose-950/40 p-3 rounded-xl border border-rose-900">
                    {deconstructError}
                  </p>
                  <button
                    type="button"
                    onClick={handleDeconstruct}
                    className="mt-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-amber-300 border border-slate-600 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>إعادة المحاولة</span>
                  </button>
                </div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center py-24 sm:py-28 text-center text-slate-400 gap-3">
                  <ShieldAlert className="w-14 h-14 text-slate-600" />
                  <h4 className="text-base font-bold text-slate-300">
                    تقرير التفنيد والرد والمذكرة المقابلة سيظهر هنا
                  </h4>
                  <p className="text-xs max-w-md leading-relaxed text-slate-400">
                    الصق مذكرة الخصم أو ارفع ملف Word أو PDF على اليمين ثم اضغط زر التفنيد والرد.
                  </p>
                </div>
              )}
            </div>

            {analysisResult && !isLoading && !deconstructError && (
              <div className="bg-slate-900/90 border border-slate-700/80 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3 shadow-md">
                <div className="flex items-center gap-2 text-xs text-amber-300 font-bold">
                  <Sparkles className="w-4 h-4 text-amber-400" />
                  <span>إجراءات سريعة:</span>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={copyResult}
                    className="px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer border border-slate-600 shadow"
                    title="نسخ"
                  >
                    {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-amber-300" />}
                    <span>{copied ? 'تم النسخ!' : 'نسخ النص'}</span>
                  </button>
                  <button
                    onClick={shareResult}
                    className="px-3.5 py-1.5 rounded-lg bg-blue-700 hover:bg-blue-600 text-white text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer shadow border border-blue-500/50"
                    title="مشاركة"
                  >
                    <Share2 className="w-3.5 h-3.5" />
                    <span>مشاركة</span>
                  </button>
                  <button
                    onClick={exportToWord}
                    className="px-3.5 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-bold flex items-center gap-1.5 shadow transition-all cursor-pointer"
                    title="تصدير Word"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>تصدير Word</span>
                  </button>
                  <button
                    onClick={handlePrint}
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
