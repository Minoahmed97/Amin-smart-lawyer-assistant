import React, { useState, useEffect } from 'react';
import { Header } from './Header.tsx';
import { DraftingView } from './DraftingView.tsx';
import { DeconstructView } from './DeconstructView.tsx';
import { LegalQualifyView } from './LegalQualifyView.tsx';
import { DefensesCodexView } from './DefensesCodexView.tsx';
import { LegalVaultView } from './LegalVaultView.tsx';
import { CommunityWallView } from './CommunityWallView.tsx';
import { BroadcastBanner } from './BroadcastBanner.tsx';
import { AdminApiModal } from './AdminApiModal.tsx';
import { DraftingFormData, LegalCaseContext } from '../types.ts';
import { listLegalCases, saveLegalCase, LegalCaseRecord } from '../services/legalCaseService.ts';
import { getAllLawModels } from '../utils/legalVaultService.ts';
import { UserRole } from '../utils/deviceFingerprint.ts';
import { persistentStorage } from '../utils/persistentStorage.ts';
import { initAnalyticsTracking, stopAnalyticsTracking, recordAnalyticsEvent } from '../services/analyticsService.ts';
import { enableCompletionPushNotifications } from '../services/aiService.ts';
import { Scale, Shield, FolderArchive, AlertTriangle, Megaphone } from 'lucide-react';

interface MainAppProps {
  user: any;
  onLogout: () => void;
}

