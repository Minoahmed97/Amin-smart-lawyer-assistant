import React, { useEffect, useState } from 'react';
import {
  Scale,
  FileText,
  Crosshair,
  Compass,
  BookOpen,
  Sparkles,
  CreditCard,
  Zap,
  FolderArchive,
  Megaphone,
  Sun,
  Moon,
  Menu,
  Download,
  LogOut,
  Bell,
} from 'lucide-react';
import { UserRole } from '../utils/deviceFingerprint.ts';


interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

interface HeaderProps {
  activeTab: 'draft' | 'deconstruct' | 'qualify' | 'defenses' | 'packages' | 'vault' | 'community';
  setActiveTab: (tab: 'draft' | 'deconstruct' | 'qualify' | 'defenses' | 'packages' | 'vault' | 'community') => void;
  onOpenAdmin?: () => void;
  onOpenSubscribe?: () => void;
  credits: number;
  userName?: string;
  vaultModelsCount?: number;
  userRole?: UserRole;
  onChangeRole?: () => void;
  theme?: 'warm-light' | 'dark';
  onToggleTheme?: () => void;
  onLogout?: () => void;
  onEnableNotifications?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  setActiveTab,
  credits,
  userName = 'المحامي الممارس',
  vaultModelsCount = 0,
  userRole = 'lawyer',
  onChangeRole,
  theme = 'warm-light',
  onToggleTheme,
  onLogout,
  onEnableNotifications,
}) => {
  const isClient = false; // The platform is lawyer-only; litigant accounts are not supported.
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isStandalone, setIsStandalone] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(display-mode: standalone)');
    const updateStandalone = () => {
      setIsStandalone(mediaQuery.matches || (window.navigator as Navigator & { standalone?: boolean }).standalone === true);
    };

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };

    updateStandalone();
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    mediaQuery.addEventListener?.('change', updateStandalone);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      mediaQuery.removeEventListener?.('change', updateStandalone);
    };
  }, []);

  const handleInstallApp = async () => {
    if (installPrompt) {
      await installPrompt.prompt();
      await installPrompt.userChoice;
      setInstallPrompt(null);
      return;
    }

    // iOS Safari does not expose beforeinstallprompt; give the user the native install path.
    if (/iphone|ipad|ipod/i.test(window.navigator.userAgent)) {
      window.alert('لتثبيت أمين على iPhone أو iPad: اضغط زر المشاركة في Safari ثم اختر «إضافة إلى الشاشة الرئيسية».');
    } else {
      window.alert('إذا لم يظهر مربع التثبيت، افتح الموقع من متصفح يدعم تثبيت تطبيقات الويب ثم اختر «تثبيت التطبيق» من قائمة المتصفح.');
    }
  };

  const closeMenu = () => setIsMenuOpen(false);

  return (
    <header className="no-print border-b-2 border-[#b45309] bg-[#0f172a] relative shadow-xl shadow-slate-900/40">
      {/* Top Judicial & Credits Banner */}
      <div className="bg-[#090d16] border-b border-[#b45309]/30 px-3 sm:px-4 py-1.5 text-xs text-amber-200/90 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 sm:gap-3">
          <span className="inline-flex items-center gap-1.5 font-bold tracking-wide text-amber-300">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            منظومة أصول الصياغة القضائية المصرية
          </span>
          <span className="text-[#b45309]/60">|</span>
          <span className="text-amber-100/90 font-medium text-[11px] sm:text-xs">
            أحكام النقض والمرافعات حتى عام 2026
          </span>
        </div>

        {/* User Credits Badge & Quick Action */}
        <div className="flex items-center gap-2">
          <div
            id="userCreditsBadge"
            className="px-2.5 sm:px-3 py-1 rounded-full bg-gradient-to-r from-amber-600/30 to-amber-700/40 border border-[#b45309] text-amber-200 font-bold text-xs shadow-inner flex items-center gap-1.5 font-mono"
          >
            <CreditCard className="w-3.5 h-3.5 text-amber-400" />
            <span>رصيدك: {credits} محاولة</span>
          </div>

          <div className="flex items-center gap-2 mr-1">
            <button
              onClick={onChangeRole}
              className={`flex items-center gap-1.5 ${
                isClient
                  ? 'bg-emerald-950/40 hover:bg-emerald-900/50 border-emerald-500/50 text-emerald-200'
                  : 'bg-amber-950/40 hover:bg-amber-900/50 border-amber-500/50 text-amber-200'
              } px-2.5 py-1 rounded-lg border text-xs font-semibold cursor-pointer transition-colors shadow-sm`}
              title="تغيير صفة المستخدم الحالية"
            >
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              <span id="lawyerName" className="truncate max-w-[150px] sm:max-w-[200px]">
                {userName}
              </span>
              <span className={`text-[10px] ${
                isClient ? 'bg-emerald-900/80 text-emerald-300' : 'bg-amber-900/80 text-amber-300'
              } px-1.5 py-0.5 rounded mr-1 font-bold`}>
                {isClient ? 'موكل' : 'محامٍ'}
              </span>
            </button>
          </div>
        </div>
      </div>

      {/* Main Header Bar */}
      <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-3 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 sm:w-11 sm:h-11 rounded-xl bg-gradient-to-br from-[#b45309] to-[#78350f] flex items-center justify-center shadow-lg shadow-[#b45309]/20 border border-amber-400/40 text-amber-100 flex-shrink-0">
            <Scale className="w-5 h-5 sm:w-6 sm:h-6 text-amber-100" />
          </div>
          <div>
            <h1 className="text-lg sm:text-2xl font-bold tracking-tight text-white flex items-center gap-2 flex-wrap">
              <span className="text-amber-300 font-black">أميـن</span>
              <span className="text-xs sm:text-base font-bold text-slate-200">المساعد القضائي الذكي</span>
              <span className="text-[10px] text-amber-200/80 bg-amber-950/60 px-2 py-0.5 rounded border border-amber-600/40 font-semibold hidden lg:inline">
                للمحاكم المصرية والمحامين
              </span>
              <span className="text-[10px] sm:text-xs font-semibold px-2 py-0.5 rounded bg-[#b45309]/30 text-amber-200 border border-[#b45309]">
                {isClient ? 'وضع الموكل' : 'وضع المحامي'}
              </span>
            </h1>
            <p className="text-[11px] sm:text-xs text-slate-300 font-medium">
              {isClient
                ? 'استشارات قانونية دقيقة وتكييف النزاعات وفق القانون المصري'
                : 'تفكيك مذكرات الخصوم • إعداد المذكرات وصحف الدعاوى والطعون بالنقض'}
            </p>
          </div>
        </div>

        {/* Navigation menu */}
        <div className="relative flex items-center justify-end">
          <button
            type="button"
            onClick={() => setIsMenuOpen((open) => !open)}
            aria-expanded={isMenuOpen}
            aria-haspopup="menu"
            className="inline-flex items-center gap-2 px-3 py-2.5 rounded-xl bg-slate-800/90 hover:bg-slate-700 text-amber-200 border border-amber-500/30 font-bold text-sm shadow-md transition-all cursor-pointer"
          >
            <Menu className="w-5 h-5" />
            <span>القائمة</span>
          </button>

          {isMenuOpen && (
            <>
              <button
                type="button"
                aria-label="إغلاق القائمة"
                className="fixed inset-0 z-40 cursor-default"
                onClick={closeMenu}
              />
              <div
                role="menu"
                className="absolute left-0 top-full mt-2 z-50 w-[min(92vw,360px)] max-h-[70vh] overflow-y-auto rounded-2xl border border-amber-500/30 bg-[#0f172a] p-2 shadow-2xl shadow-black/40"
              >
                <div className="grid gap-1">
                  {isClient ? (
                    <>
                      <button onClick={() => { setActiveTab('qualify'); closeMenu(); }} className="header-menu-item" role="menuitem">
                        <Compass className="w-4 h-4 text-emerald-300" /><span>تكييف النزاع واستشارة</span>
                      </button>
                      <button onClick={() => { setActiveTab('packages'); closeMenu(); }} className="header-menu-item" role="menuitem">
                        <CreditCard className="w-4 h-4 text-emerald-400" /><span>الباقات والشحن</span>
                      </button>
                      <button onClick={() => { setActiveTab('community'); closeMenu(); }} className="header-menu-item" role="menuitem">
                        <Megaphone className="w-4 h-4 text-amber-300" /><span>مجتمع المنظومة</span>
                      </button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => { setActiveTab('deconstruct'); closeMenu(); }} className="header-menu-item" role="menuitem">
                        <Crosshair className="w-4 h-4 text-amber-300" /><span>التفنيد والرد على المستندات</span>
                      </button>
                      <button onClick={() => { setActiveTab('draft'); closeMenu(); }} className="header-menu-item" role="menuitem">
                        <FileText className="w-4 h-4 text-amber-300" /><span>صياغة قضائية شاملة</span>
                      </button>
                      <button onClick={() => { setActiveTab('vault'); closeMenu(); }} className="header-menu-item" role="menuitem">
                        <FolderArchive className="w-4 h-4 text-amber-300" /><span>خزينة النماذج</span>
                        {vaultModelsCount > 0 && <span className="mr-auto min-w-5 h-5 px-1 rounded-full bg-amber-400 text-slate-950 text-[10px] font-black flex items-center justify-center">{vaultModelsCount}</span>}
                      </button>
                      <button onClick={() => { setActiveTab('defenses'); closeMenu(); }} className="header-menu-item" role="menuitem">
                        <BookOpen className="w-4 h-4 text-indigo-300" /><span>موسوعة الدفوع</span>
                      </button>
                      <button onClick={() => { setActiveTab('qualify'); closeMenu(); }} className="header-menu-item" role="menuitem">
                        <Compass className="w-4 h-4 text-emerald-300" /><span>تكييف النزاع</span>
                      </button>
                      <button onClick={() => { setActiveTab('packages'); closeMenu(); }} className="header-menu-item" role="menuitem">
                        <CreditCard className="w-4 h-4 text-emerald-400" /><span>الباقات والشحن</span>
                      </button>
                      <button onClick={() => { setActiveTab('community'); closeMenu(); }} className="header-menu-item" role="menuitem">
                        <Megaphone className="w-4 h-4 text-amber-300" /><span>مجتمع المنظومة</span>
                      </button>
                    </>
                  )}

                  <button onClick={() => { setActiveTab('packages'); closeMenu(); }} className="header-menu-item text-emerald-200" role="menuitem">
                    <Zap className="w-4 h-4 text-amber-300" />
                    <span>شحن الرصيد والترقية</span>
                  </button>

                  <div className="my-1 border-t border-slate-700/70" />

                  <button
                    onClick={() => { onEnableNotifications?.(); closeMenu(); }}
                    className="header-menu-item"
                    role="menuitem"
                    title="تفعيل إشعارات انتهاء عمليات الذكاء الاصطناعي واستخراج الملفات"
                  >
                    <Bell className="w-4 h-4 text-emerald-300" />
                    <span>تفعيل الإشعارات</span>
                  </button>

                  <button onClick={() => { onToggleTheme?.(); closeMenu(); }} className="header-menu-item" role="menuitem">
                    {theme === 'warm-light' ? <Moon className="w-4 h-4 text-amber-300" /> : <Sun className="w-4 h-4 text-amber-300" />}
                    <span>{theme === 'warm-light' ? 'الوضع الليلي' : 'الوضع النهاري'}</span>
                  </button>

                  <button onClick={onChangeRole} className="header-menu-item" role="menuitem">
                    <Sparkles className="w-4 h-4 text-amber-400" />
                    <span className="truncate">{userName}</span>
                    <span className="mr-auto text-[10px] bg-amber-900/80 text-amber-300 px-1.5 py-0.5 rounded font-bold">محامٍ</span>
                  </button>

                  {!isStandalone && (
                    <button onClick={handleInstallApp} className="header-menu-item text-emerald-200" role="menuitem">
                      <Download className="w-4 h-4 text-emerald-300" />
                      <span>تثبيت التطبيق</span>
                    </button>
                  )}

                  <button
                    onClick={() => { onLogout?.(); closeMenu(); }}
                    className="header-menu-item text-rose-200"
                    role="menuitem"
                  >
                    <LogOut className="w-4 h-4 text-rose-300" />
                    <span>تسجيل الخروج</span>
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  );
};
