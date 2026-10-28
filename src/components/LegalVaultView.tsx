import React, { useState, useEffect } from 'react';
import {
  FolderArchive,
  FileText,
  Trash2,
  CheckCircle2,
  Plus,
  Sparkles,
  BookOpen,
  ShieldCheck,
  Copy,
  Check,
  ArrowRight,
  Info,
  Download,
} from 'lucide-react';
import {
  LawModelItem,
  getAllLawModels,
  saveLawModel,
  updateLawModel,
  deleteLawModel,
  clearAllLawModels,
} from '../utils/legalVaultService.ts';
import { FileUploadZone } from './FileUploadZone.tsx';
import { saveLegalDocTemplate, getLegalDocTemplates, deleteLegalDocTemplate, classifyLegalDocument, LegalDocTemplate } from '../utils/legalTemplateService.ts';
import { saveLegalVaultOriginalFile, getLegalVaultOriginalFiles, downloadLegalVaultOriginalFile, deleteLegalVaultOriginalFile, LegalVaultOriginalFile } from '../utils/legalVaultOriginalFiles.ts';

interface LegalVaultViewProps {
  userId: string;
  onUseModelInDrafting?: (modelContent: string) => void;
  onSwitchTab?: (tab: 'draft' | 'deconstruct' | 'qualify' | 'defenses' | 'packages' | 'vault') => void;
  onModelsCountChanged?: (count: number) => void;
}

