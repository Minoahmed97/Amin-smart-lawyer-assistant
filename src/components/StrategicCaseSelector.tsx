import React, { useEffect, useState } from 'react';
import type { UnifiedCaseFile } from '../strategic/types.ts';
import { getActiveStrategicCaseId, listCaseFiles, setActiveStrategicCase } from '../strategic/caseFileService.ts';

interface StrategicCaseSelectorProps { userId: string; }

export const StrategicCaseSelector: React.FC<StrategicCaseSelectorProps> = ({ userId }) => {
  const [cases, setCases] = useState<UnifiedCaseFile[]>([]);
  const [activeId, setActiveId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError('');
    setActiveId(getActiveStrategicCaseId(userId));
    listCaseFiles()
      .then((items) => { if (mounted) setCases(items); })
      .catch((err) => { if (mounted) setError(err instanceof Error ? err.message : 'تعذر تحميل ملفات القضايا.'); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [userId]);

  const handleChange = (caseId: string) => {
    setActiveStrategicCase(userId, caseId);
    setActiveId(caseId);
    setError('');
  };
  const activeCase = cases.find((item) => item.id === activeId);

  return (
    <section className="bg-[#111827] border border-amber-500/30 rounded-xl px-3 py-3 flex flex-col sm:flex-row sm:items-center gap-2">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-bold text-amber-300">ملف القضية الاستراتيجي المشترك</div>
        <div className="text-[11px] text-slate-400 mt-1">
          {activeCase ? 'الواجهات التالية ستستخدم سياق هذه القضية.' : 'يمكنك العمل دون ربط قضية، أو اختيار قضية محفوظة.'}
        </div>
        {error && <div className="text-[11px] text-rose-300 mt-1">{error}</div>}
      </div>
      <select value={activeId} onChange={(event) => handleChange(event.target.value)} disabled={loading}
        aria-label="اختيار ملف القضية الاستراتيجي"
        className="w-full sm:max-w-sm bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-xs text-white outline-none focus:border-amber-500 disabled:opacity-60">
        <option value="">{loading ? 'جارٍ تحميل ملفات القضايا...' : 'بدون ربط قضية'}</option>
        {cases.map((caseFile) => <option key={caseFile.id} value={caseFile.id}>
          {caseFile.title}{caseFile.caseNumber ? ' — ' + caseFile.caseNumber : ''}
        </option>)}
      </select>
    </section>
  );
};