export const MainApp: React.FC<MainAppProps> = ({ user, onLogout }) => {
  // This application is intentionally lawyer-only. There is no litigant/client role.
  const userRole: UserRole = 'lawyer';

  // Theme Management (Executive Dark Judicial Palette by default)
  const [theme, setTheme] = useState<'warm-light' | 'dark'>(() => {
    try {
      const saved = localStorage.getItem('judicial_theme');
      if (saved === 'dark' || saved === 'warm-light') return saved;
    } catch {}
    return 'dark';
  });

  useEffect(() => {
    try {
      localStorage.setItem('judicial_theme', theme);
      if (theme === 'dark') {
        document.body.classList.add('dark-theme');
      } else {
        document.body.classList.remove('dark-theme');
      }
    } catch {}
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'warm-light' ? 'dark' : 'warm-light'));
  };

  // Tab State Persistence
  const [activeTab, setActiveTab] = useState<'draft' | 'deconstruct' | 'qualify' | 'defenses' | 'vault' | 'community'>(() => {
    try {
      const savedTab = persistentStorage.getItem('judicial_active_tab', '');
      if (savedTab && ['draft', 'deconstruct', 'qualify', 'defenses', 'vault', 'community'].includes(savedTab)) {
        return savedTab === 'draft' ? 'deconstruct' : savedTab as any;
      }
    } catch {}
    return 'deconstruct';
  });

  const [aiWorkMode, setAiWorkMode] = useState<'deconstruct' | 'reply' | 'drafting'>(() => {
    try {
      const savedMode = persistentStorage.getItem('judicial_ai_work_mode', '');
      if (savedMode === 'deconstruct' || savedMode === 'reply' || savedMode === 'drafting') return savedMode;
      return persistentStorage.getItem('judicial_active_tab', '') === 'draft' ? 'drafting' : 'deconstruct';
    } catch { return 'deconstruct'; }
  });

  useEffect(() => {
    persistentStorage.setItem('judicial_ai_work_mode', aiWorkMode);
  }, [aiWorkMode]);

  useEffect(() => {
    if (activeTab) {
      persistentStorage.setItem('judicial_active_tab', activeTab);
    }
  }, [activeTab]);

  useEffect(() => {
    void initAnalyticsTracking(onLogout);
    return () => stopAnalyticsTracking();
  }, [onLogout]);

  const [isAdminOpen, setIsAdminOpen] = useState<boolean>(false);
  const userId = user?.id || '';
  const userName = user?.name || user?.user_metadata?.full_name || user?.username || 'المستشار القانوني';

  const [vaultModelsCount, setVaultModelsCount] = useState<number>(0);

  // Shared form data for cross-tab workflows
  const [draftingData, setDraftingData] = useState<Partial<DraftingFormData>>({});

  const [legalCases, setLegalCases] = useState<LegalCaseRecord[]>([]);
  const [activeCaseId, setActiveCaseId] = useState<string>(() => persistentStorage.getItem(`amin_active_legal_case_${String(userId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_')}`, ''));
  const [caseSelectionRevision, setCaseSelectionRevision] = useState(0);
  const [caseStorageStatus, setCaseStorageStatus] = useState<'loading' | 'cloud' | 'local' | 'error'>('loading');

  const restoreCaseIntoDrafting = (context: LegalCaseContext) => {
    const preferredFacts = [...(context.materials || [])].reverse().find((item) => item.kind === 'drafting_snapshot')
      || [...(context.materials || [])].reverse().find((item) => item.kind === 'case_facts' || item.kind === 'opponent_pleading');
    const caseAnalysisContext = [
      '[ملف القضية المستعاد — البيانات المنظمة]:',
      JSON.stringify(context, null, 2),
      ...(context.priorAnalysis || []).map((item) => `[تحليل سابق - ${item.type}]:\n${item.content}`),
    ].join('\n\n').slice(0, 28000);
    setDraftingData({
      courtType: context.court || '',
      circuit: context.circuit || '',
      caseNumber: context.caseNumber || '',
      clientName: context.clientName || '',
      clientRole: context.clientRole || '',
      opponentName: context.opponentName || '',
      sessionDate: context.sessionDate || '',
      briefType: context.selectedDocumentType || '',
      judicialWorkType: context.selectedDocumentType || '',
      facts: preferredFacts?.content || '',
      defenses: context.defenses || '',
      requests: context.requests || '',
      caseAnalysisContext,
      caseContext: context,
    });
  };

  useEffect(() => {
    let active = true;
    setCaseStorageStatus('loading');
    void listLegalCases(userId).then(({ cases, cloudAvailable }) => {
      if (!active) return;
      setLegalCases(cases);
      setCaseStorageStatus(cloudAvailable ? 'cloud' : 'local');
      const storedActiveId = persistentStorage.getItem(`amin_active_legal_case_${String(userId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_')}`, '');
      const selected = cases.find((row) => row.case_id === storedActiveId) || null;
      if (selected) {
        setActiveCaseId(selected.case_id);
        restoreCaseIntoDrafting(selected.case_data);
        setCaseSelectionRevision((value) => value + 1);
      } else {
        setActiveCaseId('');
        persistentStorage.removeItem(`amin_active_legal_case_${String(userId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_')}`);
      }
    }).catch(() => { if (active) setCaseStorageStatus('error'); });
    return () => { active = false; };
  }, [userId]);

  useEffect(() => {
    const context = draftingData.caseContext;
    if (!context?.caseId) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void saveLegalCase(userId, context).then(({ cases, cloudSaved }) => {
        if (!active) return;
        setLegalCases(cases);
        setCaseStorageStatus(cloudSaved ? 'cloud' : 'local');
        setActiveCaseId(context.caseId);
        persistentStorage.setItem(`amin_active_legal_case_${String(userId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_')}`, context.caseId);
      });
    }, 650);
    return () => { active = false; window.clearTimeout(timer); };
  }, [userId, draftingData.caseContext]);


  const handleChangeRoleRequest = () => {
    setActiveTab('deconstruct');
  };

  const handleTabChange = (targetTab: 'draft' | 'deconstruct' | 'qualify' | 'defenses' | 'vault' | 'community') => {
    if (targetTab === 'draft') {
      setAiWorkMode('drafting');
      setActiveTab('deconstruct');
      return;
    }
    setActiveTab(targetTab);
  };

  useEffect(() => {
    const models = getAllLawModels(userId);
    setVaultModelsCount(models.length);

    (window as any).openAdminModal = () => setIsAdminOpen(true);
  }, [user, userId]);

  const createCaseId = () => `case-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const handleDraftFromQualify = (facts: string, qualificationAnalysis = '', clientGoals = '') => {
    const capturedAt = new Date().toISOString();
    const existingCase = activeCaseId && draftingData.caseContext?.caseId === activeCaseId ? draftingData.caseContext : null;
    const caseContext: LegalCaseContext = {
      schemaVersion: 1,
      caseId: existingCase?.caseId || createCaseId(),
      updatedAt: capturedAt,
      court: existingCase?.court || '',
      circuit: existingCase?.circuit || '',
      caseNumber: existingCase?.caseNumber || '',
      clientName: existingCase?.clientName || '',
      clientRole: existingCase?.clientRole || '',
      opponentName: existingCase?.opponentName || '',
      caseNature: existingCase?.caseNature || '',
      selectedDocumentType: existingCase?.selectedDocumentType || '',
      sessionDate: existingCase?.sessionDate || '',
      defenses: existingCase?.defenses || '',
      requests: existingCase?.requests || '',
      proceduralStage: existingCase?.proceduralStage || '',
      proceduralStageSource: existingCase?.proceduralStageSource || 'not_provided',
      clientGoals: clientGoals.trim() || existingCase?.clientGoals || '',
      materials: [...(existingCase?.materials || []), ...(facts.trim() ? [{
        id: `material-${Date.now()}`,
        kind: 'case_facts',
        title: 'وقائع النزاع المقدمة في مرحلة التكييف',
        content: facts.trim(),
        sourceView: 'qualification',
        capturedAt,
      }] : [])],
      priorAnalysis: [...(existingCase?.priorAnalysis || []), ...(qualificationAnalysis.trim() ? [{
        type: 'qualification',
        content: qualificationAnalysis.trim(),
        capturedAt,
      }] : [])],
      verificationNotes: [...(existingCase?.verificationNotes || []), 'لم تُحدد المرحلة الإجرائية صراحةً؛ يلزم إدخالها أو التحقق منها من ملف القضية.'],
    };
    const caseContextSummary = { schemaVersion: caseContext.schemaVersion, caseId: caseContext.caseId, updatedAt: caseContext.updatedAt, court: caseContext.court, circuit: caseContext.circuit, caseNumber: caseContext.caseNumber, clientName: caseContext.clientName, clientRole: caseContext.clientRole, opponentName: caseContext.opponentName, caseNature: caseContext.caseNature, selectedDocumentType: caseContext.selectedDocumentType, sessionDate: caseContext.sessionDate, defenses: caseContext.defenses, requests: caseContext.requests, proceduralStage: caseContext.proceduralStage, proceduralStageSource: caseContext.proceduralStageSource, clientGoals: caseContext.clientGoals, verificationNotes: caseContext.verificationNotes };
    const caseAnalysisContext = [
      ...(existingCase?.priorAnalysis || []).map((item) => `[تحليل سابق - ${item.type}]:\n${item.content}`),
      '[بيانات ملف القضية المنظمة]:',
      JSON.stringify(caseContextSummary, null, 2),
      '[تحليل التكييف القانوني السابق — مرتبط بذات النزاع]',
      clientGoals.trim() ? `[هدف الموكل في مرحلة التكييف]:\n${clientGoals.trim()}` : '',
      qualificationAnalysis.trim(),
      'هذا تحليل سابق مرجعي؛ أعد اختبار استنتاجاته على الوقائع والمستندات الحالية، ولا تعتمد أي نقطة لا يسندها السياق الحالي.',
    ].filter(Boolean).join('\n\n').slice(0, 28000);
    setDraftingData((prev) => ({
      ...prev,
      facts,
      caseAnalysisContext,
      caseContext,
    }));
    setCaseSelectionRevision((value) => value + 1);
    setAiWorkMode('drafting');
    setActiveTab('deconstruct');
  };

  const handleInsertDefenseFromCodex = (defenseSnippet: string) => {
    setDraftingData((prev) => ({
      ...prev,
      defenses: prev.defenses
        ? `${prev.defenses}\n\n[دفع قضائي]:\n${defenseSnippet}`
        : `[دفع قضائي]:\n${defenseSnippet}`,
    }));
    setAiWorkMode('drafting');
    setActiveTab('deconstruct');
  };

  const handleUseModelInDrafting = (modelContent: string) => {
    setDraftingData((prev) => ({
      ...prev,
      facts: prev.facts
        ? `${prev.facts}\n\n[نموذج استرشادي]:\n${modelContent.slice(0, 800)}...`
        : `[نموذج استرشادي]:\n${modelContent.slice(0, 800)}...`,
    }));
    setAiWorkMode('drafting');
    setActiveTab('deconstruct');
  };

  const handleTransferFromDeconstruct = (
    opponentFacts: string,
    draftCounter: string,
    caseNature?: string,
    responseWorkType?: string,
    analysisContext?: string,
  ) => {
    const lockedCaseNature = caseNature?.trim() || '';
    const selectedResponseType = responseWorkType?.trim() || '';
    const transferInstruction = [
      'هذه الصياغة ناتجة مباشرة عن فحص المستند في مرحلة التفكيك.',
      lockedCaseNature
        ? `طبيعة الدعوى التي تم فحصها: "${lockedCaseNature}". لا تستبدلها أو تعيد تكييفها إلى نوع دعوى آخر دون طلب صريح من المحامي.`
        : 'لم تُحدد طبيعة الدعوى نصاً؛ استخلصها من الوقائع الحالية ولا تفترض نوع دعوى مختلفاً.',
      selectedResponseType
        ? `نوع المستند المطلوب للرد: "${selectedResponseType}". التزم بهذا النوع ولا تحوله إلى نوع آخر.`
        : 'نوع المستند المطلوب لم يُحدد يدوياً؛ استخدم نوع المستند الذي حددته مرحلة التفكيك، ولا تفترض تلقائياً أنها مذكرة دفاع.',
      'افصل دائماً بين طبيعة الدعوى ونوع المستند المطلوب صياغته.',
    ].join('\n');

    const capturedAt = new Date().toISOString();
    const existingCase = activeCaseId && draftingData.caseContext?.caseId === activeCaseId ? draftingData.caseContext : null;
    const caseContext: LegalCaseContext = {
      schemaVersion: 1,
      caseId: existingCase?.caseId || createCaseId(),
      updatedAt: capturedAt,
      court: existingCase?.court || '',
      circuit: existingCase?.circuit || '',
      caseNumber: existingCase?.caseNumber || '',
      clientName: existingCase?.clientName || '',
      clientRole: existingCase?.clientRole || '',
      opponentName: existingCase?.opponentName || '',
      caseNature: lockedCaseNature || existingCase?.caseNature || '',
      selectedDocumentType: selectedResponseType || existingCase?.selectedDocumentType || '',
      sessionDate: existingCase?.sessionDate || '',
      defenses: draftCounter || existingCase?.defenses || '',
      requests: existingCase?.requests || '',
      proceduralStage: existingCase?.proceduralStage || '',
      proceduralStageSource: existingCase?.proceduralStageSource || 'not_provided',
      clientGoals: existingCase?.clientGoals || '',
      materials: [...(existingCase?.materials || []), ...(opponentFacts.trim() ? [{
        id: `material-${Date.now()}`,
        kind: 'opponent_pleading',
        title: 'المذكرة أو المستند المقدم من الخصم',
        content: opponentFacts.trim(),
        sourceView: 'deconstruction',
        capturedAt,
      }] : [])],
      priorAnalysis: [...(existingCase?.priorAnalysis || []), ...(analysisContext?.trim() ? [{
        type: 'deconstruction',
        content: analysisContext.trim().slice(0, 26000),
        capturedAt,
      }] : [])],
      verificationNotes: [
        ...(existingCase?.verificationNotes || []),
        'بيانات المحكمة ورقم الدعوى وأطرافها وصفة الموكل لم تُنقل من شاشة التفنيد؛ يجب استكمالها من ملف القضية.',
        'لم تُحدد المرحلة الإجرائية صراحةً؛ لا يجوز استنتاجها من مجرد نص مذكرة الخصم.',
      ],
    };
    const caseContextSummary = { schemaVersion: caseContext.schemaVersion, caseId: caseContext.caseId, updatedAt: caseContext.updatedAt, court: caseContext.court, circuit: caseContext.circuit, caseNumber: caseContext.caseNumber, clientName: caseContext.clientName, clientRole: caseContext.clientRole, opponentName: caseContext.opponentName, caseNature: caseContext.caseNature, selectedDocumentType: caseContext.selectedDocumentType, sessionDate: caseContext.sessionDate, defenses: caseContext.defenses, requests: caseContext.requests, proceduralStage: caseContext.proceduralStage, proceduralStageSource: caseContext.proceduralStageSource, clientGoals: caseContext.clientGoals, verificationNotes: caseContext.verificationNotes };
    const caseAnalysisContext = [
      '[بيانات ملف القضية المنظمة]:',
      JSON.stringify(caseContextSummary, null, 2),
      ...(existingCase?.priorAnalysis || []).map((item) => `[تحليل سابق - ${item.type}]:\n${item.content}`),
      analysisContext?.trim() ? `[نتائج التفنيد والتحليل السابق — مرتبطة بذات النزاع]:\n${analysisContext.trim().slice(0, 26000)}\n\nأعد مطابقة كل نتيجة مع الوقائع والمستندات الحالية، ولا تنقل استنتاجاً أو دفعاً دون التحقق من سنده. عند وجود تعارض، اعرضه ولا تتجاهله.` : '',
    ].filter(Boolean).join('\n\n');

    setDraftingData({
      facts: opponentFacts,
      defenses: draftCounter,
      briefType: selectedResponseType,
      judicialWorkType: selectedResponseType,
      customInstructions: transferInstruction,
      caseAnalysisContext,
      caseContext,
    });
    setCaseSelectionRevision((value) => value + 1);
    setAiWorkMode('drafting');
    setActiveTab('deconstruct');
  };

  const handleEnableNotifications = async () => {
    if (typeof Notification === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      window.alert('هذا المتصفح أو الجهاز لا يدعم إشعارات Push المطلوبة.');
      return;
    }
    if (Notification.permission === 'default') {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        window.alert('لم يتم منح إذن الإشعارات. يمكنك تفعيله من إعدادات الموقع في المتصفح.');
        return;
      }
    }
    const result = await enableCompletionPushNotifications();
    if (result === 'enabled') window.alert('تم تفعيل إشعارات انتهاء المهام التي تُعالج على الخادم، وستصلك حتى عند إغلاق التطبيق. استخراج Word المحلي سيعرض إشعارًا إذا ظل التطبيق مفتوحًا أثناء الاستخراج.');
    else if (result === 'unsupported') window.alert('المتصفح أو الجهاز لا يدعم إشعارات Push المطلوبة.');
    else if (result === 'denied') window.alert('إذن الإشعارات مرفوض من إعدادات المتصفح. فعّله للموقع ثم أعد المحاولة.');
    else window.alert('تعذر حفظ اشتراك الإشعارات. تحقق من إعدادات VAPID والاتصال ثم أعد المحاولة.');
  };

  return (
    <div
      className={`min-h-screen min-h-[100dvh] flex flex-col font-sans transition-colors duration-200 overflow-x-hidden ${
        theme === 'warm-light'
          ? 'bg-slate-100 text-slate-900 selection:bg-amber-500/30 selection:text-amber-900'
          : 'bg-[#090d16] text-slate-100 selection:bg-[#b45309]/30 selection:text-amber-200'
      }`}
    >
      {/* Main Judicial Header */}
      <Header
        activeTab={activeTab}
        setActiveTab={handleTabChange}
        onOpenAdmin={() => setIsAdminOpen(true)}
        userName={userName}
        vaultModelsCount={vaultModelsCount}
        userRole={userRole || 'lawyer'}
        onChangeRole={handleChangeRoleRequest}
        theme={theme}
        onToggleTheme={toggleTheme}
        onLogout={onLogout}
        onEnableNotifications={handleEnableNotifications}
      />

      {/* Admin Control Modal */}
      <AdminApiModal
        isOpen={isAdminOpen}
        onClose={() => setIsAdminOpen(false)}
      />

      {/* Global Broadcast Announcement from Admin */}
      <BroadcastBanner onSwitchTab={handleTabChange} />

      {legalCases.length > 0 && (
        <div className="mx-auto w-full max-w-7xl px-3 pt-3">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-black/10 p-3">
            <label htmlFor="amin-active-legal-case" className="text-sm font-semibold">ملف القضية النشط</label>
            <select
              id="amin-active-legal-case"
              value={activeCaseId}
              onChange={(event) => {
                const selectedId = event.target.value;
                setActiveCaseId(selectedId);
                persistentStorage.setItem(`amin_active_legal_case_${String(userId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_')}`, selectedId);
                const selected = legalCases.find((row) => row.case_id === selectedId);
                if (selected) {
                  restoreCaseIntoDrafting(selected.case_data);
                  setCaseSelectionRevision((value) => value + 1);
                }
              }}
              className="min-w-0 flex-1 rounded-lg border border-white/15 bg-slate-900 px-3 py-2 text-sm text-white"
            >
              <option value="">اختر ملف قضية محفوظًا</option>
              {legalCases.map((row) => (
                <option key={row.case_id} value={row.case_id}>
                  {[row.case_data.caseNumber, row.case_data.clientName, row.case_data.caseNature].filter(Boolean).join(' — ') || `ملف قضية ${row.case_id.slice(-6)}`}
                </option>
              ))}
            </select>
            <span className="text-xs text-slate-400">
              {caseStorageStatus === 'cloud' ? 'محفوظ سحابيًا' : caseStorageStatus === 'local' ? 'حفظ محلي مؤقت' : caseStorageStatus === 'loading' ? 'جارٍ تحميل الملفات…' : 'تعذر تحميل التخزين'}
            </span>
          </div>
        </div>
      )}

      {/* Main Tab Content - Kept mounted in DOM to prevent losing state when navigating */}
      <main className="flex-1 py-3 sm:py-5">
        {activeTab === 'deconstruct' && (
          <div className="mx-auto mb-4 flex max-w-7xl flex-wrap items-center gap-2 px-3 sm:px-6 lg:px-8">
            <span className="text-sm font-bold text-slate-300">نوع المهمة:</span>
            <button type="button" onClick={() => setAiWorkMode('deconstruct')} aria-pressed={aiWorkMode === 'deconstruct'} className={`rounded-xl border px-4 py-2 text-sm font-bold transition-colors ${aiWorkMode === 'deconstruct' ? 'border-amber-400 bg-amber-600 text-white' : 'border-slate-600 bg-slate-900 text-slate-300'}`}>التفنيد</button>
            <button type="button" onClick={() => setAiWorkMode('reply')} aria-pressed={aiWorkMode === 'reply'} className={`rounded-xl border px-4 py-2 text-sm font-bold transition-colors ${aiWorkMode === 'reply' ? 'border-amber-400 bg-amber-600 text-white' : 'border-slate-600 bg-slate-900 text-slate-300'}`}>الرد على المستندات</button>
            <button type="button" onClick={() => setAiWorkMode('drafting')} aria-pressed={aiWorkMode === 'drafting'} className={`rounded-xl border px-4 py-2 text-sm font-bold transition-colors ${aiWorkMode === 'drafting' ? 'border-amber-400 bg-amber-600 text-white' : 'border-slate-600 bg-slate-900 text-slate-300'}`}>الصياغة القانونية</button>
          </div>
        )}
        {(
          <>
            <div style={{ display: activeTab === 'deconstruct' && (aiWorkMode === 'deconstruct' || aiWorkMode === 'reply') ? 'block' : 'none' }}>
              <DeconstructView
                key={aiWorkMode}
                userId={userId}
                taskMode={aiWorkMode === 'reply' ? 'reply' : 'deconstruct'}
                caseContext={draftingData.caseContext}
                onSwitchTab={handleTabChange}
                onTransferToDrafting={handleTransferFromDeconstruct}
              />
            </div>

            <div style={{ display: activeTab === 'deconstruct' && aiWorkMode === 'drafting' ? 'block' : 'none' }}>
              <DraftingView
                initialFormData={draftingData}
                userId={userId}
                onCaseContextChange={(context) => setDraftingData((prev) => ({ ...prev, caseContext: context }))}
                caseSelectionRevision={caseSelectionRevision}
                    onSwitchTab={handleTabChange}
              />
            </div>

            <div style={{ display: activeTab === 'qualify' ? 'block' : 'none' }}>
              <LegalQualifyView
                userId={userId}
                onDraftBriefFromQualify={handleDraftFromQualify}
                isClientOnly={false}
              />
            </div>

            <div style={{ display: activeTab === 'defenses' ? 'block' : 'none' }}>
              <DefensesCodexView onInsertDefense={handleInsertDefenseFromCodex} />
            </div>

            <div style={{ display: activeTab === 'vault' ? 'block' : 'none' }}>
              <LegalVaultView
                userId={userId}
                onUseModelInDrafting={handleUseModelInDrafting}
                onSwitchTab={handleTabChange}
                onModelsCountChanged={(count) => setVaultModelsCount(count)}
              />
            </div>

            <div style={{ display: activeTab === 'community' ? 'block' : 'none' }}>
              <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8">
                <CommunityWallView theme={theme} />
              </div>
            </div>
          </>
        )}
      </main>

      {/* Legal Disclaimer & Footer */}
      <footer
        className={`no-print mt-10 sm:mt-12 border-t-2 border-[#b45309] py-6 sm:py-8 text-xs transition-colors ${
          theme === 'warm-light'
            ? 'bg-white text-slate-800 shadow-md border-t-amber-600/40'
            : 'bg-[#0f172a] text-slate-300'
        }`}
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-4">
          <div
            className={`border-2 rounded-2xl p-4 text-center shadow-md ${
              theme === 'warm-light'
                ? 'bg-amber-50/90 border-amber-300 text-amber-950'
                : 'bg-amber-950/40 border-amber-500/60 text-amber-100'
            }`}
          >
            <div className="flex items-center justify-center gap-2 text-amber-600 font-bold text-sm sm:text-base mb-1">
              <AlertTriangle className="w-5 h-5 text-amber-600 flex-shrink-0" />
              <span>إخلاء مسؤولية قانوني مهني:</span>
            </div>
            <p
              className={`text-xs sm:text-sm font-semibold max-w-4xl mx-auto leading-relaxed ${
                theme === 'warm-light' ? 'text-amber-900' : 'text-amber-100/90'
              }`}
            >
              "المساعد القضائي أداة تقنية مساندة للسادة المحامين، وتخضع المخرجات دائماً للمراجعة المهنية للمحامي."
            </p>
          </div>

          <div className="flex flex-col md:flex-row items-center justify-between gap-4 pt-2">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-[#b45309]/20 border border-[#b45309] flex items-center justify-center text-amber-600 flex-shrink-0">
                <Scale className="w-5 h-5" />
              </div>
              <div>
                <p className={`font-bold text-sm ${theme === 'warm-light' ? 'text-slate-900' : 'text-white'}`}>
                  منظومة أمين القضائية الذكية
                </p>
                <p className={`text-[11px] ${theme === 'warm-light' ? 'text-slate-600' : 'text-slate-400'}`}>
                  إصدار عام 2026 - مساند للمحاكم المصرية
                </p>
              </div>
            </div>

            <div
              className={`flex items-center gap-4 flex-wrap justify-center sm:justify-start ${
                theme === 'warm-light' ? 'text-slate-600' : 'text-slate-400'
              }`}
            >
              <button
                onClick={() => setActiveTab('vault')}
                className="text-amber-600 hover:text-amber-700 font-bold flex items-center gap-1 cursor-pointer"
              >
                <FolderArchive className="w-3.5 h-3.5" />
                <span>الخزينة</span>
              </button>
              <span>•</span>
              <button
                onClick={() => setActiveTab('community')}
                className="text-amber-600 hover:text-amber-700 font-bold flex items-center gap-1 cursor-pointer"
              >
                <Megaphone className="w-3.5 h-3.5" />
                <span>المجتمع</span>
              </button>
              <span>•</span>
              <span className="flex items-center gap-1 text-emerald-700 font-semibold">
                <Shield className="w-3.5 h-3.5 text-emerald-600" />
                بيانات مشفرة
              </span>
              <span>•</span>
              <button
                onClick={() => setIsAdminOpen(true)}
                aria-label="لوحة تحكم الإدارة"
                className="w-6 h-6 p-0 m-0 opacity-0 cursor-pointer"
              />
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
};
