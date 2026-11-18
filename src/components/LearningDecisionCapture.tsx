import React, { useState } from 'react';
import { recordLearningDecision } from '../services/aiService.ts';

interface Props {
  taskType: 'deconstruct' | 'qualify' | 'draft';
  caseRef?: string;
  analysisContext: string;
  heading?: string;
}

export const LearningDecisionCapture: React.FC<Props> = ({
  taskType, caseRef, analysisContext, heading = 'تسجيل قرارك المهني بعد مراجعة النتيجة',
}) => {
  const [decision, setDecision] = useState('');
  const [reason, setReason] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const save = async () => {
    if (!decision.trim() || !reason.trim() || !analysisContext.trim() || status === 'saving') return;
    setStatus('saving');
    const saved = await recordLearningDecision({
      taskType, caseRef, analysisContext, decision, reason,
    });
    setStatus(saved ? 'saved' : 'error');
    if (saved) {
      setDecision('');
      setReason('');
    }
  };

  if (!analysisContext.trim()) return null;
  return (
    <section className="mt-4 rounded-xl border border-amber-700/50 bg-slate-900 p-3 space-y-2" dir="rtl">
      <div className="text-xs font-bold text-amber-300">{heading}</div>
      <textarea
        rows={2}
        value={decision}
        onChange={(event) => { setDecision(event.target.value); setStatus('idle'); }}
        placeholder="ما القرار الذي اتخذته فعلياً؟ وما المسار الذي اخترته؟"
        className="w-full rounded-lg border border-slate-700 bg-slate-950 p-2 text-xs text-white"
      />
      <textarea
        rows={2}
        value={reason}
        onChange={(event) => { setReason(event.target.value); setStatus('idle'); }}
        placeholder="لماذا اخترت هذا المسار؟ وما الذي رفضته أو أضفته مقارنة باقتراح أمين؟"
        className="w-full rounded-lg border border-slate-700 bg-slate-950 p-2 text-xs text-white"
      />
      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!decision.trim() || !reason.trim() || status === 'saving'}
          className="rounded-lg bg-amber-700 px-3 py-1.5 text-xs font-bold text-white hover:bg-amber-600 disabled:opacity-50"
        >
          {status === 'saving' ? 'جارٍ تسجيل القرار...' : 'تسجيل القرار للتعلّم'}
        </button>
        {status === 'saved' && <span className="text-xs text-emerald-400">تم تسجيل القرار للمراجعة.</span>}
        {status === 'error' && <span className="text-xs text-rose-400">تعذر التسجيل؛ يمكنك المحاولة مرة أخرى.</span>}
      </div>
      <p className="text-[11px] text-slate-400">لن يعتمد أمين هذا القرار أو يستخدمه تلقائياً؛ سيظل مقترحاً للمراجعة، ويظل خاصاً بالقضية عند ربطه بها.</p>
    </section>
  );
};
