import React, { useEffect, useState } from 'react';

interface ChatMessage { role: 'user' | 'assistant'; content: string }
interface Props { taskType: 'deconstruct' | 'qualify'; userId?: string | null; originalContext: string; result: string }

export const LegalFollowupChat: React.FC<Props> = ({ taskType, userId, originalContext, result }) => {
  // A context-specific key preserves a conversation on refresh but isolates different cases.
  const contextFingerprint = (() => {
    let hash = 2166136261;
    for (let i = 0; i < originalContext.length; i += 1) {
      hash ^= originalContext.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  })();
  const storageKey = `amin_legal_followup_${taskType}_${String(userId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_')}_${contextFingerprint}`;
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    try { const saved = localStorage.getItem(storageKey); return saved ? JSON.parse(saved) : []; } catch { return []; }
  });
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(messages)); } catch {} }, [messages, storageKey]);

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    const question = draft.trim();
    if (!question || loading || !result.trim()) return;
    const nextMessages: ChatMessage[] = [...messages, { role: 'user', content: question }];
    setMessages(nextMessages);
    setDraft('');
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/gemini/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskType, originalContext, result, messages: nextMessages }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || 'تعذر إرسال السؤال حالياً.');
      const answer = String(data?.result || '').trim();
      if (!answer) throw new Error('لم تصل إجابة صالحة. حاول مرة أخرى.');
      setMessages((current) => [...current, { role: 'assistant', content: answer }]);
    } catch (err: any) {
      setError(err?.message || 'تعذر الاتصال بالمساعد القانوني.');
    } finally {
      setLoading(false);
    }
  };

  if (!result.trim()) return null;
  return <section className="mt-5 rounded-2xl border border-emerald-700/60 bg-slate-950/70 p-4 space-y-3" dir="rtl">
    <div><h3 className="font-bold text-emerald-300">مناقشة النتيجة مع أمين</h3><p className="text-xs text-slate-400 mt-1">اسأل عن أي نقطة أو أضف وقائع جديدة، وستظل النتيجة الأصلية وسياق الرسائل السابقة متاحين للمناقشة.</p></div>
    {messages.length > 0 && <div className="space-y-3 max-h-96 overflow-y-auto" aria-live="polite">
      {messages.map((message, index) => <div key={`${index}-${message.role}`} className={`rounded-xl p-3 whitespace-pre-wrap text-sm leading-7 ${message.role === 'user' ? 'bg-slate-800 text-white' : 'bg-emerald-950/60 border border-emerald-900 text-slate-100'}`}><div className="text-[10px] font-bold mb-1 text-emerald-300">{message.role === 'user' ? 'سؤالك' : 'إجابة أمين'}</div>{message.content}</div>)}
      {loading && <div className="text-xs text-emerald-300 animate-pulse">جارٍ إعداد الرد مع مراعاة سياق القضية...</div>}
    </div>}
    {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
    <form onSubmit={send} className="flex flex-col sm:flex-row gap-2">
      <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} maxLength={10000} placeholder="اكتب سؤالك أو الوقائع الإضافية هنا..." className="flex-1 min-w-0 rounded-xl border border-slate-700 bg-slate-900 p-3 text-sm text-white outline-none focus:border-emerald-500" />
      <button type="submit" disabled={loading || !draft.trim()} className="rounded-xl bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 px-5 py-3 text-sm font-bold text-white">{loading ? 'جارٍ الرد...' : 'إرسال السؤال'}</button>
    </form>
  </section>;
};
