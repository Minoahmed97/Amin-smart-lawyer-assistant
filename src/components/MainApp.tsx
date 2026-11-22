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
        return savedTab as any;
      }
    } catch {}
    return 'deconstruct';
  });

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

  const handleChangeRoleRequest = () => {
    setActiveTab('deconstruct');
  };

  const handleTabChange = (targetTab: 'draft' | 'deconstruct' | 'qualify' | 'defenses' | 'vault' | 'community') => {
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
    const caseContext: LegalCaseContext = {
      schemaVersion: 1,
      caseId: createCaseId(),
      updatedAt: capturedAt,
      court: '',
      circuit: '',
      caseNumber: '',
      clientName: '',
      clientRole: '',
      opponentName: '',
      caseNature: '',
      proceduralStage: '',
      proceduralStageSource: 'not_provided',
      clientGoals: clientGoals.trim(),
      materials: facts.trim() ? [{
        id: `material-${Date.now()}`,
        kind: 'case_facts',
        title: 'وقائع النزاع المقدمة في مرحلة التكييف',
        content: facts.trim(),
        sourceView: 'qualification',
        capturedAt,
      }] : [],
      priorAnalysis: qualificationAnalysis.trim() ? [{
        type: 'qualification',
        content: qualificationAnalysis.trim(),
        capturedAt,
      }] : [],
      verificationNotes: ['لم تُحدد المرحلة الإجرائية صراحةً؛ يلزم إدخالها أو التحقق منها من ملف القضية.'],
    };
    const caseAnalysisContext = [
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
    setActiveTab('draft');
  };

  const handleInsertDefenseFromCodex = (defenseSnippet: string) => {
    setDraftingData((prev) => ({
      ...prev,
      defenses: prev.defenses
        ? `${prev.defenses}\n\n[دفع قضائي]:\n${defenseSnippet}`
        : `[دفع قضائي]:\n${defenseSnippet}`,
    }));
    setActiveTab('draft');
  };

  const handleUseModelInDrafting = (modelContent: string) => {
    setDraftingData((prev) => ({
      ...prev,
      facts: prev.facts
        ? `${prev.facts}\n\n[نموذج استرشادي]:\n${modelContent.slice(0, 800)}...`
        : `[نموذج استرشادي]:\n${modelContent.slice(0, 800)}...`,
    }));
    setActiveTab('draft');
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
    const caseContext: LegalCaseContext = {
      schemaVersion: 1,
      caseId: createCaseId(),
      updatedAt: capturedAt,
      court: '',
      circuit: '',
      caseNumber: '',
      clientName: '',
      clientRole: '',
      opponentName: '',
      caseNature: lockedCaseNature,
      proceduralStage: '',
      proceduralStageSource: 'not_provided',
      clientGoals: '',
      materials: opponentFacts.trim() ? [{
        id: `material-${Date.now()}`,
        kind: 'opponent_pleading',
        title: 'المذكرة أو المستند المقدم من الخصم',
        content: opponentFacts.trim(),
        sourceView: 'deconstruction',
        capturedAt,
      }] : [],
      priorAnalysis: analysisContext?.trim() ? [{
        type: 'deconstruction',
        content: analysisContext.trim().slice(0, 26000),
        capturedAt,
      }] : [],
      verificationNotes: [
        'بيانات المحكمة ورقم الدعوى وأطرافها وصفة الموكل لم تُنقل من شاشة التفنيد؛ يجب استكمالها من ملف القضية.',
        'لم تُحدد المرحلة الإجرائية صراحةً؛ لا يجوز استنتاجها من مجرد نص مذكرة الخصم.',
      ],
    };
    const caseAnalysisContext = `[ملف القضية المنظم — مرجع سابق]:\n${JSON.stringify(caseContext, null, 2)}\n\n${analysisContext?.trim() ? `[نتائج التفنيد والتحليل السابق — مرتبطة بذات النزاع]:\n${analysisContext.trim().slice(0, 26000)}\n\nأعد مطابقة كل نتيجة مع الوقائع والمستندات الحالية، ولا تنقل استنتاجاً أو دفعاً دون التحقق من سنده. عند وجود تعارض، اعرضه ولا تتجاهله.` : ''}`;

    setDraftingData({
      facts: opponentFacts,
      defenses: draftCounter,
      briefType: selectedResponseType,
      judicialWorkType: selectedResponseType,
      customInstructions: transferInstruction,
      caseAnalysisContext,
      caseContext,
    });
    setActiveTab('draft');
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

      {/* Main Tab Content - Kept mounted in DOM to prevent losing state when navigating */}
      <main className="flex-1 py-3 sm:py-5">
        {(
          <>
            <div style={{ display: activeTab === 'deconstruct' ? 'block' : 'none' }}>
              <DeconstructView
                userId={userId}
                onSwitchTab={handleTabChange}
                onTransferToDrafting={handleTransferFromDeconstruct}
              />
            </div>

            <div style={{ display: activeTab === 'draft' ? 'block' : 'none' }}>
              <DraftingView
                initialFormData={draftingData}
                userId={userId}
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
