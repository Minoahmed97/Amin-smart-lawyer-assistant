import React, { useState, useEffect } from 'react';
import { StyleTemplate, DEFAULT_STYLE_TEMPLATES } from '../data/styleTemplates.ts';
import {
  BookOpen,
  Plus,
  Trash2,
  Check,
  ChevronDown,
  ChevronUp,
  Scale,
  AlertCircle,
} from 'lucide-react';

interface StyleTemplateSelectorProps {
  onSelectTemplate: (template: StyleTemplate) => void;
  selectedTemplateId: string;
  onExemplarChange: (text: string) => void;
  currentExemplarText: string;
}

const STORAGE_KEY = '_my_style_templates_v4';

export const StyleTemplateSelector: React.FC<StyleTemplateSelectorProps> = ({
  onSelectTemplate,
  selectedTemplateId,
  onExemplarChange,
}) => {
  const [templates, setTemplates] = useState<StyleTemplate[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch (e) {
      console.warn('Failed to load style templates from storage:', e);
    }
    return DEFAULT_STYLE_TEMPLATES;
  });

  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [showAddForm, setShowAddForm] = useState<boolean>(false);
  const [title, setTitle] = useState<string>('');
  const [courtType, setCourtType] = useState<string>('محكمة الاستئناف');
  const [judicialWorkType, setJudicialWorkType] = useState<string>('مذكرة بدفاع');
  const [content, setContent] = useState<string>('');
  const [notification, setNotification] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);

  const activeTemplate = templates.find((t) => t.id === selectedTemplateId) || templates[0];

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
    } catch (e) {
      console.warn('Failed to save templates to localStorage:', e);
    }
  }, [templates]);

  const handleSelect = (tmpl: StyleTemplate) => {
    onSelectTemplate(tmpl);
    onExemplarChange(tmpl.content);
  };

  const handleDropdownChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selectedId = e.target.value;
    const found = templates.find((t) => t.id === selectedId);
    if (found) {
      handleSelect(found);
    }
  };

  const saveNewTemplateToLibrary = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!title.trim() || !content.trim()) {
      setNotification({
        message: 'يرجى كتابة العنوان والمحتوى.',
        type: 'error',
      });
      setTimeout(() => setNotification(null), 4000);
      return;
    }
    const newEntry: StyleTemplate = {
      id: `tpl-${Date.now()}`,
      name: title.trim(),
      courtType: courtType.trim(),
      judicialWorkType: judicialWorkType.trim(),
      briefType: 'نموذج مخصص',
      description: `قالب مخصص - ${courtType.trim()}`,
      content: content.trim(),
      updatedAt: new Date().toISOString().split('T')[0],
      isDefault: false,
    };
    const updated = [newEntry, ...templates];
    setTemplates(updated);
    handleSelect(newEntry);
    setNotification({
      message: 'تم حفظ النموذج القضائي الجديد بنجاح!',
      type: 'success',
    });
    setTitle('');
    setContent('');
    setShowAddForm(false);
    setTimeout(() => setNotification(null), 4000);
  };

  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const filtered = templates.filter((t) => t.id !== id);
    setTemplates(filtered);
    if (selectedTemplateId === id) {
      if (filtered.length > 0) {
        handleSelect(filtered[0]);
      } else {
        onExemplarChange('');
      }
    }
  };

  return (
    <div className="bg-[#162035] border border-[#b45309]/60 rounded-xl p-3.5 shadow-lg text-white">
      {/* Top Banner Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pb-2.5 border-b border-slate-700/80">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-[#b45309] flex items-center justify-center text-white flex-shrink-0">
            <BookOpen className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-amber-300">
                مكتبة النماذج والقوالب القضائية
              </span>
              <span className="text-[10px] bg-emerald-950 text-emerald-300 px-1.5 py-0.5 rounded border border-emerald-500/40 font-semibold">
                جاهزة للمحاكاة
              </span>
            </div>
            <p className="text-[11px] text-slate-300">
              اختر نموذجاً ليحتذي به المساعد الذكي في الديباجة والأسلوب.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 self-end sm:self-auto">
          <button
            type="button"
            onClick={() => setShowAddForm(!showAddForm)}
            className="px-2.5 py-1 rounded-lg bg-emerald-800 hover:bg-emerald-700 text-white text-[11px] font-bold flex items-center gap-1 transition-colors border border-emerald-600/50 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>إضافة نموذج</span>
          </button>
          <button
            type="button"
            onClick={() => setIsOpen(!isOpen)}
            className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-amber-200 text-[11px] font-semibold flex items-center gap-1 transition-colors border border-slate-700 cursor-pointer"
          >
            <span>{isOpen ? 'إخفاء النماذج' : 'استعراض النماذج'}</span>
            {isOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Dropdown Selector */}
      <div className="mt-3">
        <label htmlFor="templateSelect" className="block text-xs font-semibold text-amber-200 mb-1.5 flex items-center justify-between">
          <span className="flex items-center gap-1.5">
            <Scale className="w-3.5 h-3.5 text-[#b45309]" />
            النموذج الاسترشادي المعتمد:
          </span>
          <span className="text-[10px] text-slate-400">
            {templates.length} نماذج متوفرة
          </span>
        </label>
        <select
          id="templateSelect"
          value={activeTemplate ? activeTemplate.id : ''}
          onChange={handleDropdownChange}
          className="w-full bg-slate-900 border border-[#b45309]/80 rounded-xl px-3 py-2 text-white text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-[#b45309] transition-all cursor-pointer shadow-inner"
        >
          {templates.map((tpl) => (
            <option key={tpl.id} value={tpl.id}>
              {tpl.name} — [{tpl.judicialWorkType || tpl.courtType}]
            </option>
          ))}
        </select>
      </div>

      {notification && (
        <div
          className={`mt-2 p-2 rounded-lg text-xs flex items-center gap-1.5 border transition-all ${
            notification.type === 'success'
              ? 'bg-emerald-950/90 border-emerald-500/50 text-emerald-200'
              : 'bg-rose-950/90 border-rose-500/50 text-rose-200'
          }`}
        >
          {notification.type === 'success' ? (
            <Check className="w-4 h-4 text-emerald-400 flex-shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 text-rose-400 flex-shrink-0" />
          )}
          <span>{notification.message}</span>
        </div>
      )}

      {showAddForm && (
        <form
          onSubmit={saveNewTemplateToLibrary}
          className="mt-3 pt-3 border-t border-slate-700/80 space-y-3 bg-slate-950/90 p-3.5 rounded-xl border border-emerald-500/40 shadow-xl"
        >
          <div className="flex items-center justify-between pb-2 border-b border-slate-800">
            <span className="text-xs font-bold text-emerald-300 flex items-center gap-1.5">
              <Plus className="w-3.5 h-3.5" />
              إضافة نموذج استرشادي جديد
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-xs">
            <div>
              <label htmlFor="newTemplateTitle" className="block text-[11px] font-semibold text-slate-300 mb-1">
                اسم النموذج
              </label>
              <input
                id="newTemplateTitle"
                type="text"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="مثال: مذكرة بطلان إعلان..."
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-white text-xs focus:outline-none focus:border-[#b45309]"
              />
            </div>
            <div>
              <label htmlFor="newTemplateCourt" className="block text-[11px] font-semibold text-slate-300 mb-1">
                المحكمة
              </label>
              <input
                id="newTemplateCourt"
                type="text"
                value={courtType}
                onChange={(e) => setCourtType(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-white text-xs focus:outline-none focus:border-[#b45309]"
              />
            </div>
            <div>
              <label htmlFor="newTemplateWorkType" className="block text-[11px] font-semibold text-slate-300 mb-1">
                نوع العمل
              </label>
              <select
                id="newTemplateWorkType"
                value={judicialWorkType}
                onChange={(e) => setJudicialWorkType(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-white text-xs focus:outline-none focus:border-[#b45309]"
              >
                <option value="مذكرة بدفاع">مذكرة بدفاع</option>
                <option value="صحيفة دعوى">صحيفة دعوى</option>
                <option value="طعن بالنقض">طعن بالنقض</option>
                <option value="إنذار رسمي">إنذار رسمي</option>
              </select>
            </div>
          </div>
          <div>
            <label htmlFor="newTemplateContent" className="block text-[11px] font-semibold text-slate-300 mb-1">
              محتوى النموذج والديباجة
            </label>
            <textarea
              id="newTemplateContent"
              rows={6}
              required
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="اكتب أو الصق نص النموذج القضائي هنا..."
              className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2.5 text-xs text-slate-200 font-amiri leading-relaxed focus:outline-none focus:border-[#b45309]"
            ></textarea>
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setShowAddForm(false)}
              className="px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 text-xs hover:bg-slate-700 transition-colors cursor-pointer"
            >
              إلغاء
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow-md transition-colors flex items-center gap-1.5 cursor-pointer"
            >
              <Check className="w-3.5 h-3.5" />
              <span>حفظ في المكتبة</span>
            </button>
          </div>
        </form>
      )}

      {isOpen && (
        <div className="mt-3 pt-3 border-t border-slate-700/80 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {templates.map((tmpl) => {
              const isSelected = tmpl.id === activeTemplate?.id;
              return (
                <div
                  key={tmpl.id}
                  onClick={() => handleSelect(tmpl)}
                  className={`cursor-pointer rounded-xl p-2.5 text-xs border transition-all flex flex-col justify-between ${
                    isSelected
                      ? 'bg-[#0f172a] border-[#b45309] shadow-md shadow-[#b45309]/30 ring-1 ring-[#b45309]'
                      : 'bg-slate-900/80 border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <div>
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <span className={`font-bold text-xs ${isSelected ? 'text-amber-300' : 'text-slate-200'}`}>
                        {tmpl.name}
                      </span>
                      {isSelected && <Check className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />}
                    </div>
                    <span className="text-[10px] text-amber-400/90 block mb-1">
                      {tmpl.judicialWorkType || tmpl.courtType}
                    </span>
                    <p className="text-[11px] text-slate-300 line-clamp-2 leading-relaxed">
                      {tmpl.description}
                    </p>
                  </div>
                  <div className="mt-2 pt-2 border-t border-slate-800/80 flex items-center justify-between text-[10px] text-slate-400">
                    <span>{tmpl.briefType}</span>
                    {!tmpl.isDefault && (
                      <button
                        type="button"
                        onClick={(e) => handleDelete(tmpl.id, e)}
                        className="text-rose-400 hover:text-rose-300 flex items-center gap-0.5 transition-colors cursor-pointer font-bold"
                        title="حذف هذا النموذج"
                      >
                        <Trash2 className="w-3 h-3" />
                        <span>حذف</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
