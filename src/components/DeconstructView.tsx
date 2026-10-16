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

  // استرجاع المهام المعلقة أو المؤقتة للتحليل عند تحميل المكون
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
      if (active) setDeconstructError(err?.message || 'فشل استئناف المهمة السابقة للتحليل وتفكيك المذكرة.');
    }).finally(() => {
      if (active) setIsLoading(false);
    });
    return () => { active = false; };
  }, [userId]);

  const handleDeconstruct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isUploadingDoc) return;
    if (!opponentBriefText.trim()) {
      setDeconstructError('يرجى إدخال نص مذكرات الخصم أو إرفاق ملف Word أو PDF.');
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
      setDeconstructError(err?.message || 'حدث خطأ أثناء تفكيك المذكرة وتحليلها.');
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
      '2- [مذكرة الرد والرد على الدفوع]:',
      '[مذكرة الرد والرد على الدفوع]:',
      'مذكرة دفاع رد',
      'صياغة مذكرة رد'
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
      '12- [مذكرة الرد والرد على الدفوع]:',
      '12- مذكرة الرد والرد على الدفوع:',
      '2- [مذكرة الرد والرد على الدفوع]:',
      '[مذكرة الرد والرد على الدفوع]:',
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
    const match = text.match(/(?:نوع العمل القضائي المقترح|نوع العمل القانوني المقترح)\s*[:\-\–]\s*([^\n]+)/i);
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
    exportLegalDocToWord(content, 'تفكيك_مذكرة_الخصم_والرد_القانوني');
  };

  const handlePrint = () => {
    window.print();
  };

  const shareResult = async () => {
    const shareText = displayedContent();
    if (!shareText) return;
    await shareLegalDoc(shareText, 'تفكيك مذكرة الخصم وإعداد الرد القانوني المحترف', () => {
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
                  محطة تحليل وتفكيك مذكرات الخصوم والرد الاحترافي
                </h2>
                <span className="text-[11px] bg-[#b45309]/30 text-amber-300 px-2 py-0.5 rounded border border-[#b45309] font-semibold">
                  تحليل نقاط الضعف والثغرات القانونية
                </span>
                <span className="text-[11px] bg-emerald-950 text-emerald-300 px-2 py-0.5 rounded border border-emerald-500 font-semibold">
                  مستند ذكي لإعداد الردود القانونية
                </span>
              </div>
              <p className="text-xs sm:text-sm text-slate-300 mt-1">
                تفكيك مذكرات الخصوم بدقة متناهية واستخراج الثغرات القانونية، مع صياغة مذكرة رد مضادة محترفة تفند كافة دفوع الخصم وتؤسس دفاعك القانوني بقوة وثبات.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={clearAllFields}
              className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-rose-950 text-slate-200 hover:text-rose-200 text-xs font-semibold flex items-center gap-1.5 border border-slate-700 hover:border-rose-500/50 transition-colors whitespace-nowrap cursor-pointer"
              title="مسح كافة الحقول"
            >
              <RotateCcw className="w-4 h-4 text-slate-400" />
              <span>مسح كافة الحقول</span>
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
              <span>بيانات مذكرة الخصم والمستندات المراد تفكيكها</span>
            </h3>
            <span className="text-[11px] text-amber-300 bg-amber-950/60 px-2 py-0.5 rounded border border-amber-500/30">
              إجباري للبدء بالتحليل
            </span>
          </div>

          {/* Immediate Auto-Paste File Upload Zone */}
          <FileUploadZone
            onProcessingChange={setIsUploadingDoc}
            onTextExtracted={(text, fileName) => {
              const trimmed = text.trim();
              if (!trimmed) return;
              setOpponentBriefText((prev) => {
                const updated = prev ? `${prev}\n\n========================================\n[مستند إضافي: ${fileName}]:\n${trimmed}` : trimmed;
                persistentStorage.setItem('judicial_deconstruct_brief', updated);
                return updated;
              });
              setUploadedDocName((prev) => {
                const updatedDoc = prev ? `${prev} | ${fileName}` : fileName;
                persistentStorage.setItem('judicial_deconstruct_docname', updatedDoc);
                return updatedDoc;
              });
            }}
            title="إرفاق مذكرة الخصم (Word / PDF / مستند)"
            description="اسحب وافلت ملف Word أو PDF هنا أو انقر للاختيار لاستخراج النص بدقة 100%."
          />

          {uploadedDocName && (
            <div className="flex items-center justify-between bg-emerald-950/60 border border-emerald-500/40 rounded-xl px-3 py-2 text-xs text-emerald-300">
              <span className="font-semibold truncate">الملف المرفق بنجاح: {uploadedDocName}</span>
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
                إلغاء الملف
              </button>
            </div>
          )}

          <form onSubmit={handleDeconstruct} className="space-y-4 text-sm">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-bold text-amber-300">
                  نص مذكرة الخصم أو المستند القانوني:
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
                    title="الإملاء الصوتي لنص مذكرة الخصم"
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
                placeholder="قم بلصق نص مذكرة الخصم هنا أو ارفع ملف Word أو PDF بالأعلى..."
                className="w-full bg-slate-900 border border-slate-700 rounded-xl p-3 text-white text-xs sm:text-sm font-sans leading-relaxed focus:outline-none focus:border-[#b45309]"
              ></textarea>
            </div>

            <div className="bg-slate-900/90 border border-amber-600/40 rounded-xl p-3 space-y-2">
              <div className="flex items-center justify-between">
                <label className="block text-xs font-bold text-amber-300 flex items-center gap-1.5">
                  <Scale className="w-3.5 h-3.5 text-amber-400" />
                  <span>طبيعة العمل القضائي المطلوب إعداده للرد</span>
                </label>
                <span className="text-[10px] bg-amber-500/20 text-amber-300 px-2 py-0.5 rounded border border-amber-500/30 font-bold">
                  تحديد نوع الرد بدقة
                </span>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                يقوم الذكاء الاصطناعي بتحليل المذكرة وتجهيز الرد القانوني المناسب طبقاً لطلبك أو بصورة ذكية يتم استنباطها من وقائع النزاع. يمكنك اختيار نوع العمل القانوني المستهدف أو تركه ليقوم النظام باقتراحه تلقائياً.
              </p>
              <div className="mt-3">
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  اختر نوع مذكرة الرد أو الطلب القضائي المراد صياغته:
                </label>
                <select
                  value={responseWorkType}
                  onChange={(e) => setResponseWorkType(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-[#b45309]"
                >
                  <option value="__smart__">اقتراح ذكي بناءً على طبيعة الخصومة والدعوى</option>
                  <option value="مذكرة دفاع أو رد قانوني">مذكرة دفاع أو رد قانوني</option>
                  <option value="مذكرة تعقيب أو ملاحظات ختامية">مذكرة تعقيب أو ملاحظات ختامية</option>
                  <option value="مذكرة دفوع شكلية">مذكرة دفوع شكلية</option>
                  <option value="صحيفة طعن أو استئناف محترف">صحيفة طعن أو استئناف محترف</option>
                  <option value="تفنيد مستندات">تفنيد مستندات</option>
                  <option value="مذكرة تفسيرية">مذكرة تفسيرية</option>
                  <option value="مذكرة دفاع فرعية أو طلب عارض">مذكرة دفاع فرعية أو طلب عارض</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  جهة التقاضي أو المحكمة المختصة:
                </label>
                <input
                  type="text"
                  value={courtType}
                  onChange={(e) => setCourtType(e.target.value)}
                  placeholder="مثال: محكمة القضاء الإداري، محكمة الجنح..."
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-[#b45309]"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  طبيعة الدعوى (مدني، إداري، جنائي، عمالي):
                </label>
