import React, { useEffect, useState } from 'react';
import { LogIn, UserPlus, ShieldCheck } from 'lucide-react';
import { getDeviceFingerprint } from '../utils/deviceFingerprint.ts';
import { getSessionToken, clearSession, loginAccount, registerAccount, PlatformUser } from '../services/authService.ts';

interface Props { onAuthenticated: (user: PlatformUser) => void; }

export const AuthGate: React.FC<Props> = ({ onAuthenticated }) => {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [checkingSession, setCheckingSession] = useState(() => !!getSessionToken());
  const [sessionCheckError, setSessionCheckError] = useState('');

  useEffect(() => {
    if (!getSessionToken()) {
      setCheckingSession(false);
      return;
    }

    let cancelled = false;
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const checkSession = async () => {
      try {
        const { getCurrentAccount } = await import('../services/authService.ts');
        const user = await getCurrentAccount();
        if (!cancelled) {
          setSessionCheckError('');
          setCheckingSession(false);
          onAuthenticated(user);
        }
      } catch (e: any) {
        if (cancelled) return;

        const status = Number(e?.statusCode || 0);
        if (status === 401 || status === 403 || status === 404) {
          clearSession();
          setCheckingSession(false);
          return;
        }

        // A saved token is only a short-lived active session. If the server
        // cannot validate it after the retry window, require a fresh login.
        attempts += 1;
        if (attempts < 4) {
          retryTimer = setTimeout(checkSession, 1200 * attempts);
        } else {
          clearSession();
          setSessionCheckError('انتهت جلسة الحساب. يرجى تسجيل الدخول من جديد.');
          setCheckingSession(false);
        }
      }
    };

    void checkSession();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [onAuthenticated]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const device = await getDeviceFingerprint();
      const user = mode === 'register'
        ? await registerAccount(username, password, displayName, device)
        : await loginAccount(username, password, device);
      onAuthenticated(user);
    } catch (e: any) {
      setError(e?.message || 'تعذر تنفيذ العملية.');
    } finally {
      setLoading(false);
    }
  };

  if (checkingSession) {
    return (
      <div className="min-h-screen min-h-[100dvh] bg-[#090d16] text-white flex items-center justify-center p-4" dir="rtl">
        <div className="w-full max-w-md bg-[#0f172a] border-2 border-[#b45309] rounded-3xl p-6 sm:p-8 shadow-2xl text-center">
          <ShieldCheck className="w-9 h-9 mx-auto text-amber-400 mb-3" />
          <p className="font-black text-amber-300">جارٍ التحقق من جلسة الحساب...</p>
          <p className="text-sm text-slate-300 mt-2">جارٍ التأكد من صلاحية جلسة الدخول الحالية.</p>
        </div>
      </div>
    );
  }


  return (
    <div className="min-h-screen min-h-[100dvh] bg-[#090d16] text-white flex items-center justify-center p-4" dir="rtl">
      <form onSubmit={submit} className="w-full max-w-md bg-[#0f172a] border-2 border-[#b45309] rounded-3xl p-6 sm:p-8 shadow-2xl space-y-5">
        <div className="text-center">
          <div className="mx-auto w-14 h-14 rounded-2xl bg-amber-500/15 border border-amber-500/40 flex items-center justify-center text-amber-400 mb-3">
            <ShieldCheck className="w-7 h-7" />
          </div>
          <h1 className="text-xl font-black text-amber-300">المستشار أمين</h1>
          <p className="text-sm text-slate-300 mt-1">دخول موحد لحساب المحامي</p>
        </div>

        {mode === 'register' && (
          <input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="الاسم الظاهر" className="w-full bg-[#090d16] border border-slate-600 rounded-xl px-4 py-3 text-white outline-none focus:border-amber-400" />
        )}
        <input value={username} onChange={e => setUsername(e.target.value)} placeholder="اسم المستخدم" autoComplete="username" className="w-full bg-[#090d16] border border-slate-600 rounded-xl px-4 py-3 text-white outline-none focus:border-amber-400" />
        <input value={password} onChange={e => setPassword(e.target.value)} placeholder="كلمة المرور (8 أحرف على الأقل)" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} className="w-full bg-[#090d16] border border-slate-600 rounded-xl px-4 py-3 text-white outline-none focus:border-amber-400" />

        {mode === 'register' && (
          <div className="text-xs text-amber-200 bg-amber-950/30 border border-amber-500/30 rounded-xl p-3 leading-relaxed">
            الحساب الجديد يحصل على 20 عملية قضائية خلال 14 يوماً. ينتهي الاستخدام عند استهلاك العمليات أو انتهاء الـ14 يوماً، أيهما أقرب، ثم يلزم الشحن.
          </div>
        )}
        {(error || sessionCheckError) && <div className="text-sm text-rose-200 bg-rose-950/50 border border-rose-500/50 rounded-xl p-3">{error || sessionCheckError}</div>}

        <button disabled={loading} className="w-full py-3 rounded-xl bg-amber-600 hover:bg-amber-500 disabled:opacity-50 font-black flex items-center justify-center gap-2">
          {mode === 'login' ? <LogIn className="w-5 h-5" /> : <UserPlus className="w-5 h-5" />}
          {loading ? 'جارٍ التنفيذ...' : mode === 'login' ? 'تسجيل الدخول' : 'إنشاء الحساب'}
        </button>

        <button type="button" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }} className="w-full text-sm text-amber-300 hover:text-amber-200">
          {mode === 'login' ? 'إنشاء حساب جديد' : 'لدي حساب بالفعل'}
        </button>
      </form>
    </div>
  );
};
