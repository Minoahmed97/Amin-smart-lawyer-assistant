import React, { useEffect, useState } from 'react';
import { getSessionToken } from '../services/authService.ts';

interface ChatMessage { role: 'user' | 'assistant'; content: string }
interface Props { taskType: 'deconstruct' | 'qualify' | 'draft'; userId?: string | null; originalContext: string; result: string; onResultChange?: (nextResult: string) => void }

export const LegalFollowupChat: React.FC<Props> = ({ taskType, userId, originalContext, result, onResultChange }) => {
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
  const [copiedMessage, setCopiedMessage] = useState<string | null>(null);

  const copyMessage = async (content: string, messageKey: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content);
      } else {
        const textArea = document.createElement('textarea');
        textArea.value = content;
        textArea.setAttribute('readonly', '');
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        document.body.appendChild(textArea);
        textArea.select();
        const copied = document.execCommand('copy');
        document.body.removeChild(textArea);
        if (!copied) throw new Error('copy_failed');
      }
      setError('');
      setCopiedMessage(messageKey);
      window.setTimeout(() => {
        setCopiedMessage((current) => current === messageKey ? null : current);
      }, 1600);
    } catch {
      setError('تعذر نسخ الرسالة تلقائياً. حاول مرة أخرى أو حدّد النص وانسخه يدوياً.');
    }
  };

  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(messages)); } catch {} }, [messages, storageKey]);

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    const question = draft.trim();
    if (!question || loading || !result.trim()) return;
    const sessionToken = getSessionToken();
    if (!sessionToken) {
      setError('تعذر العثور على رمز جلسة الحساب في هذا المتصفح. حدّث الصفحة، وإذا استمرت المشكلة سجّل الدخول مرة أخرى.');
      return;
    }
    const nextMessages: ChatMessage[] = [...messages, { role: 'user', content: question }];
    setMessages(nextMessages);
    setDraft('');
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/gemini/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({ taskType, originalContext, result, messages: nextMessages, stream: true }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        const retryAfter = Number(response.headers.get('Retry-After') || data?.retryAfter || 0);
        const serverMessage = String(data?.error || '');
        if (response.status === 429) {
          throw new Error(serverMessage || `تم الوصول إلى مهلة الاستخدام. انتظر ${retryAfter || 30} ثانية ثم أعد الإرسال.`);
        }
        if (response.status >= 500) {
          throw new Error(serverMessage || 'تعذر على خدمة الذكاء الاصطناعي إكمال الرد. احتفظ بسؤالك وأعد المحاولة بعد قليل.');
        }
        throw new Error(serverMessage || 'تعذر إرسال السؤال حالياً.');
      }

      let data: any = {};
      if ((response.headers.get('Content-Type') || '').toLowerCase().includes('application/x-ndjson')) {
        if (!response.body) throw new Error('بدأ الاتصال لكن لم يصل تدفق الرد من الخادم.');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let receivedFinalResponse = false;
        const handleLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          let event: any;
          try { event = JSON.parse(trimmed); } catch { return; }
          if (event?.type === 'error') throw new Error(String(event.error || 'تعذر إتمام مناقشة النتيجة.'));
          if (event?.type === 'done') { data = event; receivedFinalResponse = true; }
        };
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || '';
          for (const line of lines) handleLine(line);
        }
        buffer += decoder.decode();
        if (buffer.trim()) handleLine(buffer);
        if (!receivedFinalResponse) throw new Error('انقطع الاتصال قبل وصول إجابة مكتملة. لم يتغير المستند؛ أعد المحاولة.');
      } else {
        data = await response.json().catch(() => ({}));
      }
      const answer = String(data?.result || '').trim();
      if (!answer) throw new Error('لم تصل إجابة صالحة. احتفظ بسؤالك وأعد المحاولة بعد قليل.');
      const updatedResult = typeof data?.updatedResult === 'string' ? data.updatedResult.trim() : '';
      if (updatedResult && updatedResult !== result.trim()) onResultChange?.(updatedResult);
      setMessages((current) => [...current, { role: 'assistant', content: answer }]);
    } catch (err: any) {
      // Remove the failed pending question from the transcript so it is not shown
      // as if it had been answered; restore it to the input for a deliberate retry.
      setMessages((current) => {
        const last = current[current.length - 1];
        return last?.role === 'user' && last.content === question ? current.slice(0, -1) : current;
      });
      setDraft(question);
      const errorMessage = String(err?.message || '');
      setError(/failed to fetch|network request failed|load failed/i.test(errorMessage)
        ? 'انقطع الاتصال بخدمة مناقشة النتيجة قبل استلام الرد. لم يتغير المستند؛ أعد المحاولة، وإذا تكرر الخطأ افحص طلب /api/gemini/chat في سجل Vercel.'
        : (errorMessage || 'تعذر الاتصال بالمساعد القانوني. تحقق من الاتصال ثم أعد المحاولة.'));
    } finally {
      setLoading(false);
    }
  };

  if (!result.trim()) return null;
  return <section className="mt-5 rounded-2xl border border-emerald-700/60 bg-slate-950/70 p-4 space-y-3" dir="rtl">
    <div><h3 className="font-bold text-emerald-300">مناقشة النتيجة مع أمين</h3><p className="text-xs text-slate-400 mt-1">اسأل عن أي نقطة أو اطلب تعديل النتيجة نفسها؛ عند طلب التعديل سيحدّث أمين النتيجة المعروضة والمحفوظة لتصبح هي النسخة المستخدمة في التصدير.</p></div>
    {messages.length > 0 && <div className="space-y-3 max-h-96 overflow-y-auto" aria-live="polite">
      {messages.map((message, index) => {
        const messageKey = `${index}-${message.role}`;
        return <div key={messageKey} className={`rounded-xl p-3 whitespace-pre-wrap text-sm leading-7 ${message.role === 'user' ? 'bg-slate-800 text-white' : 'bg-emerald-950/60 border border-emerald-900 text-slate-100'}`}>
          <div className="mb-1 flex items-center justify-between gap-2">
            <div className="text-[10px] font-bold text-emerald-300">{message.role === 'user' ? 'سؤالك' : 'إجابة أمين'}</div>
            <button type="button" onClick={() => void copyMessage(message.content, messageKey)} className="shrink-0 rounded-md border border-slate-600/70 bg-slate-900/70 px-2 py-1 text-[10px] font-semibold text-slate-200 hover:bg-slate-700 focus:outline-none focus:ring-1 focus:ring-emerald-400" aria-label={`نسخ ${message.role === 'user' ? 'سؤالك' : 'إجابة أمين'}`} title="نسخ الرسالة">
              {copiedMessage === messageKey ? '✓ تم النسخ' : '⧉ نسخ'}
            </button>
          </div>
          {message.content}
        </div>;
      })}
      {loading && <div className="text-xs text-emerald-300 animate-pulse">جارٍ إعداد الرد مع مراعاة سياق القضية...</div>}
    </div>}
    {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
    <form onSubmit={send} className="flex flex-col sm:flex-row gap-2">
      <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} maxLength={10000} placeholder="اسأل عن النتيجة أو اكتب التعديل المطلوب تنفيذه عليها..." className="flex-1 min-w-0 rounded-xl border border-slate-700 bg-slate-900 p-3 text-sm text-white outline-none focus:border-emerald-500" />
      <button type="submit" disabled={loading || !draft.trim()} className="rounded-xl bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 px-5 py-3 text-sm font-bold text-white">{loading ? 'جارٍ الرد...' : 'إرسال السؤال'}</button>
    </form>
  </section>;
};