export const LegalVaultView: React.FC<LegalVaultViewProps> = ({
  userId,
  onUseModelInDrafting,
  onSwitchTab,
  onModelsCountChanged,
}) => {
  const [models, setModels] = useState<LawModelItem[]>([]);
  const [selectedModel, setSelectedModel] = useState<LawModelItem | null>(null);
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [formTitle, setFormTitle] = useState('');
  const [formCategory, setFormCategory] = useState<string>('مدني');
  const [formWorkType, setFormWorkType] = useState<string>('مذكرة بدفاع');
  const [formContent, setFormContent] = useState('');
  const [formWeight, setFormWeight] = useState<number>(5);
  const [formNotes, setFormNotes] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [successNote, setSuccessNote] = useState<string | null>(null);
  const [wordTemplates, setWordTemplates] = useState<LegalDocTemplate[]>([]);
  const [originalFiles, setOriginalFiles] = useState<LegalVaultOriginalFile[]>([]);

  useEffect(() => {
    refreshModels();
    refreshWordTemplates();
    refreshOriginalFiles();
  }, [userId]);

  const refreshWordTemplates = async () => {
    try { setWordTemplates(await getLegalDocTemplates(userId)); }
    catch (error) { console.warn('Could not load Word templates:', error); }
  };

  const refreshOriginalFiles = async () => {
    try { setOriginalFiles(await getLegalVaultOriginalFiles(userId)); }
    catch (error) { console.warn('Could not load original vault files:', error); }
  };

  const refreshModels = () => {
    const list = getAllLawModels(userId);
    setModels(list);
    if (onModelsCountChanged) {
      onModelsCountChanged(list.length);
    }
    if (!selectedModel && list.length > 0) {
      setSelectedModel(list[0]);
    } else if (selectedModel) {
      const updated = list.find((m) => m.id === selectedModel.id);
      setSelectedModel(updated || (list.length > 0 ? list[0] : null));
    }
  };

  const handleAddNewManual = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formTitle.trim() || !formContent.trim()) {
      alert('يرجى ملء العنوان والمحتوى.');
      return;
    }
    const saved = saveLawModel({
      title: formTitle.trim(),
      category: formCategory,
      judicialWorkType: formWorkType,
      content: formContent.trim(),
      weight: formWeight,
      notes: formNotes.trim(),
      source: 'custom',
    }, userId);
    setFormTitle('');
    setFormContent('');
    setFormNotes('');
    setFormWeight(5);
    setIsAddingNew(false);
    refreshModels();
    setSelectedModel(saved);
    setSuccessNote('تمت إضافة النموذج إلى الخزينة بنجاح!');
    setTimeout(() => setSuccessNote(null), 3500);
  };

  const handleUploadedText = async (text: string, fileName: string, _fileType?: string, sourceFile?: File) => {
    const cleanTitle = fileName.replace(/\.[^/.]+$/, '');
    const classification = classifyLegalDocument(fileName, text);

    // Persist the original file before committing the model. If local file storage
    // fails, the upload queue can retain the file and retry after refresh without
    // creating duplicate models from the same recovered OCR result.
    if (sourceFile) {
      try {
        await saveLegalVaultOriginalFile(sourceFile, userId, text);
        await refreshOriginalFiles();
      } catch (cause: any) {
        console.warn('Original vault file could not be saved:', cause);
        setSuccessNote(`تعذر حفظ الملف الأصلي في الخزنة؛ احتفظنا بالمهمة لإعادة المحاولة: ${fileName}.`);
        const retryError: any = new Error(`تعذر حفظ الملف الأصلي في الخزنة: ${fileName}.`);
        retryError.preservePendingUpload = true;
        throw retryError;
      }

      if (sourceFile.name.toLowerCase().endsWith('.docx')) {
        try {
          const template = await saveLegalDocTemplate(sourceFile, userId, text);
          if (template) await refreshWordTemplates();
        } catch (error) {
          console.warn('Word template index could not be saved:', error);
        }
      }
    }

    const saved = saveLawModel({
      title: `نموذج: ${cleanTitle}`,
      category: classification.category,
      judicialWorkType: classification.workType,
      content: text,
      weight: 5,
      notes: `تم رفعه من المستند (${fileName}). التصنيف الأولي: ${classification.courtType} — ${classification.workType}.`,
      fileName,
      source: 'uploaded',
    }, userId);
    refreshModels();
    setSelectedModel(saved);
    setSuccessNote(sourceFile
      ? `تم حفظ النص والملف الأصلي في الخزنة على هذا الجهاز: ${fileName}.`
      : `تم حفظ النص فقط؛ لم يصل الملف الأصلي إلى الخزنة. أعد رفع المستند إذا كنت تريد الاحتفاظ بنسخته الأصلية.`);
    setTimeout(() => setSuccessNote(null), 6000);
  };

  const handleWeightChange = (id: string, newWeight: number) => {
    updateLawModel(id, { weight: newWeight }, userId);
    refreshModels();
  };

  const handleDelete = (id: string) => {
    if (confirm('هل ترغب في حذف هذا النموذج من الخزينة؟')) {
      deleteLawModel(id, userId);
      refreshModels();
      if (selectedModel?.id === id) {
        setSelectedModel(null);
      }
      setSuccessNote('تم حذف النموذج.');
      setTimeout(() => setSuccessNote(null), 3000);
    }
  };

  const handleClearAll = () => {
    if (confirm('هل ترغب في مسح كافة النماذج من الخزينة؟')) {
      clearAllLawModels(userId);
      setModels([]);
      setSelectedModel(null);
      if (onModelsCountChanged) {
        onModelsCountChanged(0);
      }
      setSuccessNote('تم إفراغ الخزينة.');
      setTimeout(() => setSuccessNote(null), 3500);
    }
  };

  const copyContent = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const exportModelDoc = (model: LawModelItem) => {
    const header = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'><head><meta charset='utf-8'><title>${model.title}</title><style>body{font-family:'Traditional Arabic',Arial;font-size:16pt;direction:rtl;text-align:justify;line-height:1.8;color:#000000;}</style></head><body>`;
    const footer = '</body></html>';
    const html = header + model.content.replace(/\n/g, '<br/>') + footer;
    const blob = new Blob(['\ufeff', html], { type: 'application/msword;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${model.title}.doc`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-4 sm:py-6 space-y-6" style={{ fontFamily: 'Cairo, sans-serif' }}>
      {/* Top Banner */}
      <div className="bg-[#0f172a] border-2 border-[#b45309] rounded-2xl p-4 sm:p-6 shadow-xl">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-start gap-3.5">
            <div className="w-11 h-11 sm:w-12 sm:h-12 rounded-xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-400 flex-shrink-0">
              <FolderArchive className="w-5 h-5 sm:w-6 sm:h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-lg sm:text-2xl font-black text-white">
                  خزينة النماذج القضائية وأسلوب المحامي
                </h2>
                <span className="text-xs bg-[#b45309]/30 text-amber-300 px-2.5 py-0.5 rounded border border-[#b45309] font-bold">
                  {models.length > 0 ? `${models.length} نماذج محفوظة` : 'فارغة'}
                </span>
                <span className="text-xs bg-emerald-950 text-emerald-300 px-2.5 py-0.5 rounded border border-emerald-600/40 font-bold">
                  توجيه الصياغة الذكية تلقائياً
                </span>
              </div>
              <p className="text-xs sm:text-sm text-slate-300 mt-1 leading-relaxed max-w-3xl">
                احفظ نماذجك القضائية المفضلة أو ارفع مذكراتك السابقة (وورد أو بي دي إف) ليتعلم المساعد القضائي أسلوبك الخاص.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {models.length > 0 && (
              <button
                onClick={handleClearAll}
                className="px-3.5 py-2.5 bg-rose-950 hover:bg-rose-900 border border-rose-700/60 text-rose-300 hover:text-white rounded-xl text-xs sm:text-sm font-bold flex items-center gap-1.5 shadow transition-all cursor-pointer whitespace-nowrap"
                title="إفراغ الخزينة"
              >
                <Trash2 className="w-4 h-4 text-rose-400" />
                <span>إفراغ</span>
              </button>
            )}
            <button
              onClick={() => setIsAddingNew(!isAddingNew)}
              className="px-4 py-2.5 bg-gradient-to-r from-amber-600 to-[#b45309] hover:from-amber-500 hover:to-amber-600 text-white rounded-xl text-xs sm:text-sm font-bold flex items-center gap-1.5 shadow-lg transition-all cursor-pointer whitespace-nowrap"
            >
              <Plus className="w-4 h-4" />
              <span>{isAddingNew ? 'إلغاء' : 'إضافة نموذج يدوي'}</span>
            </button>
          </div>
        </div>

        {/* Multi-Format File Uploader */}
        <div className="mt-4 pt-4 border-t border-slate-800">
          <FileUploadZone
            recoveryScope="vault"
            onTextExtracted={handleUploadedText}
            title="إيداع مستندات في الخزينة (وورد / بي دي إف / صور ممسوحة ضوئيًا)"
            description="ارفع مذكراتك أو صحف دعاواك السابقة، وسيقوم الذكاء الاصطناعي باستخراجها وحفظها كنموذج استرشادي."
          />
        </div>

        {originalFiles.length > 0 && (
          <div className="mt-4 rounded-xl border border-slate-700 bg-slate-950/70 p-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <h3 className="text-sm font-bold text-emerald-300">الملفات الأصلية المحفوظة ({originalFiles.length})</h3>
              <span className="text-[11px] text-slate-400">على هذا الجهاز والمتصفح فقط</span>
            </div>
            <div className="mt-2 space-y-2">
              {originalFiles.map((file) => (
                <div key={file.id} className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 p-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-bold text-slate-100 truncate">{file.fileName}</div>
                    <div className="text-[10px] text-slate-400">{file.category} · {file.courtType} · {file.workType} · {(file.size / 1024).toFixed(0)} KB</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button type="button" onClick={() => void downloadLegalVaultOriginalFile(file.id, userId).catch(() => alert('تعذر تنزيل الملف الأصلي.'))} className="rounded-lg border border-emerald-800 px-2 py-1 text-[10px] font-bold text-emerald-300 hover:bg-emerald-950">تنزيل</button>
                    <button type="button" onClick={() => { if (confirm('هل تريد حذف النسخة الأصلية من هذا الجهاز؟ سيظل النص المستخرج محفوظًا.')) void deleteLegalVaultOriginalFile(file.id, userId).then(refreshOriginalFiles).catch(() => alert('تعذر حذف الملف.')); }} className="rounded-lg border border-rose-800 px-2 py-1 text-[10px] font-bold text-rose-300 hover:bg-rose-950">حذف</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {wordTemplates.length > 0 && (
          <div className="mt-4 rounded-xl border border-slate-700 bg-slate-950/70 p-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <h3 className="text-sm font-bold text-amber-300">قوالب وورد الأصلية المحفوظة ({wordTemplates.length})</h3>
              <span className="text-[11px] text-slate-400">محفوظة على هذا الجهاز والمتصفح</span>
            </div>
            <div className="mt-2 space-y-2">
              {wordTemplates.map((template) => (
                <div key={template.id} className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 p-2">
                  <div className="min-w-0">
                    <div className="text-xs font-bold text-slate-100 truncate">{template.title}</div>
                    <div className="text-[10px] text-slate-400">{template.courtType} · {template.workType}</div>
                  </div>
                  <button type="button" onClick={() => {
                    if (confirm('هل تريد حذف ملف القالب الأصلي؟ سيظل النص المستخرج محفوظًا في الخزينة.')) {
                      void deleteLegalDocTemplate(template.id, userId).then(refreshWordTemplates).catch(() => alert('تعذر حذف القالب.'));
                    }
                  }} className="shrink-0 rounded-lg border border-rose-800 px-2 py-1 text-[10px] font-bold text-rose-300 hover:bg-rose-950">حذف القالب</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {successNote && (
          <div className="mt-3 p-3 bg-emerald-950/80 border border-emerald-500 rounded-xl text-emerald-200 text-xs font-bold flex items-center gap-2 animate-in fade-in">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
            <span>{successNote}</span>
          </div>
        )}
      </div>

      {/* Manual Add Form */}
      {isAddingNew && (
        <form onSubmit={handleAddNewManual} className="bg-[#0f172a] border border-[#b45309] rounded-2xl p-5 shadow-2xl space-y-4 animate-in fade-in">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <h3 className="text-sm font-bold text-amber-400 flex items-center gap-1.5">
              <Plus className="w-4 h-4" />
              <span>إضافة نموذج قضائي جديد يدوياً:</span>
            </h3>
            <span className="text-xs text-slate-400">حفظ محلي فوري</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1">عنوان النموذج:</label>
              <input
                type="text"
                value={formTitle}
                onChange={(e) => setFormTitle(e.target.value)}
                placeholder="مثال: مذكرة طرد للغصب نموذجية..."
                className="w-full p-2.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs outline-none focus:border-[#b45309]"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1">نوع العمل القضائي:</label>
              <select
                value={formWorkType}
                onChange={(e) => setFormWorkType(e.target.value)}
                className="w-full p-2.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs outline-none focus:border-[#b45309] cursor-pointer"
              >
                <option value="مذكرة بدفاع">مذكرة بدفاع (جوابية)</option>
                <option value="صحيفة دعوى">صحيفة دعوى</option>
                <option value="طعن بالنقض">طعن بالنقض</option>
                <option value="إنذار رسمي">إنذار رسمي على يد محضر</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-300 mb-1">
                وزن المحاكاة في الذكاء الاصطناعي (1 إلى 5):
              </label>
              <div className="flex items-center gap-1 mt-1">
                {[1, 2, 3, 4, 5].map((w) => (
                  <button
                    type="button"
                    key={w}
                    onClick={() => setFormWeight(w)}
                    className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                      formWeight === w
                        ? 'bg-[#b45309] text-white font-black shadow-md'
                        : 'bg-slate-800 text-slate-400 hover:text-white'
                    }`}
                  >
                    ★ {w}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-300 mb-1">
              ملاحظات وتوجيهات خاصة بالنموذج:
            </label>
            <input
              type="text"
              value={formNotes}
              onChange={(e) => setFormNotes(e.target.value)}
              placeholder="مثال: يركز على أحكام النقض الحديثة في المادة 802 مدني..."
              className="w-full p-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs outline-none focus:border-[#b45309]"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-300 mb-1">
              نص النموذج القضائي الكامل:
            </label>
            <textarea
              rows={8}
              value={formContent}
              onChange={(e) => setFormContent(e.target.value)}
              placeholder="ألصق نص المذكرة أو الصحيفة والديباجة هنا..."
              className="w-full p-3 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs leading-relaxed outline-none focus:border-[#b45309] font-amiri"
              required
            ></textarea>
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setIsAddingNew(false)}
              className="px-4 py-2 bg-slate-800 text-slate-300 rounded-lg text-xs font-bold cursor-pointer"
            >
              إلغاء
            </button>
            <button
              type="submit"
              className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold transition-all cursor-pointer shadow"
            >
              حفظ في الخزينة
            </button>
          </div>
        </form>
      )}

      {/* Main Two-Column View */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Models List (5 cols) */}
        <div className="lg:col-span-5 bg-[#0f172a] border border-slate-800 rounded-2xl p-4 shadow-xl space-y-3">
          <div className="flex items-center justify-between pb-2 border-b border-slate-800">
            <h3 className="text-xs sm:text-sm font-bold text-white flex items-center gap-1.5">
              <BookOpen className="w-4 h-4 text-amber-400" />
              <span>النماذج المحفوظة ({models.length})</span>
            </h3>
            {models.length > 0 && (
              <span className="text-[11px] text-emerald-400 font-semibold">
                جاهزة للتغذية الذكية
              </span>
            )}
          </div>

          {models.length > 0 ? (
            <div className="space-y-2.5 max-h-[680px] overflow-y-auto pr-1">
              {models.map((model) => {
                const isSelected = selectedModel?.id === model.id;
                return (
                  <div
                    key={model.id}
                    onClick={() => setSelectedModel(model)}
                    className={`p-3.5 rounded-xl border transition-all cursor-pointer text-right flex flex-col justify-between gap-2.5 ${
                      isSelected
                        ? 'bg-amber-950/30 border-[#b45309] ring-1 ring-amber-500/50 shadow-lg'
                        : 'bg-slate-900 border-slate-800 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-bold text-xs sm:text-sm text-white line-clamp-2">
                        {model.title}
                      </span>
                      <span className="text-[10px] bg-slate-800 text-amber-300 px-2 py-0.5 rounded border border-slate-700 whitespace-nowrap flex-shrink-0">
                        {model.judicialWorkType || model.category.split(' ')[0]}
                      </span>
                    </div>

                    {model.notes && (
                      <p className="text-[11px] text-amber-200/80 bg-amber-950/30 px-2 py-1 rounded border border-amber-900/30 line-clamp-1">
                        {model.notes}
                      </p>
                    )}

                    <p className="text-[11px] text-slate-400 line-clamp-2 leading-relaxed">
                      {model.content.slice(0, 140)}...
                    </p>

                    <div className="flex items-center justify-between pt-2 border-t border-slate-800/80 text-[10px]">
                      <div className="flex items-center gap-1">
                        <span className="text-slate-400 font-bold">الوزن:</span>
                        <div className="flex items-center gap-0.5">
                          {[1, 2, 3, 4, 5].map((w) => (
                            <button
                              key={w}
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleWeightChange(model.id, w);
                              }}
                              className={`w-4 h-4 rounded text-[9px] font-bold flex items-center justify-center cursor-pointer transition-all ${
                                (model.weight || 5) >= w
                                  ? 'bg-[#b45309] text-white'
                                  : 'bg-slate-800 text-slate-600'
                              }`}
                              title={`تعيين الوزن ${w}`}
                            >
                              ★
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(model.id);
                          }}
                          className="text-rose-400 hover:text-rose-300 p-1.5 rounded hover:bg-rose-950/50 transition-colors cursor-pointer flex items-center gap-1 font-bold"
                          title="حذف النموذج"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>حذف</span>
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="p-8 text-center text-slate-400 space-y-3 bg-slate-900/50 rounded-xl border border-slate-800">
              <FolderArchive className="w-10 h-10 mx-auto text-slate-600" />
              <p className="text-xs font-bold text-slate-300">خزينتك خالية حتى الآن</p>
              <p className="text-[11px] text-slate-500">
                ارفع مستندات وورد أو أضف نماذج ليتعلم المساعد أسلوبك.
              </p>
            </div>
          )}
        </div>

        {/* Right Column: Model Detailed View & Actions (7 cols) */}
        <div className="lg:col-span-7 bg-[#0f172a] border-2 border-[#b45309] rounded-2xl p-4 sm:p-5 shadow-xl space-y-4">
          {selectedModel ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-800">
                <div>
                  <h3 className="font-bold text-white text-base flex items-center gap-2">
                    <FileText className="w-5 h-5 text-amber-400" />
                    <span>{selectedModel.title}</span>
                  </h3>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs text-slate-400">
                      النوع: <b className="text-amber-300">{selectedModel.judicialWorkType || selectedModel.category}</b>
                    </span>
                    <span className="text-slate-600">|</span>
                    <span className="text-xs text-amber-400 font-bold">
                      الوزن الاسترشادي: {selectedModel.weight || 5} نجوم
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={() => copyContent(selectedModel.content, selectedModel.id)}
                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-bold transition-all flex items-center gap-1 cursor-pointer border border-slate-700"
                  >
                    {copiedId === selectedModel.id ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedId === selectedModel.id ? 'تم النسخ!' : 'نسخ النص'}</span>
                  </button>
                  <button
                    onClick={() => exportModelDoc(selectedModel)}
                    className="px-3 py-1.5 bg-emerald-800 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold transition-all flex items-center gap-1 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>تصدير وورد</span>
                  </button>
                  <button
                    onClick={() => handleDelete(selectedModel.id)}
                    className="px-3 py-1.5 bg-rose-950 hover:bg-rose-900 border border-rose-700/60 text-rose-300 hover:text-white rounded-lg text-xs font-bold transition-all flex items-center gap-1 cursor-pointer"
                    title="حذف هذا النموذج"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>حذف</span>
                  </button>
                  {onSwitchTab && (
                    <button
                      onClick={() => {
                        if (onUseModelInDrafting) {
                          onUseModelInDrafting(selectedModel.content);
                        }
                        onSwitchTab('deconstruct');
                      }}
                      className="px-3.5 py-1.5 bg-[#b45309] hover:bg-amber-600 text-white rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer shadow-md"
                      title="استخدام هذا النموذج في الصياغة"
                    >
                      <Sparkles className="w-3.5 h-3.5 text-amber-200" />
                      <span>استخدام في الصياغة</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>

              {selectedModel.notes && (
                <div className="bg-amber-950/20 border border-amber-500/30 p-2.5 rounded-xl text-xs text-amber-200 flex items-center gap-2">
                  <Info className="w-4 h-4 text-amber-400 flex-shrink-0" />
                  <span>
                    <b>ملاحظة:</b> {selectedModel.notes}
                  </span>
                </div>
              )}

              {/* Model Content Display */}
              <div className="bg-[#1e293b] border border-slate-700 rounded-xl p-4 sm:p-5 text-slate-100 text-xs sm:text-sm leading-relaxed whitespace-pre-wrap max-h-[600px] overflow-y-auto font-amiri shadow-inner select-text">
                {selectedModel.content}
              </div>

              <div className="bg-emerald-950/40 border border-emerald-500/30 p-3 rounded-xl text-xs text-emerald-300 flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                <span>
                  <b>تنبيه الأمان:</b> يتم تضمين هذا النموذج تلقائياً في سياق الذكاء الاصطناعي لضمان محاكاة أسلوب مكتبك.
                </span>
              </div>
            </>
          ) : (
            <div className="p-16 text-center text-slate-400 space-y-3">
              <FolderArchive className="w-12 h-12 mx-auto text-slate-600" />
              <p className="text-sm font-semibold">اختر نموذجاً من القائمة الجانبية لمعاينته</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
