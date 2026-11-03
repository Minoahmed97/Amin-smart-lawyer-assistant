import React, { useState } from 'react';
import { getSavedOnlineDefenses, saveOnlineDefense } from '../utils/legalDefenseLibrary.ts';
import { getSessionToken } from '../services/authService.ts';
import { EGYPTIAN_LEGAL_DEFENSES } from '../data/egyptianDefenses.ts';
import { BookOpen, Search, Copy, Check, ArrowRight, Scale, ShieldCheck, BookmarkCheck } from 'lucide-react';

interface DefensesCodexViewProps {
  onInsertDefense: (snippet: string) => void;
  userId?: string;
}

export const DefensesCodexView: React.FC<DefensesCodexViewProps> = ({ onInsertDefense, userId }) => {
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [onlineQuery, setOnlineQuery] = useState('');
  const [onlineResults, setOnlineResults] = useState<any[]>([]);
  const [onlineLoading, setOnlineLoading] = useState(false);
  const [onlineError, setOnlineError] = useState('');
  const [savedOnline, setSavedOnline] = useState(() => getSavedOnlineDefenses(userId));

  const categories = [
    { id: 'all', label: 'كافة الدفوع' },
    { id: 'مدني', label: 'مدني وتجاري' },
    { id: 'جنائي', label: 'جنائي وجنح' },
    { id: 'إداري مجلس دولة', label: 'مجلس دولة' },
    { id: 'أسرة وأحوال شخصية', label: 'محاكم الأسرة' },
    { id: 'إجراءات ومواعيد', label: 'دفوع شكلية' },
  ];

  const filteredDefenses = [...EGYPTIAN_LEGAL_DEFENSES, ...savedOnline.map((item: any) => ({ ...item, statute: item.legalBasis, article: 'مصدر إلكتروني', cassationRule: item.summary || '', draftingSnippet: item.draftingSnippet }))].filter((def) => {
    const matchesCategory = selectedCategory === 'all' || def.category === selectedCategory;
    const matchesSearch =
      def.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      def.article.toLowerCase().includes(searchTerm.toLowerCase()) ||
      def.statute.toLowerCase().includes(searchTerm.toLowerCase()) ||
      def.legalBasis.toLowerCase().includes(searchTerm.toLowerCase()) ||
      def.cassationRule.toLowerCase().includes(searchTerm.toLowerCase());
    return matchesCategory && matchesSearch;
  });

  const searchOnlineDefenses = async () => {
    if (onlineQuery.trim().length < 3) { setOnlineError('اكتب موضوع الدفع أو كلمتين على الأقل.'); return; }
    setOnlineLoading(true); setOnlineError(''); setOnlineResults([]);
    try {
      const token = getSessionToken();
      const response = await fetch('/api/gemini/legal-defense-search', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query: onlineQuery.trim() }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'تعذر البحث على الإنترنت.');
      setOnlineResults([{ id: 'online-search-result', name: `نتائج البحث عن: ${onlineQuery.trim()}`, category: 'بحث قانوني عبر الإنترنت', summary: data.summary || '', legalBasis: 'راجع المصادر المرفقة وتحقق من النص القانوني الساري.', draftingSnippet: data.summary || '', sources: Array.isArray(data.sources) ? data.sources : [] }]);
    } catch (error: any) { setOnlineError(error?.message || 'تعذر البحث حالياً.'); }
    finally { setOnlineLoading(false); }
  };

  const copySnippet = (id: string, snippet: string) => {
    navigator.clipboard.writeText(snippet);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2500);
  };

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-4 sm:py-6 space-y-5" style={{ fontFamily: 'Cairo, sans-serif' }}>
      {/* Banner */}
      <div className="bg-[#0f172a] border-2 border-[#b45309] rounded-2xl p-4 sm:p-5 shadow-xl">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-start gap-3.5">
            <div className="w-11 h-11 sm:w-12 sm:h-12 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-400 flex-shrink-0">
              <BookOpen className="w-5 h-5 sm:w-6 sm:h-6 text-amber-400" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold text-white flex items-center gap-2 flex-wrap">
                <span>موسوعة الدفوع القضائية المصرية</span>
                <span className="text-[11px] bg-amber-950 text-amber-300 px-2 py-0.5 rounded border border-amber-500/40 font-medium">
                  مؤصلة بنصوص القوانين وأحكام النقض
                </span>
              </h2>
              <p className="text-xs sm:text-sm text-slate-300 mt-1">
                استعرض الدفوع الجوهرية والشكلية مع صيغ الإدراج المباشر في المذكرات.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Search and Category Filter */}
      <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-4 shadow-lg flex flex-col md:flex-row items-stretch md:items-center gap-4">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute right-3.5 top-3.5" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="ابحث برقم المادة أو الكلمة: مثال (المادة 227، المادة 374، عدم قبول...)"
            className="w-full bg-slate-900 border border-slate-700 rounded-xl pr-10 pl-4 py-2.5 text-xs sm:text-sm text-white focus:outline-none focus:border-[#b45309]"
          />
        </div>
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 md:pb-0 scrollbar-none">
          {categories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setSelectedCategory(cat.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap transition-colors cursor-pointer ${
                selectedCategory === cat.id
                  ? 'bg-[#b45309] text-white shadow-md shadow-[#b45309]/30 border border-amber-400/50'
                  : 'bg-slate-800/80 text-slate-300 hover:bg-slate-700 hover:text-white'
              }`}
            >
              {cat.label}
            </button>
          ))}
        </div>
      </div>

      <section className="bg-[#0f172a] border border-emerald-700/50 rounded-2xl p-4 shadow-lg space-y-3">
        <h3 className="text-sm font-bold text-emerald-300">بحث قانوني على الإنترنت</h3>
        <div className="flex flex-col sm:flex-row gap-2">
          <input value={onlineQuery} onChange={(e) => setOnlineQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void searchOnlineDefenses(); }} placeholder="مثال: الدفع بانتفاء ركن التسليم في إيصال الأمانة" className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-3 py-2.5 text-xs text-white" />
          <button type="button" onClick={() => void searchOnlineDefenses()} disabled={onlineLoading} className="px-4 py-2 rounded-xl bg-emerald-700 text-white text-xs font-bold disabled:opacity-50">{onlineLoading ? 'جاري البحث...' : 'ابحث على الإنترنت'}</button>
        </div>
        {onlineError && <p className="text-xs text-rose-300">{onlineError}</p>}
        {onlineResults.map((result) => <div key={result.id} className="rounded-xl border border-slate-700 bg-slate-900 p-3 space-y-2">
          <p className="text-xs text-slate-200 whitespace-pre-wrap leading-7">{result.summary}</p>
          {result.sources.map((source: any, index: number) => <p key={index} className="text-xs"><a href={source.url} target="_blank" rel="noopener noreferrer" className="text-sky-300 underline">{source.title || source.url}</a></p>)}
          <button type="button" onClick={() => { try { const next = saveOnlineDefense({ name: result.name, category: result.category, summary: result.summary, legalBasis: result.legalBasis, draftingSnippet: result.draftingSnippet, sourceTitle: result.sources[0]?.title || 'بحث Google عبر Gemini', sourceUrl: result.sources[0]?.url || '' }, userId); setSavedOnline(next); setOnlineError('تم حفظ نتيجة البحث في موسوعة هذا الحساب على هذا الجهاز.'); } catch (error: any) { setOnlineError(error?.message || 'تعذر الحفظ.'); } }} className="px-3 py-2 rounded-lg bg-emerald-700 text-white text-xs font-bold">إضافة إلى موسوعة الدفوع</button>
        </div>)}
        {savedOnline.length > 0 && <p className="text-[11px] text-emerald-300">دفوع الإنترنت المحفوظة لهذا الحساب على هذا الجهاز: {savedOnline.length}</p>}
        <p className="text-[10px] text-slate-400">المحتوى استرشادي؛ افتح المصدر وتحقق من انطباقه والنصوص السارية قبل الاستناد إليه.</p>
      </section>

      {/* Cards Grid */}
      <div className="space-y-4">
        {filteredDefenses.length > 0 ? (
          filteredDefenses.map((def) => (
            <div
              key={def.id}
              className="bg-[#0f172a] border border-slate-800 hover:border-amber-600/60 rounded-2xl p-4 sm:p-5 shadow-xl transition-all"
            >
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-3 mb-3 border-b border-slate-800">
                <div className="flex items-center gap-2.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-amber-400 flex-shrink-0"></span>
                  <h3 className="font-bold text-white text-sm sm:text-base leading-snug">
                    {def.name}
                  </h3>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[11px] px-2.5 py-1 rounded-full bg-slate-800 text-amber-300 border border-amber-500/30 font-medium">
                    {def.category}
                  </span>
                  <span className="text-[11px] px-2.5 py-1 rounded-full bg-amber-950 text-amber-300 border border-amber-500/30 font-bold">
                    {def.article}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-4 text-xs mb-4">
                <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3 sm:p-3.5">
                  <div className="flex items-center gap-1.5 text-amber-300 font-bold mb-1.5">
                    <Scale className="w-3.5 h-3.5 text-amber-400" />
                    <span>السند القانوني ({def.statute}):</span>
                  </div>
                  <p className="text-slate-300 leading-relaxed font-medium">
                    {def.legalBasis}
                  </p>
                </div>
                <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3 sm:p-3.5">
                  <div className="flex items-center gap-1.5 text-emerald-300 font-bold mb-1.5">
                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                    <span>مبدأ محكمة النقض:</span>
                  </div>
                  <p className="text-slate-300 leading-relaxed font-amiri text-xs sm:text-sm">
                    {def.cassationRule}
                  </p>
                </div>
              </div>

              <div className="bg-[#090d16] border border-amber-900/40 rounded-xl p-3.5 mb-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[11px] font-bold text-amber-300 flex items-center gap-1">
                    <BookmarkCheck className="w-3.5 h-3.5 text-amber-400" />
                    صيغة الدفع المقترحة للصياغة القضائية:
                  </span>
                  <button
                    onClick={() => copySnippet(def.id, def.draftingSnippet)}
                    className="text-[11px] px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 flex items-center gap-1 transition-colors cursor-pointer"
                  >
                    {copiedId === def.id ? (
                      <>
                        <Check className="w-3 h-3 text-emerald-400" />
                        <span>تم النسخ!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        <span>نسخ الصيغة</span>
                      </>
                    )}
                  </button>
                </div>
                <p className="text-slate-200 font-amiri text-sm sm:text-base leading-[2.1] pr-2 border-r-2 border-[#b45309]">
                  {def.draftingSnippet}
                </p>
              </div>

              <div className="flex justify-end">
                <button
                  onClick={() => onInsertDefense(def.draftingSnippet)}
                  className="px-3.5 py-2 rounded-xl bg-[#b45309] hover:bg-amber-600 text-white text-xs font-bold flex items-center gap-1.5 transition-colors shadow-md shadow-[#b45309]/30 cursor-pointer"
                >
                  <span>إدراج في مذكرة الدفاع فوراً</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))
        ) : (
          <div className="text-center py-16 bg-[#0f172a] rounded-2xl border border-slate-800">
            <BookOpen className="w-12 h-12 text-slate-600 mx-auto mb-2" />
            <p className="text-slate-300 font-semibold text-sm">لا توجد دفوع مطابقة لبحثك</p>
            <p className="text-slate-500 text-xs mt-1">جرب كلمات أخرى مثل "المرافعات" أو "النقض"</p>
          </div>
        )}
      </div>
    </div>
  );
};
