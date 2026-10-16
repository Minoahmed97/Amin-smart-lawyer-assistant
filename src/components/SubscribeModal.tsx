import React, { useState, useEffect } from 'react';
import { CreditCard, Check, Shield, X, CheckCircle2, Send, Zap } from 'lucide-react';
import {
  getManagedPackages,
  fetchRemotePackages,
} from '../utils/creditsManager.ts';
import { PlatformPackage } from '../types.ts';
import { recordAnalyticsEvent } from '../services/analyticsService.ts';
import { redeemRechargeCode } from '../services/authService.ts';

interface SubscribeModalProps {
  isOpen: boolean;
  onClose: () => void;
  userId: string;
  currentCredits: number;
  onCreditsUpdated: (newCredits: number) => void;
}

export const SubscribeModal: React.FC<SubscribeModalProps> = ({
  isOpen,
  onClose,
  currentCredits,
  onCreditsUpdated,
}) => {
  const [packages, setPackages] = useState<PlatformPackage[]>(() => getManagedPackages());
  const [activationCode, setActivationCode] = useState<string>('');
  const [redeemLoading, setRedeemLoading] = useState<boolean>(false);
  const [redeemError, setRedeemError] = useState<string>('');
  const [redeemSuccess, setRedeemSuccess] = useState<string>('');

  useEffect(() => {
    if (isOpen) {
      fetchRemotePackages().then((pkgs) => {
        if (pkgs && pkgs.length > 0) setPackages(pkgs);
      });
    }
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
  }, [isOpen]);

  if (!isOpen) return null;

  const handleRedeemCode = async () => {
    if (!activationCode.trim()) {
      setRedeemError('يرجى إدخال كود التفعيل.');
      setRedeemSuccess('');
      return;
    }
    setRedeemLoading(true);
    setRedeemError('');
    setRedeemSuccess('');
    try {
      const cleanCode = activationCode.trim().toUpperCase();
      const result = await redeemRechargeCode(cleanCode);
      const addedCredits = Number(result.added || 0);
      onCreditsUpdated(Number(result.newTotal || 0));
      recordAnalyticsEvent('subscribe', { packageId: cleanCode, credits: addedCredits });
      setRedeemSuccess(`تم شحن ${addedCredits} عملية بنجاح! الرصيد: ${result.newTotal}`);
      setTimeout(() => onClose(), 1500);
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/85 backdrop-blur-md animate-in fade-in duration-200">
      <div
        className="w-full max-w-3xl bg-[#0f172a] border-2 border-[#b45309] rounded-2xl shadow-2xl overflow-hidden text-right flex flex-col max-h-[92vh]"
        style={{ fontFamily: 'Cairo, sans-serif' }}
      >
        {/* Header */}
        <div className="bg-gradient-to-l from-[#0f172a] via-[#1e293b] to-[#0f172a] p-4 sm:p-5 border-b border-amber-500/30 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#b45309]/20 border border-[#b45309] flex items-center justify-center text-amber-300">
              <CreditCard className="w-5 h-5 text-amber-400" />
            </div>
            <div>
              <h3 className="text-base sm:text-lg font-bold text-white flex items-center gap-2">
                <span>شحن وتجديد رصيد العمليات القضائية</span>
                <span className={`text-xs ${currentCredits <= 0 ? 'bg-rose-950/80 text-rose-300 border-rose-500' : 'bg-[#b45309]/30 text-amber-300 border-[#b45309]'} px-2 py-0.5 rounded border font-mono`}>
                  الرصيد: {currentCredits} محاولة
                </span>
              </h3>
              <p className="text-xs text-slate-300">
                اختر الباقة المناسبة لمكتبك مع إمكانية التصدير الفوري لمستندات وورد
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Expired Free Trials Alert */}
        {currentCredits <= 0 && (
          <div className="mx-4 sm:mx-6 mt-3 p-3 rounded-xl bg-gradient-to-r from-red-950/90 to-amber-950/80 border border-red-500/80 text-white flex flex-col sm:flex-row items-center justify-between gap-3 shadow-md">
            <div>
              <h4 className="text-xs sm:text-sm font-black text-rose-300 flex items-center gap-1.5">
                <span>انتهت محاولاتك التجريبية (0 محاولة)</span>
              </h4>
              <p className="text-[11px] text-slate-300">
                يرجى اختيار باقة وتأكيد التحويل للاستمرار في صياغة وتفكيك المذكرات.
              </p>
            </div>
            <a
              href="https://wa.me/201009319562?text=%D8%A7%D9%84%D8%B3%D9%84%D8%A7%D9%85%20%D8%B9%D9%84%D9%8A%D9%83%D9%85%D8%8C%20%D8%A7%D9%86%D8%AA%D9%87%D8%AA%20%D9%85%D8%AD%D8%A7%D9%88%D9%84%D8%A7%D8%AA%D9%8A%20%D8%A7%D9%84%D9%85%D8%AC%D8%A7%D9%86%D9%8A%D8%A9%20%D9%88%D8%A3%D8%B1%D8%BA%D8%A8%20%D9%81%D9%8A%20%D8%A5%D8%B1%D8%B3%D8%A7%D9%84%20%D8%A5%D9%8A%D8%B5%D8%A7%D9%84%20%D8%A7%D9%84%D8%AF%D9%81%D8%B9%20%D9%84%D8%B4%D8%AD%D9%86%20%D8%A7%D9%84%D8%B1%D8%B5%D9%8A%D8%AF"
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center gap-1.5 shadow transition-all cursor-pointer flex-shrink-0"
            >
              <span>تواصل لتفعيل الحساب فوراً</span>
            </a>
          </div>
        )}

        {/* Code Redemption Box */}
        <div className="mx-4 sm:mx-6 mt-4 p-3 sm:p-3.5 bg-[#1e293b] rounded-xl border border-amber-500/40 flex flex-wrap gap-2.5 items-center justify-between shadow-md">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-amber-400" />
            <span className="text-amber-400 font-bold text-xs sm:text-sm">لديك كود شحن؟</span>
          </div>
          <div className="flex flex-1 min-w-[220px] gap-2">
            <input
              type="text"
              placeholder="أدخل الكود: AMIN-20-X82A"
              value={activationCode}
              onChange={(e) => setActivationCode(e.target.value)}
              className="flex-1 px-3 py-2 bg-[#0f172a] text-white border border-slate-600 rounded-lg text-xs font-mono tracking-wider outline-none focus:border-[#b45309] placeholder:text-slate-500"
            />
            <button
              type="button"
              onClick={handleRedeemCode}
              disabled={redeemLoading}
              className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-lg text-xs font-bold transition-all disabled:opacity-50 cursor-pointer shadow flex items-center gap-1"
            >
              <span>{redeemLoading ? '...' : 'تفعيل الكود'}</span>
            </button>
          </div>
          {redeemSuccess && (
            <div className="w-full text-emerald-300 text-xs font-bold bg-emerald-950/60 p-2 rounded border border-emerald-700 flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <span>{redeemSuccess}</span>
            </div>
          )}
          {redeemError && (
            <div className="w-full text-rose-400 text-xs font-medium bg-rose-950/40 p-1.5 rounded border border-rose-800">
              {redeemError}
            </div>
          )}
        </div>

        {/* Plans */}
        <div className="p-4 sm:p-6 grid grid-cols-1 md:grid-cols-3 gap-3 sm:gap-4 overflow-y-auto">
          {packages
            .filter((p) => p.enabled !== false)
            .map((plan) => (
              <div
                key={plan.id}
                className={`relative rounded-xl p-4 border-2 flex flex-col justify-between transition-all ${
                  plan.popular
                    ? 'bg-gradient-to-b from-slate-900 to-[#1e293b] border-[#b45309] ring-2 ring-[#b45309]/50 shadow-xl'
                    : 'bg-slate-900/90 border-slate-800 hover:border-slate-700'
                }`}
              >
                {plan.badge && (
                  <div
                    className={`absolute -top-3 right-4 text-white text-[10px] font-bold px-2 py-0.5 rounded-full shadow ${
                      plan.popular ? 'bg-[#b45309]' : 'bg-slate-700'
                    }`}
                  >
                    {plan.badge}
                  </div>
                )}
                <div>
                  <div className="text-sm font-bold text-white mb-1">{plan.name}</div>
                  <div className="flex items-baseline gap-1 my-3">
                    <span className="text-2xl font-black text-amber-300 font-mono">{plan.price}</span>
                    <span className="text-xs text-slate-400">/ {plan.credits} محاولة</span>
                  </div>
                  <ul className="space-y-2 text-[11px] text-slate-300 mt-4 border-t border-slate-800 pt-3">
                    {plan.features.slice(0, 3).map((feat, idx) => (
                      <li key={idx} className="flex items-start gap-1.5">
                        <Check className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0 mt-0.5" />
                        <span>{feat}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="mt-5 pt-3">
                  <a
                    href={getWhatsAppOrderUrl(plan)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`w-full py-2.5 px-3 rounded-xl text-xs font-bold transition-all shadow flex items-center justify-center gap-1.5 cursor-pointer ${
                      plan.popular
                        ? 'bg-[#b45309] hover:bg-amber-600 text-white shadow-[#b45309]/30 border border-amber-400/40'
                        : 'bg-slate-800 hover:bg-slate-700 text-slate-200'
                    }`}
                  >
                    <Send className="w-3.5 h-3.5 text-amber-300" />
                    <span>طلب الباقة ({plan.price})</span>
                  </a>
                </div>
              </div>
            ))}
        </div>

        {/* Payment info */}
        <div className="mx-4 sm:mx-6 mb-4 p-3 sm:p-4 bg-[#090d16] rounded-xl border border-slate-700 space-y-2.5 shadow-inner">
          <div className="text-xs font-bold text-amber-400 flex items-center gap-1.5">
            <span>طرق الدفع المعتمدة:</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
            <div className="flex justify-between items-center bg-[#1e293b] px-3.5 py-2 rounded-lg border border-slate-700">
              <span className="text-slate-300 font-medium">فودافون كاش:</span>
              <strong className="text-emerald-400 font-mono text-sm tracking-wider select-all">
                01009319562
              </strong>
            </div>
            <div className="flex justify-between items-center bg-[#1e293b] px-3.5 py-2 rounded-lg border border-slate-700">
              <span className="text-slate-300 font-medium">إنستاباي (InstaPay):</span>
              <strong className="text-emerald-400 font-mono text-sm tracking-wider select-all">
                01221804612
              </strong>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="p-3.5 bg-slate-950/80 border-t border-slate-800 flex items-center justify-between text-[11px] text-slate-400">
          <div className="flex items-center gap-2 text-slate-300">
            <Shield className="w-4 h-4 text-emerald-400" />
            <span>تشفير كامل وضمان سرية القضايا</span>
          </div>
          <button
            onClick={onClose}
            className="px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs transition-colors cursor-pointer"
          >
            إلغاء
          </button>
        </div>
      </div>
    </div>
  );
};
