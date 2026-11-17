import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  LegalCase,
  LegalCaseRecord,
  LegalCaseDocument,
  createLegalCase,
  createLegalCaseRecord,
  uploadLegalCaseDocument,
  listLegalCaseDocuments,
  getLegalCaseDocumentDownloadUrl,
  deleteLegalCaseDocument,
  listLegalCases,
  listLegalCaseRecords,
  selectedLegalCaseStorageKey,
} from '../services/legalCaseService.ts';
import { FileUploadZone } from './FileUploadZone.tsx';

interface Props { userId: string; }

export const LegalCaseWorkspace: React.FC<Props> = ({ userId }) => {
  const storageKey = useMemo(() => selectedLegalCaseStorageKey(userId), [userId]);
  const [cases, setCases] = useState<LegalCase[]>([]);
  const [selectedCaseId, setSelectedCaseId] = useState('');
  const [records, setRecords] = useState<LegalCaseRecord[]>([]);
  const [documents, setDocuments] = useState<LegalCaseDocument[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState('');
  const [caseNumber, setCaseNumber] = useState('');
  const [courtName, setCourtName] = useState('');
  const [recordType, setRecordType] = useState('note');
  const [recordTitle, setRecordTitle] = useState('');
  const [recordContent, setRecordContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refreshCases = useCallback(async () => {
    const rows = await listLegalCases();
    setCases(rows);
    const saved = (() => { try { return localStorage.getItem(storageKey) || ''; } catch { return ''; } })();
    const next = rows.some((item) => item.id === saved) ? saved : (rows[0]?.id || '');
    setSelectedCaseId(next);
    try { if (next) localStorage.setItem(storageKey, next); else localStorage.removeItem(storageKey); } catch {}
  }, [storageKey]);

  useEffect(() => {
    let active = true;
    setError('');
    void listLegalCases().then((rows) => {
      if (!active) return;
      setCases(rows);
      const saved = (() => { try { return localStorage.getItem(storageKey) || ''; } catch { return ''; } })();
      const next = rows.some((item) => item.id === saved) ? saved : (rows[0]?.id || '');
      setSelectedCaseId(next);
      try { if (next) localStorage.setItem(storageKey, next); else localStorage.removeItem(storageKey); } catch {}
    }).catch((e: any) => { if (active) setError(e?.message || 'تعذر تحميل ملفات القضايا.'); });
    return () => { active = false; };
  }, [storageKey]);

  useEffect(() => {
    let active = true;
    if (!selectedCaseId) { setRecords([]); return; }
    const refreshRecords = () => {
      void listLegalCaseRecords(selectedCaseId).then((rows) => { if (active) setRecords(rows); })
        .catch((e: any) => { if (active) setError(e?.message || 'تعذر تحميل سجل القضية.'); });
    };
    const handleHistoryUpdate = (event: Event) => {
      const caseId = (event as CustomEvent<{ caseId?: string }>).detail?.caseId;
      if (caseId === selectedCaseId) refreshRecords();
    };
    refreshRecords();
    window.addEventListener('amin_legal_case_history_updated', handleHistoryUpdate);
    return () => { active = false; window.removeEventListener('amin_legal_case_history_updated', handleHistoryUpdate); };
  }, [selectedCaseId]);

  useEffect(() => {
    let active = true;
    if (!selectedCaseId) { setDocuments([]); return; }
    void listLegalCaseDocuments(selectedCaseId).then((rows) => { if (active) setDocuments(rows); })
      .catch((e: any) => { if (active) setError(e?.message || 'تعذر تحميل مستندات القضية.'); });
    return () => { active = false; };
  }, [selectedCaseId]);

  const handleCaseFileExtracted = async (text: string, fileName: string, fileType?: string, sourceFile?: File) => {
    if (!selectedCaseId) return;
    setLoading(true); setError('');
    try {
      if (sourceFile) {
        await uploadLegalCaseDocument(selectedCaseId, sourceFile, text);
        setDocuments(await listLegalCaseDocuments(selectedCaseId));
      } else {
        await createLegalCaseRecord(selectedCaseId, { record_type: 'document', title: fileName || 'مستند مستخرج', content: text });
        setRecords(await listLegalCaseRecords(selectedCaseId));
      }
    } catch (e: any) {
      setError(e?.message || 'تعذر حفظ المستند في ذاكرة القضية.');
      throw e;
    } finally { setLoading(false); }
  };

  const handleDownloadDocument = async (documentId: string) => {
    try {
      const url = await getLegalCaseDocumentDownloadUrl(selectedCaseId, documentId);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (e: any) { setError(e?.message || 'تعذر تنزيل المستند.'); }
  };

  const handleDeleteDocument = async (documentId: string) => {
    if (!window.confirm('هل تريد حذف هذا المستند من ملف القضية نهائياً؟')) return;
    setLoading(true); setError('');
    try {
      await deleteLegalCaseDocument(selectedCaseId, documentId);
      setDocuments(await listLegalCaseDocuments(selectedCaseId));
    } catch (e: any) { setError(e?.message || 'تعذر حذف المستند.'); }
    finally { setLoading(false); }
  };

  const chooseCase = (id: string) => {
    setSelectedCaseId(id);
    try { if (id) localStorage.setItem(storageKey, id); else localStorage.removeItem(storageKey); } catch {}
    window.dispatchEvent(new CustomEvent('amin_legal_case_changed', { detail: { caseId: id } }));
  };

  const handleCreateCase = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    setLoading(true); setError('');
    try {
      const created = await createLegalCase({ title: title.trim(), case_number: caseNumber.trim(), court_name: courtName.trim() });
      await refreshCases();
      chooseCase(created.id);
      setTitle(''); setCaseNumber(''); setCourtName(''); setShowCreate(false);
    } catch (e: any) { setError(e?.message || 'تعذر إنشاء القضية.'); }
    finally { setLoading(false); }
  };

  const handleAddRecord = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selectedCaseId || !recordTitle.trim() || !recordContent.trim()) return;
    setLoading(true); setError('');
    try {
      await createLegalCaseRecord(selectedCaseId, { record_type: recordType, title: recordTitle.trim(), content: recordContent.trim() });
      setRecords(await listLegalCaseRecords(selectedCaseId));
      setRecordTitle(''); setRecordContent('');
    } catch (e: any) { setError(e?.message || 'تعذر حفظ سجل القضية.'); }
    finally { setLoading(false); }
  };

  const selected = cases.find((item) => item.id === selectedCaseId);

  return (
    <section className="mx-auto w-full max-w-7xl px-3 sm:px-6 pt-3" dir="rtl">
      <div className="rounded-2xl border border-amber-500/30 bg-slate-900/80 p-3 sm:p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-black text-amber-300">ذاكرة القضايا الدائمة</h2>
            <p className="text-xs text-slate-400 mt-1">اختر القضية لربط سجلها بمهام الصياغة والتفنيد.</p>
          </div>
          <button type="button" onClick={() => setShowCreate((value) => !value)} className="rounded-lg border border-amber-500/50 px-3 py-2 text-xs font-bold text-amber-200 hover:bg-amber-950/40">
            {showCreate ? 'إلغاء' : 'إضافة قضية'}
          </button>
        </div>

        {showCreate && (
          <form onSubmit={handleCreateCase} className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="اسم / عنوان القضية *" className="rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white" required />
            <input value={caseNumber} onChange={(e) => setCaseNumber(e.target.value)} placeholder="رقم الدعوى" className="rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white" />
            <input value={courtName} onChange={(e) => setCourtName(e.target.value)} placeholder="المحكمة" className="rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white" />
            <button disabled={loading} className="sm:col-span-3 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 px-4 py-2 text-sm font-bold text-white">حفظ ملف القضية</button>
          </form>
        )}

        <select value={selectedCaseId} onChange={(e) => chooseCase(e.target.value)} className="w-full rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white">
          <option value="">لا توجد قضية محددة — لن يُرفق سجل قضية بسياق الذكاء الاصطناعي</option>
          {cases.map((item) => <option key={item.id} value={item.id}>{item.title}{item.case_number ? ` — ${item.case_number}` : ''}</option>)}
        </select>

        {selected && (
          <div className="space-y-3 border-t border-slate-700 pt-3">
            <div className="text-xs text-slate-300">
              {selected.court_name || 'المحكمة غير محددة'}{selected.case_number ? ` • رقم الدعوى: ${selected.case_number}` : ''}
              <span className="mr-2 text-emerald-300">السجل المحفوظ: {records.length} بند</span>
            </div>
            <div className="rounded-xl border border-slate-700 bg-slate-950/40 p-3 space-y-2">
              <h3 className="text-sm font-bold text-amber-200">مستندات القضية</h3>
              <p className="text-xs text-slate-400">ارفع المستندات من هنا؛ يستخدم أمين مسار استخراج النص الحالي، ثم يحفظ الملف الأصلي والنص المستخرج في ملف القضية الخاص.</p>
              <FileUploadZone
                title="إضافة مستندات إلى ذاكرة القضية"
                description="PDF وWord والصور والملفات النصية — حتى 20 ملفاً في الدفعة."
                maxFiles={20}
                recoveryScope="case-memory"
                userId={userId}
                onTextExtracted={handleCaseFileExtracted}
              />
              <div className="space-y-2">
                {documents.map((document) => (
                  <div key={document.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950 p-2">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-bold text-slate-200">{document.file_name}</p>
                      <p className="text-[11px] text-slate-500">{document.document_type} • {Math.max(1, Math.round(Number(document.file_size || 0) / 1024))} كيلوبايت</p>
                    </div>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => void handleDownloadDocument(document.id)} className="rounded border border-amber-500/40 px-2 py-1 text-xs text-amber-200">فتح</button>
                      <button type="button" disabled={loading} onClick={() => void handleDeleteDocument(document.id)} className="rounded border border-rose-500/40 px-2 py-1 text-xs text-rose-200 disabled:opacity-40">حذف</button>
                    </div>
                  </div>
                ))}
                {!documents.length && <p className="text-xs text-slate-500">لا توجد مستندات مرفوعة لهذه القضية بعد.</p>}
              </div>
            </div>
            <form onSubmit={handleAddRecord} className="grid grid-cols-1 sm:grid-cols-4 gap-2">
              <select value={recordType} onChange={(e) => setRecordType(e.target.value)} className="rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white">
                <option value="note">ملاحظة</option><option value="fact">واقعة</option><option value="memorandum">مذكرة سابقة</option><option value="filing">إجراء / إيداع</option><option value="request">طلب</option><option value="hearing">جلسة</option><option value="judgment">حكم</option><option value="defense">دفع سابق</option><option value="document">مستند</option><option value="analysis">تحليل</option>
              </select>
              <input value={recordTitle} onChange={(e) => setRecordTitle(e.target.value)} placeholder="عنوان البند" className="sm:col-span-3 rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white" />
              <textarea value={recordContent} onChange={(e) => setRecordContent(e.target.value)} placeholder="أدخل تفاصيل الواقعة أو الإجراء أو المذكرة أو الطلب..." rows={3} className="sm:col-span-4 rounded-lg bg-slate-950 border border-slate-700 px-3 py-2 text-sm text-white" />
              <button disabled={loading || !recordTitle.trim() || !recordContent.trim()} className="sm:col-span-4 rounded-lg border border-amber-500/50 px-4 py-2 text-sm font-bold text-amber-200 disabled:opacity-40">حفظ في ذاكرة القضية</button>
            </form>
            <div className="max-h-64 overflow-y-auto space-y-2">
              {records.map((record) => (
                <article key={record.id} className="rounded-lg bg-slate-950/70 border border-slate-800 p-3">
                  <div className="flex flex-wrap justify-between gap-2 text-xs">
                    <strong className="text-amber-200">{record.title}</strong>
                    <span className="text-slate-500">{record.record_type} • {record.occurred_at || record.created_at || ''}</span>
                  </div>
                  <p className="mt-2 text-sm text-slate-300 whitespace-pre-wrap">{record.content}</p>
                </article>
              ))}
              {!records.length && <p className="text-xs text-slate-500">لم يُضف سجل لهذه القضية بعد.</p>}
            </div>
          </div>
        )}
        {error && <p className="rounded-lg bg-rose-950/40 border border-rose-500/30 p-2 text-xs text-rose-200">{error}</p>}
      </div>
    </section>
  );
};
