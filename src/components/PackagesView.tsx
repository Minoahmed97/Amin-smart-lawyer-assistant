import React, { useState, useEffect } from 'react';
import {
  CreditCard,
  Check,
  Send,
  Sparkles,
  Zap,
  HelpCircle,
  CheckCircle2,
} from 'lucide-react';
import {
  getManagedPackages,
  fetchRemotePackages,
} from '../utils/creditsManager.ts';
import { PlatformPackage } from '../types.ts';
import { redeemRechargeCode } from '../services/authService.ts';

interface PackagesViewProps {
  currentCredits: number;
  userId: string;
  onCreditsUpdated: (newCredits: number) => void;
  onSwitchTab: (tab: 'draft' | 'deconstruct' | 'qualify' | 'defenses' | 'packages' | 'vault') => void;
}

export const PackagesView: React.FC<PackagesViewProps> = ({
  currentCredits,
  onCreditsUpdated,
  onSwitchTab,
}) => {
  const [packages, setPackages] = useState<PlatformPackage[]>(() => getManagedPackages());
  const [activationCode, setActivationCode] = useState<string>('');
  const [redeemLoading, setRedeemLoading] = useState<boolean>(false);
  const [redeemError, setRedeemError] = useState<string>('');
  const [redeemSuccess, setRedeemSuccess] = useState<string>('');

  useEffect(() => {
    fetchRemotePackages().then((pkgs) => {
      if (pkgs && pkgs.length > 0) setPackages(pkgs);
    });
    const handlePackagesUpdated = (e: any) => {
      if (e.detail?.packages && Array.isArray(e.detail.packages)) {
        setPackages(e.detail.packages);
      } else {
        setPackages(getManagedPackages());
      }
    };
    window.addEventListener('judicial_packages_updated', handlePackagesUpdated);
    return () => {
      window.removeEventListener('judicial_packages_updated', handlePackagesUpdated);
    };
  }, []);

  const handleRedeemCode = async () => {
    if (!activationCode.trim()) {
      setRedeemError('يرجى إدخال الكود.');
      setRedeemSuccess('');
      return;
    }
    setRedeemLoading(true);
    setRedeemError('');
    setRedeemSuccess('');
    try {
      const cleanCode = activationCode.trim().toUpperCase();
      const result = await redeemRechargeCode(cleanCode);
      setRedeemSuccess(`تمت إضافة ${Number(result.added || 0)} عملية بنجاح! الرصيد: ${result.newTotal} عملية.`);
      onCreditsUpdated(Number(result.newTotal || 0));
      setActivationCode('');
    } catch (e: any) {
      setRedeemError(e.message || 'حدث خطأ.');
    } finally {
      setRedeemLoading(false);
    }
  };

  const getWhatsAppOrderUrl = (plan: PlatformPackage) => {
    const text = encodeURIComponent(
      `السلام عليكم، أرغب في الاشتراك في (${plan.name}) بسعر (${plan.price}) ورصيد (${plan.credits} محاولة صياغة).`
    );
    return `https://wa.me/201009319562?text=${text}`;
  };

  return (
    <div className="max-w-6xl mx-auto px-3 sm:px-6 py-5 sm:py-7 space-y-6 sm:space-y-8" style={{ fontFamily: 'Cairo, sans-serif' }}>
      {/* Header */}
      <div className="text-center space-y-3">
        <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs font-bold">
          <Sparkles className="w-3.5 h-3.5" />
          <span>باقات الاشتراك القضائي وشحن الرصيد</span>
        </div>
        <h2 className="text-xl sm:text-3xl font-extrabold text-white">
          استثمر في أدوات مكتبك القضائية الاحترافية
        </h2>
        <p className="text-slate-300 text-xs sm:text-sm max-w-2xl mx-auto">
          اختر الباقة المناسبة لمكتبك وسرّع وتيرة إعداد وتفكيك مذكراتك بدقة متناهية.
        </p>

        {/* Current Balance Indicator */}
        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-900 border-2 border-[#b45309] text-xs font-bold shadow-lg">
          <span className="text-slate-300">رصيدك المتاح حالياً:</span>
          <span className={`text-sm sm:text-base font-black font-mono ${currentCredits <= 0 ? 'text-rose-400' : 'text-amber-400'}`}>
            {currentCredits} محاولة
          </span>
          <span className={`w-2 h-2 rounded-full ${currentCredits <= 0 ? 'bg-rose-500' : 'bg-emerald-400'} animate-pulse`}></span>
        </div>

        {/* Expired Free Trials Alert Box */}
        {currentCredits <= 0 && (
          <div className="max-w-xl mx-auto p-4 rounded-2xl bg-gradient-to-r from-red-950/80 via-amber-950/70 to-red-950/80 border-2 border-red-500/80 text-white shadow-xl animate-in fade-in">
            <div className="flex items-center justify-center gap-2 text-rose-300 font-black text-sm sm:text-base mb-1">
              <span className="text-lg">⚠️</span>
              <span>انتهت محاولاتك التجريبية المجانية (0 محاولة)</span>
            </div>
            <p className="text-xs text-slate-200 mb-3 leading-relaxed">
              يرجى تحويل قيمة الباقة عبر فودافون كاش أو إنستاباي وإرسال الإشعار لتفعيل رصيدك فوراً.
            </p>
            <a
              href="https://wa.me/201009319562?text=%D8%A7%D9%84%D8%B3%D9%84%D8%A7%D9%85%20%D8%B9%D9%84%D9%8A%D9%83%D9%85%D8%8C%20%D8%A7%D9%86%D8%AA%D9%87%D8%AA%20%D9%85%D8%AD%D8%A7%D9%88%D9%84%D8%A7%D8%AA%D9%8A%20%D8%A7%D9%84%D9%85%D8%AC%D8%A7%D9%86%D9%8A%D8%A9%20%D9%88%D8%A3%D8%B1%D8%BA%D8%A8%20%D9%81%D9%8A%20%D8%A5%D8%B1%D8%B3%D8%A7%D9%84%20%D8%A5%D9%8A%D8%B5%D8%A7%D9%84%20%D8%A7%D9%84%D8%AF%D9%81%D8%B9%20%D9%84%D8%B4%D8%AD%D9%86%20%D8%A7%D9%84%D8%B1%D8%B5%D9%8A%D8%AF"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow-lg transition-all border border-emerald-400 cursor-pointer"
            >
              <span>إرسال إيصال التحويل عبر واتساب (01009319562)</span>
            </a>
          </div>
        )}
      </div>

      {/* Quick Activation Code Card */}
      <div className="bg-[#0f172a] p-4 sm:p-5 rounded-2xl border-2 border-[#b45309] shadow-xl space-y-3">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-3 w-full sm:w-auto">
            <div className="w-10 h-10 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-400 flex-shrink-0">
              <Zap className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm sm:text-base font-bold text-white">
                تفعيل كود شحن فوري
              </h3>
              <p className="text-xs text-slate-400">
                إذا كان لديك كود شحن تم شراؤه من الإدارة، أدخله هنا:
              </p>
            </div>
          </div>
          <div className="flex w-full sm:w-auto flex-1 sm:max-w-md gap-2">
            <input
              type="text"
              placeholder="مثال: AMIN-20-X82A"
              value={activationCode}
              onChange={(e) => setActivationCode(e.target.value)}
              className="flex-1 px-3.5 py-2.5 bg-[#090d16] text-white border border-slate-600 rounded-xl text-xs sm:text-sm font-mono tracking-wider outline-none focus:border-[#b45309] placeholder:text-slate-500"
            />
            <button
              onClick={handleRedeemCode}
              disabled={redeemLoading}
              className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs sm:text-sm font-bold transition-all disabled:opacity-50 cursor-pointer shadow-md flex items-center gap-1.5 flex-shrink-0"
            >
              <span>{redeemLoading ? 'جارٍ التفعيل...' : 'تفعيل الكود'}</span>
            </button>
          </div>
        </div>
        {redeemError && (
          <div className="text-xs text-rose-300 font-bold bg-rose-950/70 p-2.5 rounded-xl border border-rose-800">
            {redeemError}
          </div>
        )}
        {redeemSuccess && (
          <div className="text-xs text-emerald-200 font-bold bg-emerald-950/80 p-3 rounded-xl border border-emerald-500 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
            <span>{redeemSuccess}</span>
          </div>
        )}
      </div>

      {/* Pricing Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5 sm:gap-6">
        {packages
          .filter((p) => p.enabled !== false)
          .map((plan) => (
            <div
              key={plan.id}
              className={`relative rounded-2xl p-5 sm:p-6 border-2 flex flex-col justify-between transition-all duration-200 shadow-xl ${
                plan.popular
                  ? 'bg-gradient-to-b from-[#1e293b] to-[#0f172a] border-[#b45309] ring-2 ring-[#b45309]/50 shadow-amber-900/30 scale-[1.02]'
                  : 'bg-[#0f172a] border-slate-800 hover:border-amber-600/50'
              }`}
            >
              {plan.badge && (
                <div
                  className={`absolute -top-3.5 right-6 text-white text-[11px] font-bold px-3 py-1 rounded-full shadow ${
                    plan.popular
                      ? 'bg-gradient-to-r from-amber-600 to-[#b45309] border border-amber-400/40'
                      : 'bg-slate-800 border border-slate-700'
                  }`}
                >
                  {plan.badge}
                </div>
              )}
              <div>
                <h3 className="text-base sm:text-lg font-bold text-white mb-1">{plan.name}</h3>
                <p className="text-xs text-slate-400 mb-4">{plan.description}</p>
                <div className="flex items-baseline gap-1.5 my-4 pb-4 border-b border-slate-800">
                  <span className="text-3xl sm:text-4xl font-black text-amber-300 font-mono">
                    {plan.price}
                  </span>
                  <span className="text-xs text-slate-400">/ {plan.credits} محاولة</span>
                </div>
                <ul className="space-y-3 text-xs text-slate-300">
                  {plan.features.map((feat, idx) => (
                    <li key={idx} className="flex items-start gap-2">
                      <Check className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" />
                      <span className="leading-relaxed">{feat}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="mt-8 pt-4 border-t border-slate-800/80">
                <a
                  href={getWhatsAppOrderUrl(plan)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`w-full py-3 px-4 rounded-xl text-xs sm:text-sm font-bold transition-all shadow-md flex items-center justify-center gap-2 cursor-pointer ${
                    plan.popular
                      ? 'bg-gradient-to-r from-[#b45309] to-amber-600 hover:from-amber-600 hover:to-amber-500 text-white shadow-[#b45309]/40 border border-amber-400/50'
                      : 'bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white border border-slate-700'
                  }`}
                >
                  <Send className="w-4 h-4 text-amber-300" />
                  <span>طلب الباقة عبر واتساب</span>
                </a>
              </div>
            </div>
          ))}
      </div>

      {/* Payment Instructions Card */}
      <div className="bg-[#0f172a] rounded-2xl border-2 border-[#b45309] p-5 sm:p-6 space-y-4 shadow-xl">
        <div className="flex items-center gap-2 text-amber-400 font-bold text-sm sm:text-base border-b border-slate-800 pb-3">
          <CreditCard className="w-5 h-5 text-amber-500" />
          <span>طرق التحويل والدفع السريع:</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="bg-[#1e293b] p-4 rounded-xl border border-slate-700 flex items-center justify-between">
            <div>
              <div className="text-xs text-slate-400 font-semibold mb-1">فودافون كاش (Vodafone Cash)</div>
              <div className="text-emerald-400 font-mono text-lg font-black tracking-wider select-all">
                01009319562
              </div>
            </div>
            <span className="text-2xl">📱</span>
          </div>
          <div className="bg-[#1e293b] p-4 rounded-xl border border-slate-700 flex items-center justify-between">
            <div>
              <div className="text-xs text-slate-400 font-semibold mb-1">إنستاباي (InstaPay)</div>
              <div className="text-emerald-400 font-mono text-lg font-black tracking-wider select-all">
                01221804612
              </div>
            </div>
            <span className="text-2xl">⚡</span>
          </div>
        </div>
        <div className="bg-amber-950/20 border border-amber-500/30 rounded-xl p-4 text-xs text-slate-300 space-y-2">
          <div className="font-bold text-amber-300 flex items-center gap-1.5">
            <HelpCircle className="w-4 h-4" />
            <span>خطوات التفعيل السريع:</span>
          </div>
          <ol className="list-decimal list-inside space-y-1.5 text-slate-300 leading-relaxed pr-2">
            <li>قم بتحويل قيمة الباقة المختارة عبر فودافون كاش أو إنستاباي.</li>
            <li>التقط لقطة شاشة لإيصال التحويل وأرسله إلى رقم الواتساب: <b>01009319562</b>.</li>
            <li>سيتم إرسال كود التفعيل الفوري لك لشحن رصيد حسابك في ثوانٍ.</li>
          </ol>
        </div>
        <div className="flex flex-col sm:flex-row gap-3 pt-2">
          <a
            href="https://wa.me/201009319562?text=%D8%A7%D9%84%D8%B3%D9%84%D8%A7%D9%85%20%D8%B9%D9%84%D9%8A%D9%83%D9%85%D8%8C%20%D8%A3%D8%B1%D8%BA%D8%A8%20%D9%81%D9%8A%20%D8%B4%D8%AD%D9%86%20%D8%A7%D9%84%D8%B1%D8%B5%D9%8A%D8%AF%20%D9%88%D8%A7%D9%84%D8%AA%D9%88%D8%A7%D8%B5%D9%84%20%D9%85%D8%B9%D9%83%D9%85"
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 py-3 px-4 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs sm:text-sm font-bold flex items-center justify-center gap-2 shadow-lg transition-all cursor-pointer"
          >
            <Send className="w-4 h-4" />
            <span>مراسلة الدعم والتحويل عبر واتساب (01009319562)</span>
          </a>
          <button
            onClick={() => onSwitchTab('deconstruct')}
            className="py-3 px-6 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer border border-slate-700"
          >
            العودة للعمل القضائي
          </button>
        </div>
      </div>
    </div>
  );
};
