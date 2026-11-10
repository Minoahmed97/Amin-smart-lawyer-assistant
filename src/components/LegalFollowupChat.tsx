import React, { useEffect, useRef, useState } from 'react';
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
    try {
      const saved = localStorage.getItem(storageKey);
      const parsed = saved ? JSON.parse(saved) : [];
      return Array.isArray(parsed) ? parsed.filter((message: any) =>
        message && (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string'
      ) : [];
    } catch { return []; }
  });
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copiedMessage, setCopiedMessage] = useState<string | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const recoveryStartedKeyRef = useRef<string | null>(null);
  const sendRef = useRef<((event: React.FormEvent, recoveredQuestion?: string, isRecovery?: boolean) => Promise<void>) | null>(null);
  const requestSequenceRef = useRef(0);
  const activeRequestRef = useRef<{ requestId: number; question: string; storageKey: string } | null>(null);
  const currentPropsRef = useRef({ storageKey, originalContext, result });
  currentPropsRef.current = { storageKey, originalContext, result };
  const previousStorageKeyRef = useRef(storageKey);
  const previousResultRef = useRef(result);
  const persistedStorageKeyRef = useRef(storageKey);

  // Invalidate responses when the case context or current result changes, and
  // load the transcript belonging to the newly selected context.
  useEffect(() => {
    const contextChanged = previousStorageKeyRef.current !== storageKey;
    const resultChanged = previousResultRef.current !== result;
    if (!contextChanged && !resultChanged) return;

    const interruptedRequest = activeRequestRef.current;
    requestSequenceRef.current += 1;
    setLoading(false);
    setError('');
    recoveryStartedKeyRef.current = null;
    previousResultRef.current = result;

    if (interruptedRequest && interruptedRequest.requestId < requestSequenceRef.current) {
      activeRequestRef.current = null;
      if (!contextChanged && resultChanged) {
        setMessages((current) => {
          const last = current[current.length - 1];
          return last?.role === 'user' && last.content === interruptedRequest.question
            ? current.slice(0, -1)
            : current;
        });
        setDraft(interruptedRequest.question);
        setError('تغيّرت النتيجة أثناء إعداد الرد. أعد إرسال السؤال بعد استقرار النتيجة.');
      }
    }

    if (contextChanged) {
      previousStorageKeyRef.current = storageKey;
      recoveryStartedKeyRef.current = null;
      let savedMessages: ChatMessage[] = [];
      try {
        const saved = localStorage.getItem(storageKey);
        const parsed = saved ? JSON.parse(saved) : [];
        if (Array.isArray(parsed)) {
          savedMessages = parsed.filter((message: any) =>
            message && (message.role === 'user' || message.role === 'assistant') && typeof message.content === 'string'
          );
        }
      } catch {}
      setMessages(savedMessages);
      setDraft('');
    }
  }, [storageKey, result]);

  // Keep the newest message visible when opening the chat, sending a message,
  // receiving a reply, or showing/hiding the loading indicator.
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [messages, loading]);

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

  useEffect(() => {
    // Do not briefly write the previous context's transcript under a new key.
    if (persistedStorageKeyRef.current !== storageKey) {
      persistedStorageKeyRef.current = storageKey;
      return;
    }
    try { localStorage.setItem(storageKey, JSON.stringify(messages)); } catch {}
  }, [messages, storageKey]);

  const send = async (event: React.FormEvent, recoveredQuestion?: string, isRecovery = false) => {
    event.preventDefault();
    const question = (recoveredQuestion ?? draft).trim();
    if (!question || loading || !result.trim()) return;
    const sessionToken = getSessionToken();
    if (!sessionToken) {
      setError('تعذر العثور على رمز جلسة الحساب في هذا المتصفح. حدّث الصفحة، وإذا استمرت المشكلة سجّل الدخول مرة أخرى.');
      return;
    }
    const requestId = ++requestSequenceRef.current;
    activeRequestRef.current = { requestId, question, storageKey };
    const requestStorageKey = storageKey;
    const requestOriginalContext = originalContext;
    const requestResult = result;
    const isRequestCurrent = () =>
      requestId === requestSequenceRef.current &&
      currentPropsRef.current.storageKey === requestStorageKey &&
      currentPropsRef.current.originalContext === requestOriginalContext &&
      currentPropsRef.current.result === requestResult;
    const pendingKey = `${requestStorageKey}_pending_job`;
    let jobId = '';

    if (isRecovery) {
      // The question may have been saved before refresh, or refresh may have
      // happened before the message-saving effect ran. Ensure it appears once.
      setMessages((current) => {
        const last = current[current.length - 1];
        return last?.role === 'user' && last.content === question
          ? current
          : [...current, { role: 'user', content: question }];
      });
    } else {
      const nextMessages: ChatMessage[] = [...messages, { role: 'user', content: question }];
      setMessages(nextMessages);
      setDraft('');
    }
    setLoading(true);
    setError('');
    try {
      // Route legal chat through the durable background-job worker rather than
      // holding one browser connection open for the full model response.
      const fingerprint = (value: string) => {
        let hash = 2166136261;
        for (let i = 0; i < value.length; i += 1) {
          hash ^= value.charCodeAt(i);
          hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(36);
      };
      try {
        const pending = JSON.parse(localStorage.getItem(pendingKey) || 'null');
        if (pending?.question === question && pending?.resultFingerprint === fingerprint(result)) jobId = String(pending.jobId || '');
      } catch {}
      if (!/^[0-9a-f-]{36}$/i.test(jobId)) {
        jobId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
              const random = Math.random() * 16 | 0;
              return (char === 'x' ? random : (random & 0x3 | 0x8)).toString(16);
            });
        try { localStorage.setItem(pendingKey, JSON.stringify({ jobId, question, resultFingerprint: fingerprint(result) })); } catch {}
      }

      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      };
      let createResponse: Response | null = null;
      let createError: unknown = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          createResponse = await fetch('/api/gemini/jobs', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              taskType: 'legal-chat',
              jobId,
              // Send only the current request to the AI. Keep the full transcript
              // in local UI state, but do not resend old chat turns or duplicate case context.
              payload: {
              taskType,
              originalContext: requestOriginalContext,
              result: requestResult,
              messages: [{ role: 'user', content: question }],
            },
            }),
          });
          createError = null;
          break;
        } catch (error) {
          createError = error;
          if (attempt === 0) await new Promise((resolve) => window.setTimeout(resolve, 700));
        }
      }
      if (!createResponse) throw createError instanceof Error ? createError : new Error('تعذر بدء مهمة الدردشة القانونية.');
      const createData = await createResponse.json().catch(() => ({}));
      if (!createResponse.ok) {
        try {
          const pending = JSON.parse(localStorage.getItem(pendingKey) || 'null');
          if (pending?.jobId === jobId) localStorage.removeItem(pendingKey);
        } catch {}
        const retryAfter = Number(createResponse.headers.get('Retry-After') || createData?.retryAfter || 0);
        const serverMessage = String(createData?.error || '');
        const rejected: any = new Error(createResponse.status === 429
          ? (serverMessage || `تم الوصول إلى مهلة الاستخدام. انتظر ${retryAfter || 30} ثانية ثم أعد الإرسال.`)
          : (serverMessage || `تعذر حفظ مهمة الدردشة القانونية (${createResponse.status}).`));
        rejected.statusCode = createResponse.status;
        rejected.jobCreationRejected = true;
        throw rejected;
      }
      if (!isRequestCurrent()) return;

      const startedAt = Date.now();
      let transientFailures = 0;
      let finalData: any = null;
      while (Date.now() - startedAt < 20 * 60 * 1000) {
        if (!isRequestCurrent()) return;
        try {
          const statusResponse = await fetch(`/api/gemini/jobs?id=${encodeURIComponent(jobId)}`, {
            method: 'GET', headers, cache: 'no-store',
          });
          const statusData = await statusResponse.json().catch(() => ({}));
          if (!isRequestCurrent()) return;
          if (!statusResponse.ok) {
            const failure: any = new Error(statusData?.error || `تعذر استرجاع حالة الدردشة (${statusResponse.status}).`);
            failure.statusCode = statusResponse.status;
            throw failure;
          }
          transientFailures = 0;
          if (statusData.status === 'completed') {
            try {
              finalData = JSON.parse(String(statusData.result || ''));
            } catch {
              const invalidResult: any = new Error('اكتملت المهمة لكن تعذر قراءة نتيجة الدردشة المحفوظة.');
              invalidResult.terminalJobError = true;
              throw invalidResult;
            }
            break;
          }
          if (statusData.status === 'failed') {
            try { localStorage.removeItem(pendingKey); } catch {}
            const failedJob: any = new Error(String(statusData.error || 'تعذر إكمال رد الدردشة القانونية.'));
            failedJob.terminalJobError = true;
            throw failedJob;
          }
        } catch (pollError: any) {
          if (pollError?.terminalJobError || (pollError?.statusCode >= 400 && pollError.statusCode < 500 && pollError.statusCode !== 408 && pollError.statusCode !== 429)) throw pollError;
          transientFailures += 1;
          if (transientFailures >= 15) {
            throw new Error('انقطع الاتصال مؤقتًا، لكن مهمة الدردشة محفوظة على الخادم. أعد إرسال السؤال نفسه لاستعادة المهمة دون بدء إجابة جديدة.');
          }
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
      }
      if (!finalData) throw new Error('ما زالت الدردشة قيد المعالجة على الخادم. أعد إرسال السؤال نفسه لاستعادة النتيجة دون بدء مهمة جديدة.');
      if (!isRequestCurrent()) return;
      try { localStorage.removeItem(pendingKey); } catch {}
      const answer = String(finalData?.result || '').replace(/^\s*(?:reply|response|answer)\s*[:：-]?\s*(?:\r?\n)?/i, '').trim();
      if (!answer) throw new Error('لم تصل إجابة صالحة. احتفظ بسؤالك وأعد المحاولة بعد قليل.');
      const updatedResult = typeof finalData?.updatedResult === 'string' ? finalData.updatedResult.replace(/^\s*(?:reply|response|answer)\s*[:：-]?\s*(?:\r?\n)?/i, '').trim() : '';
      if (!isRequestCurrent()) return;
      if (updatedResult && updatedResult !== requestResult.trim()) onResultChange?.(updatedResult);
      setMessages((current) => [...current, { role: 'assistant', content: answer }]);
    } catch (err: any) {
      const statusCode = Number(err?.statusCode);
      const terminalFailure = err?.terminalJobError || err?.jobCreationRejected ||
        (statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429);
      if (terminalFailure && jobId) {
        try {
          const pending = JSON.parse(localStorage.getItem(pendingKey) || 'null');
          if (pending?.jobId === jobId) localStorage.removeItem(pendingKey);
        } catch {}
      }
      if (!isRequestCurrent()) return;
      // Remove the failed pending question from the transcript so it is not shown
      // as if it had been answered; restore it to the input for a deliberate retry.
      setMessages((current) => {
        const last = current[current.length - 1];
        return last?.role === 'user' && last.content === question ? current.slice(0, -1) : current;
      });
      setDraft(question);
      setError(err?.message || 'تعذر الاتصال بالمساعد القانوني. تحقق من الاتصال ثم أعد المحاولة.');
    } finally {
      if (activeRequestRef.current?.requestId === requestId) activeRequestRef.current = null;
      if (requestId === requestSequenceRef.current) setLoading(false);
    }
  };

  // Keep a callable reference to the latest handler so a saved background job
  // can resume polling after a full page refresh without creating a new job.
  sendRef.current = send;

  useEffect(() => {
    if (!result.trim() || recoveryStartedKeyRef.current === storageKey) return;
    const pendingKey = `${storageKey}_pending_job`;
    const fingerprint = (value: string) => {
      let hash = 2166136261;
      for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(36);
    };

    try {
      const pending = JSON.parse(localStorage.getItem(pendingKey) || 'null');
      if (
        !pending?.question ||
        !/^[0-9a-f-]{36}$/i.test(String(pending?.jobId || '')) ||
        pending.resultFingerprint !== fingerprint(result)
      ) return;

      recoveryStartedKeyRef.current = storageKey;
      setError('');
      void sendRef.current?.(
        { preventDefault: () => {} } as React.FormEvent,
        String(pending.question),
        true,
      );
    } catch {
      // Leave the chat usable for manual retry if saved recovery data is malformed.
    }
  }, [storageKey, result]);

  if (!result.trim()) return null;
  return <section className="mt-5 rounded-2xl border border-emerald-700/60 bg-slate-950/70 p-4 space-y-3" dir="rtl">
    <div><h3 className="font-bold text-emerald-300">مناقشة النتيجة مع أمين</h3><p className="text-xs text-slate-400 mt-1">اسأل عن أي نقطة أو اطلب تعديل النتيجة نفسها؛ عند طلب التعديل سيحدّث أمين النتيجة المعروضة والمحفوظة لتصبح هي النسخة المستخدمة في التصدير.</p></div>
    {messages.length > 0 && <div ref={messagesContainerRef} className="space-y-3 max-h-96 overflow-y-auto" aria-live="polite">
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
