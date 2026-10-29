import { getCurrentAccount } from '../services/authService.ts';
import React, { useState, useEffect, useRef } from 'react';
import { qualifyLegalCase, resumeSavedAiTask } from '../services/aiService.ts';
import { getCurrentStoredCredits } from '../utils/deviceFingerprint.ts';
import { FileUploadZone } from './FileUploadZone.tsx';
import { VoiceDictateButton } from './VoiceDictateButton.tsx';
import { persistentStorage } from '../utils/persistentStorage.ts';
import { LegalFollowupChat } from './LegalFollowupChat.tsx';
import { getActiveLawyerUserId } from '../utils/legalVaultService.ts';
import {
  Compass,
  Scale,
  Loader2,
  Copy,
  Check,
  BookOpen,
  ArrowLeft,
  Download,
  ZoomIn,
  ZoomOut,
  Type,
  RotateCcw,
  Share2,
  Printer,
  Sparkles,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react';
import { copyTextSafely, shareLegalDoc } from '../utils/clipboardHelper.ts';
import { exportLegalDocToWord } from '../utils/exportHelper.ts';

interface LegalQualifyViewProps {
  onDraftBriefFromQualify: (facts: string) => void;
  onOpenSubscribe?: () => void;
  onCreditsUpdated?: (newCredits: number) => void;
  isClientOnly?: boolean;
}

export const LegalQualifyView: React.FC<LegalQualifyViewProps> = ({
  onDraftBriefFromQualify,
  onOpenSubscribe,
  onCreditsUpdated,
  isClientOnly = false,
}) => {
  const [disputeDetails, setDisputeDetails] = useState<string>(() => {
    return persistentStorage.getItem('judicial_qualify_dispute', '');
  });
  const [clientGoals, setClientGoals] = useState<string>(() => {
    return persistentStorage.getItem('judicial_qualify_goals', '');
  });
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isUploadingDoc, setIsUploadingDoc] = useState<boolean>(false);
  const [qualificationResult, setQualificationResult] = useState<string>(() => {
    return persistentStorage.getItem('judicial_qualify_result', '');
  });
  const [uploadedDocName, setUploadedDocName] = useState<string>(() => {
    return persistentStorage.getItem('judicial_qualify_docname', '');
  });
  const [copied, setCopied] = useState<boolean>(false);
  const [fontSizePt, setFontSizePt] = useState<number>(18);
  const [fontFamily, setFontFamily] = useState<'traditional' | 'amiri'>('traditional');
  const [isLiveEditing, setIsLiveEditing] = useState<boolean>(false);
  const resultOperationRef = useRef(0);
  const clearPersistenceRef = useRef(false);

  useEffect(() => {
    if (clearPersistenceRef.current) persistentStorage.removeItem('judicial_qualify_dispute'); else persistentStorage.setItem('judicial_qualify_dispute', disputeDetails);
  }, [disputeDetails]);

  useEffect(() => {
    if (clearPersistenceRef.current) persistentStorage.removeItem('judicial_qualify_goals'); else persistentStorage.setItem('judicial_qualify_goals', clientGoals);
  }, [clientGoals]);

  useEffect(() => {
    if (clearPersistenceRef.current) persistentStorage.removeItem('judicial_qualify_result'); else persistentStorage.setItem('judicial_qualify_result', qualificationResult);
  }, [qualificationResult]);

  useEffect(() => {
    if (clearPersistenceRef.current) persistentStorage.removeItem('judicial_qualify_docname'); else persistentStorage.setItem('judicial_qualify_docname', uploadedDocName);
  }, [uploadedDocName]);

  // Append extracted document text directly to the dispute/facts field.
  // Persistence is handled by the effects above so the state update stays side-effect free.
  const handleExtractedDocumentText = (text: string, fileName: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    setDisputeDetails((prev) => {
      if (!prev.trim()) return trimmed;
      return `${prev.trim()}\n\n========================================\n[مستند: ${fileName}]:\n${trimmed}`;
    });

    setUploadedDocName((prev) => (prev ? `${prev} | ${fileName}` : fileName));
    setQualifyError('');
  };

  useEffect(() => { clearPersistenceRef.current = false; });

  const clearAllFields = () => {
    resultOperationRef.current += 1;
    setIsLoading(false);
    setQualifyError('');
    clearPersistenceRef.current = true;
    setDisputeDetails('');
    setClientGoals('');
    setQualificationResult('');
    setUploadedDocName('');
    persistentStorage.removeItem('judicial_qualify_dispute');
    persistentStorage.removeItem('judicial_qualify_goals');
    persistentStorage.removeItem('judicial_qualify_result');
    persistentStorage.removeItem('judicial_qualify_docname');
    const storageUser = String(getActiveLawyerUserId() || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
    try { localStorage.removeItem(`amin_ai_job_qualify_${storageUser}`); } catch {}
    try { const prefix = `amin_legal_followup_qualify_` + (String(getActiveLawyerUserId() || 'default').replace(/[^a-zA-Z0-9_-]/g, '_')) + '_'; for (let i = localStorage.length - 1; i >= 0; i -= 1) { const key = localStorage.key(i); if (key && key.startsWith(prefix)) { localStorage.removeItem(key); localStorage.removeItem(`${key}_pending_job`); } } } catch {}
  };


  const [qualifyError, setQualifyError] = useState<string>('');

  useEffect(() => {
    let active = true;
    const operationId = resultOperationRef.current;
    let jobId = '';
    const userId = getActiveLawyerUserId();
    const storageUser = String(userId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
    try { jobId = localStorage.getItem(`amin_ai_job_qualify_${storageUser}`) || ''; } catch {}
    if (!jobId) return () => { active = false; };
    setIsLoading(true);
    setQualifyError('');
    void resumeSavedAiTask('qualify', jobId, (chunk) => {
      if (active && operationId === resultOperationRef.current) setQualificationResult((current) => current + chunk);
    }, userId).then((result) => {
      if (!active || operationId !== resultOperationRef.current) return;
      setQualificationResult(result);
      persistentStorage.setItem('judicial_qualify_result', result);
    }).catch((err: any) => {
      if (active && operationId === resultOperationRef.current) setQualifyError(err?.message || 'تعذر استعادة المهمة المحفوظة.');
    }).finally(() => {
      if (active && operationId === resultOperationRef.current) setIsLoading(false);
    });
    return () => { active = false; };
  }, []);


  const handleQualify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isUploadingDoc) return;
    if (!disputeDetails.trim()) {
      setQualifyError('يرجى سرد تفاصيل النزاع أو رفع مستندات الدعوى أولاً.');
      return;
    }

    const availableCredits = getCurrentStoredCredits();
    if (availableCredits <= 0) {
      if (onOpenSubscribe) onOpenSubscribe();
      return;
    }

    const operationId = ++resultOperationRef.current;
    setIsLoading(true);
    setQualifyError('');
    setQualificationResult('');
    try {
      const result = await qualifyLegalCase(disputeDetails, clientGoals, (chunk) => {
        if (operationId === resultOperationRef.current) setQualificationResult((current) => current + chunk);
      }, getActiveLawyerUserId());
      if (result && operationId === resultOperationRef.current) {
        setQualificationResult(result);
        persistentStorage.setItem('judicial_qualify_result', result);
        try {
          const account = await getCurrentAccount();
          if (onCreditsUpdated) onCreditsUpdated(account.credits);
        } catch {}
      }
    } catch (err: any) {
      if (operationId !== resultOperationRef.current) return;
      console.warn('Qualify error:', err);
      setQualifyError(err?.message || 'تعذر استكمال التكييف القانوني حالياً.');
    } finally {
      if (operationId === resultOperationRef.current) setIsLoading(false);
    }
  };

  const copyResult = async () => {
    if (!qualificationResult) return;
    const ok = await copyTextSafely(qualificationResult);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const exportToWord = () => {
    if (!qualificationResult) return;
    exportLegalDocToWord(qualificationResult, 'تقرير_التكييف_القانوني');
  };

  const handlePrint = () => {
    window.print();
  };

  const shareResult = async () => {
    if (!qualificationResult) return;
    await shareLegalDoc(qualificationResult, 'تقرير التكييف القانوني', () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-3 sm:py-5 space-y-4 sm:space-y-5" style={{ fontFamily: 'Cairo, sans-serif' }}>
      {/* Top Banner */}
      <div className="bg-[#0f172a] border-2 border-[#b45309] rounded-2xl p-4 sm:p-5 shadow-xl">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-start gap-3.5">
            <div className="w-11 h-11 sm:w-12 sm:h-12 rounded-xl bg-emerald-600/20 border border-emerald-500/40 flex items-center justify-center text-emerald-300 flex-shrink-0">
              <Compass className="w-5 h-5 sm:w-6 sm:h-6 text-emerald-400" />
            </div>
            <div>
              <h2 className="text-base sm:text-xl font-bold text-white flex items-center gap-2 flex-wrap">
                <span>التكييف القانوني وتحديد المسار القضائي</span>
                <span className="text-[11px] bg-emerald-950 text-emerald-300 px-2 py-0.5 rounded border border-emerald-500/40 font-medium">
                  استشارة قانونية وتأصيل فقهي
                </span>
              </h2>
              <p className="text-xs sm:text-sm text-slate-300 mt-1">
                اطرح وقائع النزاع ليحدد لك المساعد القضائي المحكمة المختصة والنصوص الواجبة التطبيق.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={clearAllFields}
              className="text-xs px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 hover:text-white transition-all font-semibold flex items-center gap-1.5 cursor-pointer"
              title="تفريغ الحقول"
            >
              <RotateCcw className="w-3.5 h-3.5 text-slate-400" />
              <span>تفريغ الحقول</span>
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 sm:gap-6 items-start">
        {/* Input Panel (5 cols) */}
        <div className="lg:col-span-5 bg-[#0f172a] border border-slate-800 rounded-2xl p-4 sm:p-5 shadow-xl space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800">
            <h3 className="font-bold text-white text-sm flex items-center gap-2">
              <Scale className="w-4 h-4 text-emerald-400" />
              <span>وقائع وموضوع النزاع</span>
            </h3>
            <span className="text-[11px] text-emerald-300 bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-500/30">
              بيانات النزاع
            </span>
          </div>

          {/* Immediate Auto-Paste File Upload Zone */}
          <FileUploadZone
            recoveryScope="qualify"
            onProcessingChange={setIsUploadingDoc}
            onTextExtracted={handleExtractedDocumentText}
            title="رفع مستندات النزاع (وورد / بي دي إف / صور)"
            description="ارفع عقود، إيصالات، محاضر، أو أحكام سابقة للتكييف التلقائي."
          />

          {uploadedDocName && (
            <div className="flex items-center justify-between bg-emerald-950/60 border border-emerald-500/40 rounded-xl px-3 py-2 text-xs text-emerald-300">
              <span className="font-semibold truncate">المستند المرفق: {uploadedDocName}</span>
              <button
                type="button"
                onClick={() => {
                  setUploadedDocName('');
                  setDisputeDetails('');
                  persistentStorage.removeItem('judicial_qualify_dispute');
                  persistentStorage.removeItem('judicial_qualify_docname');
                }}
                className="text-rose-400 hover:text-rose-300 text-[11px] font-bold underline cursor-pointer ml-2 flex-shrink-0"
              >
                حذف المستند
              </button>
            </div>
          )}

          <form onSubmit={handleQualify} className="space-y-4 text-sm">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-semibold text-slate-200">
                  سرد وقائع النزاع وتفاصيله:
                </label>
                <VoiceDictateButton
                  onTranscript={(text) => {
                    setDisputeDetails((prev) => {
                      const updated = prev ? `${prev} ${text}` : text;
                      persistentStorage.setItem('judicial_qualify_dispute', updated);
                      return updated;
                    });
                  }}
                  title="إملاء وقائع النزاع"
                />
              </div>
              <textarea
                rows={8}
                value={disputeDetails}
                onChange={(e) => setDisputeDetails(e.target.value)}
                placeholder="اكتب تفاصيل النزاع هنا أو ارفع مستند وورد أو ملف بي دي إف أعلاه..."
                className="w-full bg-slate-900 border border-slate-700 rounded-xl p-3.5 text-white text-xs sm:text-sm leading-relaxed focus:outline-none focus:border-emerald-500 font-sans"
              ></textarea>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-semibold text-slate-200">
                  الأهداف والمطالب المراد تحقيقها (اختياري):
                </label>
                <VoiceDictateButton
                  onTranscript={(text) => {
                    setClientGoals((prev) => {
                      const updated = prev ? `${prev} ${text}` : text;
                      persistentStorage.setItem('judicial_qualify_goals', updated);
                      return updated;
                    });
                  }}
                  title="إملاء المطالب"
                />
              </div>
              <textarea
                rows={3}
                value={clientGoals}
                onChange={(e) => setClientGoals(e.target.value)}
                placeholder="مثال: استرداد المبلغ، طرد المستأجر، فسخ العقد والتعويض..."
                className="w-full bg-slate-900 border border-slate-700 rounded-xl p-3 text-white text-xs focus:outline-none focus:border-emerald-500"
              ></textarea>
            </div>

            <button
              type="submit"
              disabled={isLoading || isUploadingDoc}
              className="w-full py-3.5 px-4 rounded-xl bg-gradient-to-r from-emerald-700 via-emerald-800 to-emerald-900 hover:from-emerald-600 hover:to-emerald-800 text-white font-bold text-sm shadow-xl shadow-emerald-950/50 border border-emerald-500/40 flex items-center justify-center gap-2 transition-all disabled:opacity-50 cursor-pointer"
            >
              {isUploadingDoc ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-emerald-200" />
                  <span>جارٍ معالجة المستند...</span>
                </>
              ) : isLoading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-emerald-200" />
                  <span>جارٍ التكييف القانوني الدقيق...</span>
                </>
              ) : (
                <>
                  <Compass className="w-5 h-5 text-emerald-200" />
                  <span>تكييف النزاع واستخراج الرأي القانوني</span>
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
                <div className="w-8 h-8 rounded-lg bg-emerald-950/80 border border-emerald-500/40 flex items-center justify-center text-emerald-400">
                  <BookOpen className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-bold text-white text-base">
                    تقرير التكييف والتأصيل القضائي
                  </h3>
                  <span className="text-[11px] text-slate-400">
                    مستند إلى نصوص القانون وأحكام النقض
                  </span>
                </div>
              </div>

              {qualificationResult && (
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={copyResult}
                    className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold flex items-center gap-1.5 border border-slate-700 transition-colors cursor-pointer"
                    title="نسخ التقرير"
                  >
                    {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copied ? 'تم النسخ!' : 'نسخ التقرير'}</span>
                  </button>
                  <button
                    onClick={exportToWord}
                    className="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-bold flex items-center gap-1.5 shadow transition-colors cursor-pointer"
                    title="تصدير بصيغة وورد (.doc)"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>تصدير وورد (.doc)</span>
                  </button>
                  {!isClientOnly && (
                    <button
                      onClick={() => onDraftBriefFromQualify(disputeDetails)}
                      className="px-3 py-1.5 rounded-lg bg-[#b45309] hover:bg-amber-600 text-white text-xs font-bold flex items-center gap-1.5 shadow transition-colors cursor-pointer"
                      title="تحويل الوقائع إلى صياغة مذكرة"
                    >
                      <span>صياغة مذكرة بهذا التكييف</span>
                      <ArrowLeft className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              )}
            </div>

            {qualificationResult && (
              <div className="bg-[#1e293b] border border-slate-700 rounded-xl p-2.5 mb-3 flex flex-wrap items-center justify-between gap-3 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-slate-300 font-bold flex items-center gap-1">
                    <Type className="w-3.5 h-3.5 text-amber-400" />
                    الخط:
                  </span>
                  <div className="bg-slate-900 p-0.5 rounded-lg border border-slate-700 flex">
                    <button
                      type="button"
                      onClick={() => setFontFamily('traditional')}
                      className={`px-3 py-1 rounded text-xs transition-all cursor-pointer ${
                        fontFamily === 'traditional' ? 'bg-[#b45309] text-white font-bold' : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      Traditional Arabic
                    </button>
                    <button
                      type="button"
                      onClick={() => setFontFamily('amiri')}
                      className={`px-3 py-1 rounded text-xs transition-all cursor-pointer ${
                        fontFamily === 'amiri' ? 'bg-[#b45309] text-white font-bold' : 'text-slate-400 hover:text-white'
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
                      >
                        <ZoomIn className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsLiveEditing(!isLiveEditing)}
                    className={`px-3 py-1 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                      isLiveEditing ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-300 border border-slate-700'
                    }`}
                  >
                    {isLiveEditing ? 'معاينة القراءة' : 'تعديل النص مباشرة'}
                  </button>
                </div>
              </div>
            )}

            <div className="flex-1 bg-[#1e293b] border-2 border-slate-700/80 rounded-2xl p-4 sm:p-6 overflow-y-auto max-h-[850px] shadow-inner text-slate-100">
              {isLoading && !qualificationResult ? (
                <div className="h-full flex flex-col items-center justify-center py-24 sm:py-28 text-center gap-4">
                  <div className="w-16 h-16 rounded-2xl bg-emerald-950/40 border border-emerald-500/40 flex items-center justify-center text-emerald-400 animate-pulse">
                    <Compass className="w-8 h-8" />
                  </div>
                  <div>
                    <h4 className="text-white font-bold text-base mb-1">
                      جارٍ تكييف النزاع واستخراج السند القانوني...
                    </h4>
                    <p className="text-xs text-slate-400 max-w-md">
                      يتم فحص أصول النزاع وفقاً للقانون المدني والمرافعات وأحكام النقض.
                    </p>
                  </div>
                  <Loader2 className="w-6 h-6 animate-spin text-emerald-400 mt-2" />
                </div>
              ) : qualificationResult ? (
                isLiveEditing ? (
                  <textarea
                    rows={26}
                    value={qualificationResult}
                    onChange={(e) => {
                      setQualificationResult(e.target.value);
                      persistentStorage.setItem('judicial_qualify_result', e.target.value);
                    }}
                    className="w-full p-4 border border-emerald-500/60 rounded-xl text-white bg-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500 font-sans"
                    style={{
                      fontSize: `${fontSizePt}pt`,
                      lineHeight: 2.2,
                    }}
                  ></textarea>
                ) : (
                  <div
                    className="whitespace-pre-wrap text-justify tracking-wide leading-[2.4] select-text selection:bg-emerald-500/40 selection:text-white"
                    style={{
                      fontFamily:
                        fontFamily === 'traditional'
                          ? "'Traditional Arabic', 'Amiri', serif"
                          : "'Amiri', serif",
                      fontSize: `${fontSizePt}pt`,
                    }}
                  >
                    {qualificationResult}
                  </div>
                )
              ) : qualifyError ? (
                <div className="h-full flex flex-col items-center justify-center py-16 sm:py-20 text-center gap-3 max-w-md mx-auto">
                  <div className="w-14 h-14 rounded-2xl bg-rose-950/60 border border-rose-500/50 flex items-center justify-center text-rose-400">
                    <AlertTriangle className="w-8 h-8" />
                  </div>
                  <h4 className="text-base font-bold text-rose-300">
                    تعذر إتمام التكييف
                  </h4>
                  <p className="text-xs text-rose-200/90 leading-relaxed bg-rose-950/40 p-3 rounded-xl border border-rose-900">
                    {qualifyError}
                  </p>
                  <button
                    type="button"
                    onClick={handleQualify}
                    className="mt-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-amber-300 border border-slate-600 rounded-xl text-xs font-bold transition-all cursor-pointer flex items-center gap-1.5"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>إعادة المحاولة</span>
                  </button>
                </div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center py-24 sm:py-28 text-center text-slate-400 gap-3">
                  <Compass className="w-14 h-14 text-slate-600" />
                  <h4 className="text-base font-bold text-slate-300">
                    تقرير التكييف القضائي سيظهر هنا
                  </h4>
                  <p className="text-xs max-w-md leading-relaxed text-slate-400">
                    ادخل تفاصيل النزاع على اليمين ثم اضغط تكييف النزاع للحصول على دراسة قانونية وافية.
                  </p>
                </div>
              )}
            </div>

            {qualificationResult && (
              <div className="bg-slate-900/90 border border-slate-700/80 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3 shadow-md">
                <div className="flex items-center gap-2 text-xs text-emerald-300 font-bold">
                  <Sparkles className="w-4 h-4 text-emerald-400" />
                  <span>إجراءات المستند:</span>
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
                    title="تصدير وورد"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>تصدير وورد</span>
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
      {qualificationResult && <LegalFollowupChat taskType="qualify" userId={getActiveLawyerUserId()} originalContext={`${disputeDetails}\n${clientGoals || ''}`} result={qualificationResult} onResultChange={(nextResult) => { setQualificationResult(nextResult); persistentStorage.setItem('judicial_qualify_result', nextResult); }} />}
    </div>
  );
};
