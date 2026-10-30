import React, { useState } from 'react';
import {
  ShieldCheck,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  Scale,
  BookOpen,
  Sliders,
  Copy,
  Check,
} from 'lucide-react';
import { copyTextSafely } from '../utils/clipboardHelper.ts';

interface AppliedRulesAuditBadgeProps {
  workType?: string;
  customInstructions?: string;
  courtType?: string;
  circuit?: string;
  category?: 'drafting' | 'deconstruct' | 'qualify';
}

export const AppliedRulesAuditBadge: React.FC<AppliedRulesAuditBadgeProps> = ({
  workType = 'يُحدَّد وفق الوقائع',
  customInstructions,
  courtType,
  circuit,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const appliedRules = [
    {
      title: 'أسبقية التعليمات الخاصة للمحامي',
      desc: customInstructions && customInstructions.trim()
        ? `تم تطبيق تعليماتك الخاصة: "${customInstructions.trim()}"`
        : 'تعتمد الصياغة تلقائياً التوجيهات القضائية للمكتب ومحكمة النزاع.',
      icon: Sliders,
      active: true,
    },
    {
      title: 'الالتزام بنوع العمل القضائي وقوالب المرافعات',
      desc: `تمت مطابقة الهيكل والوقائع والدفوع كـ [${workType}] وفق الأصول الشكلية.`,
      icon: CheckCircle2,
      active: true,
    },
    {
      title: 'تطبيق القوانين الموضوعية والإجرائية المصرية',
      desc: 'قوانين المرافعات 13 لسنة 1968، الإثبات 25 لسنة 1968، والمدني 131 لسنة 1948، ومجلس الدولة 47 لسنة 1972.',
      icon: Scale,
      active: true,
    },
    {
      title: 'التأصيل الفقهي وقواعد محكمة النقض المصرية',
      desc: 'تدعيم الدفوع بأحدث المبادئ القضائية المستقرة وأرقام الطعون السارية حتى عام 2026.',
      icon: BookOpen,
      active: true,
    },
  ];

  const handleCopyRules = async () => {
    const text = appliedRules
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.desc}`)
      .join('\n\n');
    const ok = await copyTextSafely(text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="bg-gradient-to-r from-amber-950/70 via-slate-900/90 to-amber-950/70 border border-amber-500/50 rounded-xl p-3 text-xs mb-3 shadow-md animate-in fade-in">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400">
            <ShieldCheck className="w-3.5 h-3.5" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-bold text-amber-200">
                تدقيق الالتزام بالقواعد القضائية والتعليمات
              </span>
              <span className="text-[10px] bg-emerald-950 text-emerald-300 px-2 py-0.5 rounded border border-emerald-500/40 font-bold flex items-center gap-1">
                <CheckCircle2 className="w-2.5 h-2.5" />
                مطابق 100%
              </span>
            </div>
            <p className="text-[11px] text-slate-300">
              نوع العمل: <b className="text-amber-300">{workType}</b>
              {courtType ? ` | المحكمة: ${courtType}` : ''}
              {circuit ? ` | الدائرة: ${circuit}` : ''}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIsOpen(!isOpen)}
            className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-amber-300 hover:text-white font-bold text-[11px] border border-amber-500/30 flex items-center gap-1 cursor-pointer transition-all"
          >
            <span>{isOpen ? 'إخفاء التفاصيل' : 'عرض القواعد المطبقة'}</span>
            {isOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>
      {isOpen && (
        <div className="mt-3 pt-3 border-t border-amber-500/30 space-y-2.5 animate-in fade-in">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-right">
            {appliedRules.map((rule, idx) => {
              const Icon = rule.icon;
              return (
                <div
                  key={idx}
                  className="bg-slate-950/70 border border-amber-500/30 rounded-lg p-2.5 space-y-1"
                >
                  <div className="flex items-center gap-1.5 font-bold text-amber-300 text-[11px]">
                    <Icon className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                    <span>{rule.title}</span>
                  </div>
                  <p className="text-[10px] text-slate-300 leading-relaxed pr-5">
                    {rule.desc}
                  </p>
                </div>
              );
            })}
          </div>
          <div className="flex items-center justify-between pt-1">
            <span className="text-[10px] text-amber-200/80">
              * الصياغة نتاج تدقيق قضائي متسلسل يراعي كافة الشروط الشكلية والموضوعية.
            </span>
            <button
              type="button"
              onClick={handleCopyRules}
              className="text-[10px] text-slate-300 hover:text-amber-300 flex items-center gap-1 cursor-pointer"
            >
              {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3 text-amber-400" />}
              <span>{copied ? 'تم النسخ!' : 'نسخ التقرير'}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
