import React, { useEffect, useState } from 'react';

type ArchiveCaseOption = { id: string; title: string };

const archiveCasesKey = (userId: string) =>
  `amin_learning_archive_cases_${String(userId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
const activeCaseKey = (userId: string) =>
  `amin_learning_active_case_${String(userId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_')}`;

export const LearningCaseSelector: React.FC<{
  userId: string;
  value: string;
  onChange: (caseRef: string) => void;
}> = ({ userId, value, onChange }) => {
  const [cases, setCases] = useState<ArchiveCaseOption[]>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(archiveCasesKey(userId)) || '[]';
      const parsed = JSON.parse(raw);
      const rows = Array.isArray(parsed)
        ? parsed.filter((item) => item && typeof item.id === 'string' && typeof item.title === 'string')
        : [];
      setCases(rows.slice(0, 8));
      const saved = localStorage.getItem(activeCaseKey(userId)) || '';
      onChange(saved && rows.some((item) => item.id === saved) ? saved : '');
    } catch {
      setCases([]);
      onChange('');
    }
  }, [userId]);

  const handleChange = (nextValue: string) => {
    try {
      if (nextValue) localStorage.setItem(activeCaseKey(userId), nextValue);
      else localStorage.removeItem(activeCaseKey(userId));
    } catch {}
    onChange(nextValue);
  };

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-3 space-y-1.5">
      <label className="block text-xs font-semibold text-slate-200" htmlFor="amin-learning-case-selector">
        ربط المهمة بقضية من الأرشيف (اختياري)
      </label>
      <select
        id="amin-learning-case-selector"
        value={value}
        onChange={(event) => handleChange(event.target.value)}
        className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-amber-500"
      >
        <option value="">بدون ربط بقضية محددة — الخبرات العامة فقط</option>
        {cases.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select>
      <p className="text-[11px] leading-5 text-slate-400">
        عند الاختيار، يستفيد أمين من الخبرات المعتمدة لهذه القضية وحدها، إلى جانب الخبرات المهنية العامة.
      </p>
    </div>
  );
};
