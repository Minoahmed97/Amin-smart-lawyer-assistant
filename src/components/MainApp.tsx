import React, { useState, useEffect } from 'react';
import { Header } from './Header.tsx';
import { DraftingView } from './DraftingView.tsx';
import { DeconstructView } from './DeconstructView.tsx';
import { LegalQualifyView } from './LegalQualifyView.tsx';
import { DefensesCodexView } from './DefensesCodexView.tsx';
import { LegalVaultView } from './LegalVaultView.tsx';
import { PackagesView } from './PackagesView.tsx';
import { CommunityWallView } from './CommunityWallView.tsx';
import { BroadcastBanner } from './BroadcastBanner.tsx';
import { AdminApiModal } from './AdminApiModal.tsx';
import { SubscribeModal } from './SubscribeModal.tsx';
import { DraftingFormData } from '../types.ts';
import { getAllLawModels } from '../utils/legalVaultService.ts';
import {
  UserRole,
  getCurrentStoredCredits,
} from '../utils/deviceFingerprint.ts';
import { persistentStorage } from '../utils/persistentStorage.ts';
import { initAnalyticsTracking, stopAnalyticsTracking, recordAnalyticsEvent } from '../services/analyticsService.ts';
import { Scale, Shield, AlertOctagon, CreditCard, FolderArchive, AlertTriangle, Megaphone } from 'lucide-react';

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
  const [activeTab, setActiveTab] = useState<'draft' | 'deconstruct' | 'qualify' | 'defenses' | 'packages' | 'vault' | 'community'>(() => {
    try {
      const savedTab = persistentStorage.getItem('judicial_active_tab', '');
      if (savedTab && ['draft', 'deconstruct', 'qualify', 'defenses', 'packages', 'vault', 'community'].includes(savedTab)) {
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
  const [isSubscribeOpen, setIsSubscribeOpen] = useState<boolean>(false);
  const userId = user?.id || '';
  const userName = user?.name || user?.user_metadata?.full_name || user?.username || 'المستشار القانوني';

  const [credits, setCredits] = useState<number>(() => Number(user?.credits || user?.trialOperationsRemaining || 0));
  const [vaultModelsCount, setVaultModelsCount] = useState<number>(0);

  // Shared form data for cross-tab workflows
  const [draftingData, setDraftingData] = useState<Partial<DraftingFormData>>({});

  const handleChangeRoleRequest = () => {
    setActiveTab('deconstruct');
  };

  const handleTabChange = (targetTab: 'draft' | 'deconstruct' | 'qualify' | 'defenses' | 'packages' | 'vault' | 'community') => {
    setActiveTab(targetTab);
  };

  useEffect(() => {
    setCredits(getCurrentStoredCredits());

    const handleCreditChange = (e: any) => {
      if (e.detail && typeof e.detail.credits === 'number') {
        setCredits(e.detail.credits);
      } else {
        setCredits(getCurrentStoredCredits());
      }
    };

    window.addEventListener('judicial_credits_change', handleCreditChange);

    const models = getAllLawModels(userId);
    setVaultModelsCount(models.length);

    (window as any).openSubscribeModal = () => setIsSubscribeOpen(true);
    (window as any).openAdminModal = () => setIsAdminOpen(true);

    return () => {
      window.removeEventListener('judicial_credits_change', handleCreditChange);
      };
  }, [user, userId]);

  const handleDraftFromQualify = (facts: string) => {
        setDraftingData((prev) => ({
      ...prev,
      facts,
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
    responseType?: string,
  ) => {
    const lockedCaseNature = caseNature?.trim() || '';
    const selectedResponseType = responseType?.trim() || '';
    setDraftingData({
      facts: opponentFacts,
      defenses: draftCounter,
      briefType: selectedResponseType,
      judicialWorkType: lockedCaseNature,
      customInstructions: `${lockedCaseNature ? `هذه الصياغة ناتجة مباشرة عن فحص مذكرة الخصم في مرحلة التفكيك. طبيعة الدعوى/النزاع المثبتة في الفحص هي: "${lockedCaseNature}". لا تستبدلها أو تعيد تكييفها إلى دعوى أخرى.` : 'حافظ على طبيعة الدعوى والموضوع كما استُخلصا من مرحلة التفكيك ولا تخترع دعوى مختلفة.'} ${selectedResponseType ? `نوع المستند المطلوب من المحامي هو: "${selectedResponseType}". التزم به.` : 'لم يحدد المحامي نوع المستند. حدّد بذكاء نوع المستند القانوني الأنسب للرد على المستند المفحوص، مثل مذكرة رد/دفاع، عريضة/صحيفة دعوى، صحيفة طعن، حافظة مستندات، إنذار أو غير ذلك بحسب الغرض والطلبات والوقائع. لا تفترض أن الناتج مذكرة دفاع تلقائياً.'}`,
    });
    setActiveTab('draft');
  };

  const handleCreditsUpdated = (newCredits: number) => {
    setCredits(newCredits);
  };

  return (
    <div
      className={`min-h-screen min-h-[100dvh] flex flex-col font-sans transition-colors duration-200 overflow-x-hidden ${
        theme === 'warm-light'
          ? 'bg-slate-100 text-slate-900 selection:bg-amber-500/30 selection:text-amber-900'
          : 'bg-[#090d16] text-slate-100 selection:bg-[#b45309]/30 selection:text-amber-200'
      }`}
    >
      {/* Low/Exhausted Credits Notification Banner */}
      {credits <= 0 && (
        <div className="bg-gradient-to-r from-red-950 via-amber-950 to-red-950 border-b-2 border-amber-500 px-4 py-3 text-xs text-amber-200 flex flex-wrap items-center justify-between gap-3 shadow-xl animate-in fade-in">
          <div className="flex items-center gap-2.5">
            <AlertOctagon className="w-5 h-5 text-amber-400 flex-shrink-0 animate-pulse" />
            <div>
              <span className="font-black text-sm text-white block sm:inline">
                انتهت محاولاتك المجانية المتاحة
              </span>
              <span className="text-amber-200/90 text-xs sm:mr-2">
                (الرصيد المتبقي: 0 محاولات) - يرجى شحن الرصيد للاستمرار.
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <a
              href="https://wa.me/201009319562?text=%D8%A7%D9%84%D8%B3%D9%84%D8%A7%D9%85%20%D8%B9%D9%84%D9%8A%D9%83%D9%85%D8%8C%20%D8%A7%D9%86%D8%AA%D9%87%D8%AA%20%D9%85%D8%AD%D8%A7%D9%88%D9%84%D8%A7%D8%AA%D9%8A%20%D8%A7%D9%84%D9%85%D8%AC%D8%A7%D9%86%D9%8A%D8%A9%20%D9%88%D8%A3%D8%B1%D8%BA%D8%A8%20%D9%81%D9%8A%20%D8%B4%D8%AD%D9%86%20%D8%A7%D9%84%D8%B1%D8%B5%D9%8A%D8%AF%20%D9%88%D8%A5%D8%B1%D8%B3%D8%A7%D9%84%20%D8%A5%D9%8A%D8%B5%D8%A7%D9%84%20%D8%A7%D9%84%D8%AF%D9%81%D8%B9"
              target="_blank"
              rel="noopener noreferrer"
              className="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-bold text-xs transition-colors flex items-center gap-1.5 shadow-md cursor-pointer border border-emerald-400"
              title="تواصل مع الدعم عبر واتساب"
            >
              <span>شحن عبر واتساب (01009319562)</span>
            </a>
            <button
              onClick={() => setActiveTab('packages')}
              className="px-3.5 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded-lg font-bold text-xs transition-colors flex items-center gap-1.5 shadow cursor-pointer border border-amber-400/50"
            >
              <CreditCard className="w-3.5 h-3.5" />
              <span>عرض الباقات</span>
            </button>
          </div>
        </div>
      )}

      {/* Main Judicial Header */}
      <Header
        activeTab={activeTab}
        setActiveTab={handleTabChange}
        onOpenAdmin={() => setIsAdminOpen(true)}
        onOpenSubscribe={() => setIsSubscribeOpen(true)}
        credits={credits}
        userName={userName}
        vaultModelsCount={vaultModelsCount}
        userRole={userRole || 'lawyer'}
        onChangeRole={handleChangeRoleRequest}
        theme={theme}
        onToggleTheme={toggleTheme}
        onLogout={onLogout}
      />

      {/* Subscription & Pricing Modal */}
      <SubscribeModal
        isOpen={isSubscribeOpen}
        onClose={() => setIsSubscribeOpen(false)}
        userId={userId}
        currentCredits={credits}
        onCreditsUpdated={handleCreditsUpdated}
      />

      {/* Admin Control Modal */}
      <AdminApiModal
        isOpen={isAdminOpen}
        onClose={() => setIsAdminOpen(false)}
      />

      {/* Global Broadcast Announcement from Admin */}
      <BroadcastBanner
        onOpenSubscribe={() => setIsSubscribeOpen(true)}
        onSwitchTab={handleTabChange}
      />

      {/* Main Tab Content - Kept mounted in DOM to prevent losing state when navigating */}
      <main className="flex-1 py-3 sm:py-5">
        {(
          <>
            <div style={{ display: activeTab === 'deconstruct' ? 'block' : 'none' }}>
              <DeconstructView
                userId={userId}
                onSwitchTab={handleTabChange}
                onOpenSubscribe={() => setIsSubscribeOpen(true)}
                onCreditsUpdated={handleCreditsUpdated}
                onTransferToDrafting={handleTransferFromDeconstruct}
              />
            </div>

            <div style={{ display: activeTab === 'draft' ? 'block' : 'none' }}>
              <DraftingView
                initialFormData={draftingData}
                userId={userId}
                onOpenSubscribe={() => setIsSubscribeOpen(true)}
                onCreditsUpdated={handleCreditsUpdated}
                onSwitchTab={handleTabChange}
              />
            </div>

            <div style={{ display: activeTab === 'qualify' ? 'block' : 'none' }}>
              <LegalQualifyView
                onDraftBriefFromQualify={handleDraftFromQualify}
                onOpenSubscribe={() => setIsSubscribeOpen(true)}
                onCreditsUpdated={handleCreditsUpdated}
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

            <div style={{ display: activeTab === 'packages' ? 'block' : 'none' }}>
              <PackagesView
                currentCredits={credits}
                userId={userId}
                onCreditsUpdated={handleCreditsUpdated}
                onSwitchTab={handleTabChange}
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
                onClick={() => setActiveTab('packages')}
                className="text-emerald-700 hover:text-emerald-800 font-bold flex items-center gap-1 cursor-pointer"
              >
                <CreditCard className="w-3.5 h-3.5" />
                <span>الباقات</span>
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
              <a
                href="https://wa.me/201009319562?text=%D8%A7%D9%84%D8%B3%D9%84%D8%A7%D9%85%20%D8%B9%D9%84%D9%8A%D9%83%D9%85%D8%8C%20%D8%A3%D8%B1%D8%BA%D8%A8%20%D9%81%D9%8A%20%D8%B4%D8%AD%D9%86%20%D8%A7%D9%84%D8%B1%D8%B5%D9%8A%D8%AF%20%D9%88%D8%A7%D9%84%D8%AA%D9%88%D8%A7%D8%B5%D9%84%20%D9%85%D8%B9%20%D8%A7%D9%84%D8%AF%D8%B9%D9%85"
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-700 hover:text-emerald-800 font-bold flex items-center gap-1 cursor-pointer"
              >
                <span>الدعم الفني (01009319562)</span>
              </a>
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
