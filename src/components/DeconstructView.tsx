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

  // Resume an AI task that was persisted by the service if the view was reopened.
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
      if (active) setDeconstructError(err?.message || '鬲毓匕乇 丕爻鬲毓丕丿丞 丕賱賲賴賲丞 丕賱賲丨賮賵馗丞.');
    }).finally(() => {
      if (active) setIsLoading(false);
    });
    return () => { active = false; };
  }, [userId]);

  const handleDeconstruct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isUploadingDoc) return;
    if (!opponentBriefText.trim()) {
      setDeconstructError('賷乇噩賶 賱氐賯 賳氐 賲匕賰乇丞 丕賱禺氐賲 兀賵 乇賮毓 賲爻鬲賳丿 Word 兀賵 PDF.');
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
      setDeconstructError(err?.message || '鬲毓匕乇 丕爻鬲賰賲丕賱 鬲賮賰賷賰 丕賱賲匕賰乇丞.');
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
      '2- [丕賱賲匕賰乇丞 丕賱賲賯丕亘賱丞 丕賱賲賯鬲乇丨丞]:',
      '[丕賱賲匕賰乇丞 丕賱賲賯丕亘賱丞 丕賱賲賯鬲乇丨丞]:',
      '亘丕爻賲 丕賱卮毓亘',
      '賲匕賰乇丞 亘丿賮丕毓'
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
      '12- [丕賱賲匕賰乇丞 丕賱賲賯丕亘賱丞 丕賱賲賯鬲乇丨丞]:',
      '12- 丕賱賲匕賰乇丞 丕賱賲賯丕亘賱丞 丕賱賲賯鬲乇丨丞:',
      '2- [丕賱賲匕賰乇丞 丕賱賲賯丕亘賱丞 丕賱賲賯鬲乇丨丞]:',
      '[丕賱賲匕賰乇丞 丕賱賲賯丕亘賱丞 丕賱賲賯鬲乇丨丞]:',
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
    const match = text.match(/(?:賳賵毓 丕賱毓賲賱 丕賱賯囟丕卅賷 丕賱賲賯丕亘賱 丕賱賲賯鬲乇丨|賳賵毓 丕賱賲爻鬲賳丿 丕賱賲賯丕亘賱 丕賱賲賯鬲乇丨)\s*[:锛�-]\s*([^\n]+)/i);
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
    exportLegalDocToWord(content, '鬲賯乇賷乇_鬲賮賰賷賰_賲匕賰乇丞_丕賱禺氐賲');
  };

  const handlePrint = () => {
    window.print();
  };

  const shareResult = async () => {
    const shareText = displayedContent();
    if (!shareText) return;
    await shareLegalDoc(shareText, '鬲賯乇賷乇 丕賱鬲賮賳賷丿 賵丕賱乇丿 毓賱賶 丕賱賲爻鬲賳丿丕鬲', () => {
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
                  丕賱鬲賮賳賷丿 賵丕賱乇丿 毓賱賶 丕賱賲爻鬲賳丿丕鬲
                </h2>
                <span className="text-[11px] bg-[#b45309]/30 text-amber-300 px-2 py-0.5 rounded border border-[#b45309] font-semibold">
                  鬲丨賱賷賱 丕爻鬲乇丕鬲賷噩賷 賲鬲賯丿賲
                </span>
                <span className="text-[11px] bg-emerald-950 text-emerald-300 px-2 py-0.5 rounded border border-emerald-500 font-semibold">
                  氐賷丕睾丞 丕賱乇丿 丕賱賲賯丕亘賱 賮賵乇丕賸
                </span>
              </div>
              <p className="text-xs sm:text-sm text-slate-300 mt-1">
                丕賱氐賯 丕賱賲爻鬲賳丿 兀賵 丕乇賮毓賴 亘氐賷睾丞 Word / PDF貙 賵爻賷賯賵賲 丕賱賲爻丕毓丿 亘鬲賮賳賷丿 賲丨鬲賵丕賴 賵丕爻鬲禺乇丕噩 賳賯丕胤 丕賱囟毓賮 賵廿毓丿丕丿 丕賱乇丿 丕賱賯丕賳賵賳賷 丕賱賲賳丕爻亘.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={clearAllFields}
              className="px-3.5 py-2 rounded-xl bg-slate-800 hover:bg-rose-950 text-slate-200 hover:text-rose-200 text-xs font-semibold flex items-center gap-1.5 border border-slate-700 hover:border-rose-500/50 transition-colors whitespace-nowrap cursor-pointer"
              title="鬲賮乇賷睾 丕賱丨賯賵賱"
            >
              <RotateCcw className="w-4 h-4 text-slate-400" />
              <span>鬲賮乇賷睾 丕賱丨賯賵賱</span>
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
              <span>賲匕賰乇丞 丕賱禺氐賲 賵亘賷丕賳丕鬲 丕賱賯囟賷丞</span>
            </h3>
            <span className="text-[11px] text-amber-300 bg-amber-950/60 px-2 py-0.5 rounded border border-amber-500/30">
              亘賷丕賳丕鬲 丕賱廿丿禺丕賱
            </span>
          </div>

          {/* Immediate Auto-Paste File Upload Zone */}
          <FileUploadZone
            onProcessingChange={setIsUploadingDoc}
            onTextExtracted={(text, fileName) => {
              const trimmed = text.trim();
              if (!trimmed) return;
              setOpponentBriefText((prev) => {
                const updated = prev ? `${prev}\n\n========================================\n[賲爻鬲賳丿: ${fileName}]:\n${trimmed}` : trimmed;
                persistentStorage.setItem('judicial_deconstruct_brief', updated);
                return updated;
              });
              setUploadedDocName((prev) => {
                const updatedDoc = prev ? `${prev} | ${fileName}` : fileName;
                persistentStorage.setItem('judicial_deconstruct_docname', updatedDoc);
                return updatedDoc;
              });
            }}
            title="乇賮毓 賲匕賰乇丞 丕賱禺氐賲 (Word / PDF / 氐賵乇)"
            description="賷丿毓賲 賲賱賮丕鬲 Word 丕賱賯丿賷賲丞 賵丕賱丨丿賷孬丞 賵丕賱賲爻鬲賳丿丕鬲 丕賱賲氐賵乇丞 亘丿賯丞 100%."
          />

          {uploadedDocName && (
            <div className="flex items-center justify-between bg-emerald-950/60 border border-emerald-500/40 rounded-xl px-3 py-2 text-xs text-emerald-300">
              <span className="font-semibold truncate">丕賱賲賱賮 丕賱賲乇賮賯: {uploadedDocName}</span>
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
                丨匕賮 丕賱賲爻鬲賳丿
              </button>
            </div>
          )}

          <form onSubmit={handleDeconstruct} className="space-y-4 text-sm">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-bold text-amber-300">
                  賳氐 賲匕賰乇丞 兀賵 胤賱亘丕鬲 丕賱禺氐賲:
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
                    title="廿賲賱丕亍 賳氐 賲匕賰乇丞 丕賱禺氐賲"
                  />
                  <span className="text-[11px] text-slate-400 font-mono">
                    {opponentBriefText.length} 丨乇賮
                  </span>
                </div>
              </div>
              <textarea
                rows={8}
                value={opponentBriefText}
                onChange={(e) => setOpponentBriefText(e.target.value)}
                placeholder="丕賱氐賯 賳氐 賲匕賰乇丞 丕賱禺氐賲 賴賳丕 兀賵 丕乇賮毓 賲賱賮 Word 兀賵 PDF 兀毓賱丕賴..."
                className="w-full bg-slate-900 border border-slate-700 rounded-xl p-3 text-white text-xs sm:text-sm font-sans leading-relaxed focus:outline-none focus:border-[#b45309]"
              ></textarea>
            </div>

            <div className="bg-slate-900/90 border border-amber-600/40 rounded-xl p-3 space-y-2">
              <div className="flex items-center justify-between">
                <label className="block text-xs font-bold text-amber-300 flex items-center gap-1.5">
                  <Scale className="w-3.5 h-3.5 text-amber-400" />
                  <span>賲賴賲丞 丕賱鬲賮賳賷丿 賵丕賱乇丿</span>
                </label>
                <span className="text-[10px] bg-amber-500/20 text-amber-300 px-2 py-0.5 rounded border border-amber-500/30 font-bold">
                  丕禺鬲賷丕乇 丕賱賲乇噩毓 鬲賱賯丕卅賷
                </span>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                賷賮丨氐 丕賱賲爻丕毓丿 禺夭賳丞 丕賱丨爻丕亘 丕賱丨丕賱賷 鬲賱賯丕卅賷丕賸 亘丨孬丕賸 毓賳 賳賲賵匕噩 賲胤丕亘賯 兀賵 賯乇賷亘 賵賲賮賷丿. 賵廿匕丕 賱賲 賷噩丿 賳賲賵匕噩丕賸 賲賳丕爻亘丕賸貙 賷賳卮卅 丕賱鬲賮賳賷丿 賵丕賱乇丿 賲賳 丕賱氐賮乇 丿賵賳 鬲賵賯賮 賵丿賵賳 胤賱亘 丕禺鬲賷丕乇 賳賲賵匕噩.
              </p>
              <div className="mt-3">
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  賳賵毓 丕賱賲爻鬲賳丿 丕賱匕賷 鬲乇賷丿 丕賱乇丿 亘賴:
                </label>
                <select
                  value={responseWorkType}
                  onChange={(e) => setResponseWorkType(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-[#b45309]"
                >
                  <option value="__smart__">鬲丨丿賷丿 匕賰賷 丨爻亘 丕賱賯囟賷丞 賵丕賱賲爻鬲賳丿</option>
                  <option value="賲匕賰乇丞 乇丿 兀賵 丿賮丕毓">賲匕賰乇丞 乇丿 兀賵 丿賮丕毓</option>
                  <option value="毓乇賷囟丞 兀賵 氐丨賷賮丞 丿毓賵賶">毓乇賷囟丞 兀賵 氐丨賷賮丞 丿毓賵賶</option>
                  <option value="氐丨賷賮丞 胤毓賳">氐丨賷賮丞 胤毓賳</option>
                  <option value="丨丕賮馗丞 賲爻鬲賳丿丕鬲">丨丕賮馗丞 賲爻鬲賳丿丕鬲</option>
                  <option value="廿賳匕丕乇">廿賳匕丕乇</option>
                  <option value="鬲毓賯賷亘">鬲毓賯賷亘</option>
                  <option value="廿噩乇丕亍 兀賵 賲爻鬲賳丿 賯丕賳賵賳賷 丌禺乇">廿噩乇丕亍 兀賵 賲爻鬲賳丿 賯丕賳賵賳賷 丌禺乇</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  丕賱賲丨賰賲丞 丕賱賲賳馗賵乇丞 兀賲丕賲賴丕:
                </label>
                <input
                  type="text"
                  value={courtType}
                  onChange={(e) => setCourtType(e.target.value)}
                  placeholder="賲孬丕賱: 賲丨賰賲丞 丕爻鬲卅賳丕賮 丕賱賯丕賴乇丞..."
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-[#b45309]"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">
                  賲賵賯賮賳丕 亘丕禺鬲氐丕乇 (胤賱亘 丕賱乇丿):
                </label>
                <input
                  type="text"
                  value={ourPosition}
                  onChange={(e) => setOurPosition(e.target.value)}
                  placeholder="賲孬丕賱: 乇賮囟 丕賱丿毓賵賶 賱毓丿賲 丕賱氐丨丞..."
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-[#b45309]"
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-semibold text-slate-300">
                  賵賯丕卅毓 賵兀丿賱丞 廿囟丕賮賷丞 賱氐丕賱丨賳丕 (丕禺鬲賷丕乇賷):
                </label>
                <VoiceDictateButton
                  onTranscript={(text) => {
                    setAdditionalFacts((prev) => (prev ? `${prev} ${text}` : text));
                  }}
                  title="廿賲賱丕亍 賵賯丕卅毓 廿囟丕賮賷丞"
                />
              </div>
              <textarea
                rows={2}
                value={additionalFacts}
                onChange={(e) => setAdditionalFacts(e.target.value)}
                placeholder="兀賷 賲爻鬲賳丿丕鬲 兀賵 廿賷氐丕賱丕鬲 爻丿丕丿 兀賵 賵賯丕卅毓 廿囟丕賮賷丞 鬲乇睾亘 賮賷 丕爻鬲禺丿丕賲賴丕 賱賱丿賮丕毓..."
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
                  <span>噩丕乇賺 賲毓丕賱噩丞 丕賱賲爻鬲賳丿...</span>
                </>
              ) : isLoading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin text-amber-200" />
                  <span>噩丕乇賺 鬲賮賳賷丿 丕賱賲爻鬲賳丿 賵氐賷丕睾丞 丕賱乇丿 丕賱賯囟丕卅賷...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-5 h-5 text-amber-200" />
                  <span>丕賱鬲賮賳賷丿 賵丕賱乇丿 毓賱賶 丕賱賲爻鬲賳丿丕鬲</span>
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
                    鬲賯乇賷乇 丕賱鬲賮賰賷賰 賵丕賱賲匕賰乇丞 丕賱賲賯丕亘賱丞
                  </h3>
                  <span className="text-[11px] text-slate-400">
                    丕爻鬲乇丕鬲賷噩賷丞 丕賱丿賮丕毓 賵丕賱賲匕賰乇丞 丕賱噩賵丕亘賷丞 丕賱賰丕賲賱丞
                  </span>
                </div>
              </div>

              {analysisResult && (
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={copyResult}
                    className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer border border-slate-700 shadow-sm"
                    title="賳爻禺"
                  >
                    {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copied ? '鬲賲 丕賱賳爻禺!' : '賳爻禺 丕賱賳氐'}</span>
                  </button>
                  <button
                    onClick={exportToWord}
                    className="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-bold flex items-center gap-1.5 shadow-md transition-colors cursor-pointer"
                    title="鬲氐丿賷乇 亘氐賷睾丞 Word (.doc)"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>鬲氐丿賷乇 Word (.doc)</span>
                  </button>
                  <button
                    onClick={handlePrint}
                    className="px-3 py-1.5 rounded-lg bg-[#b45309] hover:bg-amber-600 text-white text-xs font-bold flex items-center gap-1.5 shadow-md transition-colors cursor-pointer"
                    title="胤亘丕毓丞 / PDF"
                  >
                    <Printer className="w-3.5 h-3.5" />
                    <span>胤亘丕毓丞 / PDF</span>
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
                      title="賳賯賱 廿賱賶 丕賱氐賷丕睾丞 丕賱卮丕賲賱丞"
                    >
                      <span>賳賯賱 賱賱氐賷丕睾丞</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              )}
            </div>

            {analysisResult && (
              <AppliedRulesAuditBadge
                workType="鬲賮賳賷丿 賲匕賰乇丞 丕賱禺氐賲 賵丕賱乇丿 毓賱賷賴丕"
                courtType={courtType}
                customInstructions="鬲賮賰賷賰 丕丿毓丕亍丕鬲 丕賱禺氐賲 賵丕賱乇丿 賵賮賯 丕賱兀氐賵賱 丕賱賯囟丕卅賷丞"
              />
            )}

            {analysisResult && (
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
                    <span>丕賱鬲賯乇賷乇 賰丕賲賱丕賸</span>
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
                    <span>丕賱賲匕賰乇丞 丕賱賲賯丕亘賱丞 賮賯胤</span>
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
                    <span>丕賱鬲丨賱賷賱 賵丕賱鬲賮賰賷賰 賮賯胤</span>
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
                    <span>噩丿賵賱 丕賱孬睾乇丕鬲</span>
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
                    {isLiveEditing ? '賲毓丕賷賳丞 丕賱賯乇丕亍丞' : '鬲毓丿賷賱 丕賱賳氐 賲亘丕卮乇丞'}
                  </button>
                </div>
              </div>
            )}

            <div className="flex-1 bg-[#1e293b] border-2 border-slate-700/80 rounded-2xl p-4 sm:p-6 overflow-y-auto max-h-[850px] shadow-inner text-slate-100">
              {isLoading ? (
                <div className="h-full flex flex-col items-center justify-center py-24 sm:py-28 text-center gap-4">
                  <div className="w-16 h-16 rounded-2xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-400 animate-pulse">
                    <Crosshair className="w-8 h-8" />
                  </div>
                  <div>
                    <h4 className="text-white font-bold text-base mb-1">
                      噩丕乇賺 鬲賮賰賷賰 丕丿毓丕亍丕鬲 丕賱禺氐賲 賵丕爻鬲禺乇丕噩 丕賱孬睾乇丕鬲...
                    </h4>
                    <p className="text-xs text-slate-400 max-w-md">
                      賷鬲賲 賮丨氐 丕賱孬睾乇丕鬲 丕賱廿噩乇丕卅賷丞 賵丕賱賲賵囟賵毓賷丞 賵氐賷丕睾丞 丕賱丿賮賵毓 丕賱賲賯丕亘賱丞.
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
                    鬲毓匕乇 廿鬲賲丕賲 丕賱鬲賮賰賷賰
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
                    <span>廿毓丕丿丞 丕賱賲丨丕賵賱丞</span>
                  </button>
                </div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center py-24 sm:py-28 text-center text-slate-400 gap-3">
                  <ShieldAlert className="w-14 h-14 text-slate-600" />
                  <h4 className="text-base font-bold text-slate-300">
                    鬲賯乇賷乇 丕賱鬲賮賳賷丿 賵丕賱乇丿 賵丕賱賲匕賰乇丞 丕賱賲賯丕亘賱丞 爻賷馗賴乇 賴賳丕
                  </h4>
                  <p className="text-xs max-w-md leading-relaxed text-slate-400">
                    丕賱氐賯 賲匕賰乇丞 丕賱禺氐賲 兀賵 丕乇賮毓 賲賱賮 Word 兀賵 PDF 毓賱賶 丕賱賷賲賷賳 孬賲 丕囟睾胤 夭乇 丕賱鬲賮賳賷丿 賵丕賱乇丿.
                  </p>
                </div>
              )}
            </div>

            {analysisResult && (
              <div className="bg-slate-900/90 border border-slate-700/80 rounded-xl p-3 flex flex-wrap items-center justify-between gap-3 shadow-md">
                <div className="flex items-center gap-2 text-xs text-amber-300 font-bold">
                  <Sparkles className="w-4 h-4 text-amber-400" />
                  <span>廿噩乇丕亍丕鬲 爻乇賷毓丞:</span>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={copyResult}
                    className="px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer border border-slate-600 shadow"
                    title="賳爻禺"
                  >
                    {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-amber-300" />}
                    <span>{copied ? '鬲賲 丕賱賳爻禺!' : '賳爻禺 丕賱賳氐'}</span>
                  </button>
                  <button
                    onClick={shareResult}
                    className="px-3.5 py-1.5 rounded-lg bg-blue-700 hover:bg-blue-600 text-white text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer shadow border border-blue-500/50"
                    title="賲卮丕乇賰丞"
                  >
                    <Share2 className="w-3.5 h-3.5" />
                    <span>賲卮丕乇賰丞</span>
                  </button>
                  <button
                    onClick={exportToWord}
                    className="px-3.5 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-bold flex items-center gap-1.5 shadow transition-all cursor-pointer"
                    title="鬲氐丿賷乇 Word"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>鬲氐丿賷乇 Word</span>
                  </button>
                  <button
                    onClick={handlePrint}
                    className="px-3.5 py-1.5 rounded-lg bg-[#b45309] hover:bg-amber-600 text-white text-xs font-bold flex items-center gap-1.5 shadow transition-all cursor-pointer"
                    title="胤亘丕毓丞"
                  >
                    <Printer className="w-3.5 h-3.5" />
                    <span>胤亘丕毓丞</span>
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
