import React, { useState, useEffect } from 'react';
import {
  Lock,
  Ticket,
  Sliders,
  DollarSign,
  Save,
  RotateCcw,
  Zap,
  Plus,
  Trash2,
  CheckCircle2,
  Check,
  Send,
  Eye,
  EyeOff,
  KeyRound,
  ShieldCheck,
  Cpu,
  RefreshCw,
  Users,
  UserCheck,
  BarChart3,
  Scale,
  AlertTriangle,
  CreditCard,
  Cloud,
  Database,
  Copy,
  Megaphone,
} from 'lucide-react';
import { sanitizeGeminiKey } from '../config/centralKeys.ts';
import {
  getStoredSupabaseConfig,
  saveSupabaseConfig,
  clearSupabaseConfig,
  testSupabaseConnection,
  fetchCloudGeminiKeys,
  deleteGeminiKeyFromSupabase,
  SupabaseConfig,
} from '../services/supabaseSyncService.ts';
import {
  fetchCurrentBroadcast,
  updateBroadcastAnnouncement,
} from '../services/broadcastService.ts';
import { PlatformPackage } from '../types.ts';
import {
  saveManagedPackages,
  resetPlatformPackagesToDefaults,
  fetchRemotePackages,
} from '../utils/creditsManager.ts';
import { getCurrentStoredCredits } from '../utils/deviceFingerprint.ts';
import { fetchPlatformAnalytics, PlatformAnalyticsMetrics } from '../services/analyticsService.ts';
import { getAdminSessionToken, loginAdmin } from '../services/authService.ts';

interface AdminApiModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const AdminApiModal: React.FC<AdminApiModalProps> = ({ isOpen, onClose }) => {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => {
    return sessionStorage.getItem('admin_owner_logged_in') === 'true' && !!sessionStorage.getItem('amin_admin_session');
  });
  const [passwordInput, setPasswordInput] = useState<string>('');
  const [passwordError, setPasswordError] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<'packages' | 'codes' | 'keyStatus' | 'stats' | 'supabase' | 'broadcast' | 'accounts'>('keyStatus');

  // Broadcast announcement states
  const [broadcastTitle, setBroadcastTitle] = useState<string>('تحديث قضائي عام 2026');
  const [broadcastMessage, setBroadcastMessage] = useState<string>('تم تفعيل التحديث القضائي الشامل لمحاكم النقض والاستئناف لعام 2026.');
  const [broadcastType, setBroadcastType] = useState<'info' | 'urgent' | 'offer' | 'welcome'>('welcome');
  const [broadcastIsActive, setBroadcastIsActive] = useState<boolean>(true);
  const [broadcastActionText, setBroadcastActionText] = useState<string>('عرض الباقات');
  const [broadcastActionUrl, setBroadcastActionUrl] = useState<string>('#packages');
  const [isSavingBroadcast, setIsSavingBroadcast] = useState<boolean>(false);
  const [broadcastStatusMsg, setBroadcastStatusMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const loadBroadcast = async () => {
    try {
      const data = await fetchCurrentBroadcast();
      if (data) {
        setBroadcastTitle(data.title || '');
        setBroadcastMessage(data.message || '');
        setBroadcastType(data.type || 'info');
        setBroadcastIsActive(data.isActive !== false);
        setBroadcastActionText(data.actionText || '');
        setBroadcastActionUrl(data.actionUrl || '');
      }
    } catch {}
  };

  const [keyStatusData, setKeyStatusData] = useState<{
    isConfigured: boolean;
    totalCount: number;
    activeIndex: number;
    keys: Array<{
      index: number;
      id: string;
      name: string;
      masked: string;
      prefix?: string;
      isActive: boolean;
    }>;
    rotationEnabled: boolean;
  }>({
    isConfigured: false,
    totalCount: 0,
    activeIndex: 0,
    keys: [],
    rotationEnabled: false,
  });

  const [isRefreshingStatus, setIsRefreshingStatus] = useState<boolean>(false);
  const [ocrKeyStatusData, setOcrKeyStatusData] = useState<{ totalCount: number; keys: Array<{ index: number; id: string; name: string; masked: string; prefix?: string; isActive: boolean }> }>({ totalCount: 0, keys: [] });
  const [ocrNewApiKeyInput, setOcrNewApiKeyInput] = useState<string>('');
  const [showNewOcrKey, setShowNewOcrKey] = useState<boolean>(false);
  const [ocrKeyBusy, setOcrKeyBusy] = useState<boolean>(false);
  const [ocrKeyActionMsg, setOcrKeyActionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [groqOCRFallbackStatus, setGroqOCRFallbackStatus] = useState<{ enabled: boolean; configured: boolean; maskedKey: string; model: string }>({ enabled: false, configured: false, maskedKey: '', model: 'qwen/qwen3.6-27b' });
  const [groqOCRKeyInput, setGroqOCRKeyInput] = useState<string>('');
  const [showGroqOCRKey, setShowGroqOCRKey] = useState<boolean>(false);
  const [groqOCRBusy, setGroqOCRBusy] = useState<boolean>(false);
  const [groqOCRMsg, setGroqOCRMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [newApiKeyInput, setNewApiKeyInput] = useState<string>('');
  const [showNewKey, setShowNewKey] = useState<boolean>(false);
  const [keyAddingLoading, setKeyAddingLoading] = useState<boolean>(false);
  const [keyActionMsg, setKeyActionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [aiHealthLoading, setAiHealthLoading] = useState(false);
  const [aiHealthResult, setAiHealthResult] = useState<{ ok: boolean; tested?: boolean; message: string; latencyMs?: number; checkedKeys?: number; cloudKeysReadable?: boolean; routing?: { primary?: string; fallback?: string }; providers?: { openrouter?: { configured?: boolean; ok?: boolean | null; message?: string; latencyMs?: number; model?: string }; gemini?: { configured?: boolean; ok?: boolean | null; message?: string; latencyMs?: number; keysCount?: number; keysChecked?: number; cloudKeysReadable?: boolean; model?: string } } } | null>(null);

  const [managedPackages, setManagedPackages] = useState<PlatformPackage[]>([]);
  const [packageSaveSuccess, setPackageSaveSuccess] = useState<string>('');
  const [isSavingPackages, setIsSavingPackages] = useState<boolean>(false);

  const [manualRechargeAmount, setManualRechargeAmount] = useState<string>('20');
  const [manualRechargeMsg, setManualRechargeMsg] = useState<string>('');
  const [currentBalance, setCurrentBalance] = useState<number>(0);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [balanceActionLoading, setBalanceActionLoading] = useState<boolean>(false);

  const [codeCredits, setCodeCredits] = useState<string>('20');
  const [codePackageId, setCodePackageId] = useState<string>('');
  const [generatedCode, setGeneratedCode] = useState<string>('');
  const [codeCopied, setCodeCopied] = useState<boolean>(false);
  const [codeLoading, setCodeLoading] = useState(false);

  const [analyticsData, setAnalyticsData] = useState<PlatformAnalyticsMetrics | null>(null);
  const [accountsData, setAccountsData] = useState<any[]>([]);
  const [accountSearch, setAccountSearch] = useState<string>('');
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [isAnalyticsLoading, setIsAnalyticsLoading] = useState<boolean>(false);

  const filteredAccounts = accountsData.filter((account) => {
    const q = accountSearch.trim().toLowerCase();
    if (!q) return true;
    return [account.display_name, account.username, account.id]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(q));
  });

  const loadAccounts = async () => {
    setAccountsLoading(true);
    try {
      const res = await fetch('/api/auth/accounts', { headers: { 'x-admin-session': getAdminSessionToken() } });
      const data = await res.json();
      if (res.ok) {
        const accounts = Array.isArray(data.accounts) ? data.accounts : [];
        setAccountsData(accounts);
        if (!selectedAccountId && accounts[0]?.id) setSelectedAccountId(String(accounts[0].id));
      }
    } catch {}
    finally { setAccountsLoading(false); }
  };

  const loadAnalytics = async () => {
    setIsAnalyticsLoading(true);
    try {
      const data = await fetchPlatformAnalytics();
      setAnalyticsData(data);
    } catch (e) {
      console.warn('Analytics loading error:', e);
    } finally {
      setIsAnalyticsLoading(false);
    }
  };

  // Supabase states
  const [supabaseConfig, setSupabaseConfig] = useState<SupabaseConfig>(getStoredSupabaseConfig());
  const [supabaseUrlInput, setSupabaseUrlInput] = useState<string>(supabaseConfig.url);
  const [supabaseKeyInput, setSupabaseKeyInput] = useState<string>(supabaseConfig.anonKey);
  const [supabaseTestLoading, setSupabaseTestLoading] = useState<boolean>(false);
  const [supabaseMsg, setSupabaseMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);



  const handleTestAndSaveSupabase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabaseUrlInput.trim() || !supabaseKeyInput.trim()) {
      setSupabaseMsg({ type: 'error', text: 'يرجى إدخال الرابط والمفتاح.' });
      return;
    }
    setSupabaseTestLoading(true);
    setSupabaseMsg(null);
    try {
      const testRes = await testSupabaseConnection(supabaseUrlInput, supabaseKeyInput);
      if (!testRes.success) {
        setSupabaseMsg({ type: 'error', text: testRes.message });
        return;
      }
      saveSupabaseConfig(supabaseUrlInput, supabaseKeyInput);
      setSupabaseConfig(getStoredSupabaseConfig());
      setSupabaseMsg({ type: 'success', text: testRes.message });
    } catch (err: any) {
      setSupabaseMsg({ type: 'error', text: err?.message || 'تعذر الاتصال.' });
    } finally {
      setSupabaseTestLoading(false);
    }
  };

  const handleDisconnectSupabase = () => {
    if (!confirm('هل ترغب في فصل إعداد Supabase المحلي من هذه الواجهة؟')) return;
    clearSupabaseConfig();
    setSupabaseConfig(getStoredSupabaseConfig());
    setSupabaseUrlInput('');
    setSupabaseKeyInput('');
    setSupabaseMsg({ type: 'success', text: 'تم فصل إعداد Supabase المحلي. اتصال الخادم المركزي يعتمد على متغيرات Vercel السرية.' });
  };

  const fetchKeysStatus = () => {
    setIsRefreshingStatus(true);
    fetch('/api/admin/keys-status', { headers: { 'x-admin-session': getAdminSessionToken() } })
      .then((res) => res.json())
      .then((data) => {
        const allKeys = data && Array.isArray(data.keys) ? data.keys : [];
        setKeyStatusData({
          isConfigured: allKeys.length > 0,
          totalCount: allKeys.length,
          activeIndex: Number(data?.activeIndex || 0),
          keys: allKeys,
          rotationEnabled: allKeys.length > 1,
        });
      })
      .catch(() => {
        setKeyStatusData((prev) => ({ ...prev, isConfigured: false, totalCount: 0, keys: [] }));
      })
      .finally(() => setIsRefreshingStatus(false));
  };

  const fetchOCRKeysStatus = () => {
    fetch('/api/admin/ocr-keys', { headers: { 'x-admin-session': getAdminSessionToken(), 'Cache-Control': 'no-store' }, cache: 'no-store' })
      .then((res) => res.json().then((data) => ({ res, data })))
      .then(({ res, data }) => {
        if (!res.ok || data?.ok === false) throw new Error(data?.error || 'تعذر قراءة مفاتيح OCR.');
        const keys = Array.isArray(data?.keys) ? data.keys : [];
        setOcrKeyStatusData({ keys, totalCount: keys.length });
      })
      .catch((error: any) => {
        setOcrKeyStatusData({ keys: [], totalCount: 0 });
        setOcrKeyActionMsg({ type: 'error', text: error?.message || 'تعذر قراءة مجموعة مفاتيح OCR من التخزين المركزي.' });
      });
  };

  const handleOCRKeyAction = async (action: 'add' | 'test' | 'testSaved' | 'delete', index?: number) => {
    if ((action === 'add' || action === 'test') && !ocrNewApiKeyInput.trim()) {
      setOcrKeyActionMsg({ type: 'error', text: 'أدخل مفتاح Gemini المخصص للصور والمستندات أولاً.' });
      return;
    }
    if (action === 'delete' && !confirm('هل تريد حذف هذا المفتاح من مجموعة الصور والمستندات (OCR) فقط؟')) return;
    setOcrKeyBusy(true);
    setOcrKeyActionMsg(null);
    try {
      const res = await fetch('/api/admin/ocr-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-session': getAdminSessionToken(), 'Cache-Control': 'no-store' },
        cache: 'no-store',
        body: JSON.stringify({
          action,
          ...(typeof index === 'number' ? { index } : {}),
          ...((action === 'add' || action === 'test') ? { apiKey: sanitizeGeminiKey(ocrNewApiKeyInput) } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) throw new Error(data?.error || data?.message || 'تعذر تنفيذ العملية على مجموعة OCR.');
      if (action === 'add') setOcrNewApiKeyInput('');
      if (data?.status?.keys) setOcrKeyStatusData({ keys: data.status.keys, totalCount: data.status.totalCount || data.status.keys.length });
      else fetchOCRKeysStatus();
      setOcrKeyActionMsg({
        type: 'success',
        text: data?.message || (action === 'test' || action === 'testSaved' ? 'نجح فحص مفتاح مجموعة OCR.' : action === 'delete' ? 'تم حذف المفتاح من مجموعة OCR فقط.' : 'تم حفظ مفتاح OCR.'),
      });
    } catch (error: any) {
      setOcrKeyActionMsg({ type: 'error', text: error?.message || 'تعذر تنفيذ العملية على مجموعة OCR.' });
    } finally {
      setOcrKeyBusy(false);
    }
  };

  const fetchGroqOCRFallbackStatus = () => {
    fetch('/api/admin/ocr-fallback', {
      headers: { 'x-admin-session': getAdminSessionToken(), 'Cache-Control': 'no-store' },
      cache: 'no-store',
    })
      .then((res) => res.json().then((data) => ({ res, data })))
      .then(({ res, data }) => {
        if (!res.ok || data?.ok === false) throw new Error(data?.error || 'تعذر قراءة إعداد احتياطي Groq.');
        setGroqOCRFallbackStatus({
          enabled: data.enabled === true,
          configured: data.configured === true,
          maskedKey: String(data.maskedKey || ''),
          model: String(data.model || 'qwen/qwen3.6-27b'),
        });
      })
      .catch((error: any) => {
        setGroqOCRMsg({ type: 'error', text: error?.message || 'تعذر قراءة إعداد احتياطي Groq من الخادم.' });
      });
  };

  const handleGroqOCRFallbackAction = async (action: 'test' | 'save' | 'toggle' | 'testSaved' | 'delete', enabled?: boolean) => {
    if (action === 'test' && !groqOCRKeyInput.trim() && !groqOCRFallbackStatus.configured) {
      setGroqOCRMsg({ type: 'error', text: 'أدخل مفتاح Groq أولاً.' });
      return;
    }
    if (action === 'delete' && !confirm('هل تريد حذف مفتاح Groq وإيقاف احتياطي OCR؟')) return;
    setGroqOCRBusy(true);
    setGroqOCRMsg(null);
    try {
      const res = await fetch('/api/admin/ocr-fallback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-session': getAdminSessionToken(), 'Cache-Control': 'no-store' },
        cache: 'no-store',
        body: JSON.stringify({
          action,
          ...(action === 'test' && groqOCRKeyInput.trim() ? { apiKey: groqOCRKeyInput.trim() } : {}),
          ...(action === 'save' ? { apiKey: groqOCRKeyInput.trim(), enabled: true } : {}),
          ...(action === 'toggle' ? { enabled: enabled === true } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) throw new Error(data?.error || data?.message || 'تعذر تنفيذ عملية احتياطي Groq.');
      if (action === 'save' || action === 'delete') setGroqOCRKeyInput('');
      if (data?.status) {
        setGroqOCRFallbackStatus({
          enabled: data.status.enabled === true,
          configured: data.status.configured === true,
          maskedKey: String(data.status.maskedKey || ''),
          model: String(data.status.model || 'qwen/qwen3.6-27b'),
        });
      } else if (action === 'toggle') {
        setGroqOCRFallbackStatus((prev) => ({ ...prev, enabled: enabled === true }));
      } else if (action === 'test' || action === 'testSaved') {
        // Test actions do not change the stored settings.
      } else {
        fetchGroqOCRFallbackStatus();
      }
      setGroqOCRMsg({ type: 'success', text: data?.message || (action === 'test' || action === 'testSaved' ? `نجح اختبار اتصال Groq (${data?.latencyMs || 0} مللي ثانية).` : 'تم تحديث إعداد احتياطي Groq.') });
    } catch (error: any) {
      setGroqOCRMsg({ type: 'error', text: error?.message || 'تعذر تنفيذ عملية احتياطي Groq.' });
      if (action === 'toggle') fetchGroqOCRFallbackStatus();
    } finally {
      setGroqOCRBusy(false);
    }
  };

  const handleCheckClientAiConnection = async () => {
    setAiHealthLoading(true);
    setAiHealthResult(null);
    try {
      const res = await fetch('/api/admin/ai-health', {
        method: 'POST',
        headers: { 'x-admin-session': getAdminSessionToken(), 'Cache-Control': 'no-store' },
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({}));
      setAiHealthResult({
        ok: res.ok && data?.aiReachable === true,
        message: data?.message || data?.error || 'تعذر إكمال فحص الاتصال.',
        latencyMs: data?.latencyMs,
        checkedKeys: data?.checkedKeys,
        cloudKeysReadable: data?.cloudKeysReadable,
        tested: data?.tested === true,
        providers: data?.providers,
        routing: data?.routing,
      });
    } catch (err: any) {
      setAiHealthResult({ ok: false, message: err?.message || 'تعذر الوصول إلى واجهة البرمجة من هذا المتصفح.' });
    } finally {
      setAiHealthLoading(false);
    }
  };

  // Refresh AI/key health while the admin modal is open; no background checks after close.
  useEffect(() => {
    if (!isOpen || !isAuthenticated) return;
    let cancelled = false;
    const runHealthCheck = async () => {
      if (cancelled) return;
      try {
        const res = await fetch('/api/admin/ai-health', {
          method: 'GET',
          headers: { 'x-admin-session': getAdminSessionToken(), 'Cache-Control': 'no-store' },
          cache: 'no-store',
        });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        setAiHealthResult({
          ok: res.ok && data?.aiReachable === true,
          message: data?.message || data?.error || 'تعذر إكمال فحص الاتصال.',
          latencyMs: data?.latencyMs,
          checkedKeys: data?.checkedKeys,
          cloudKeysReadable: data?.cloudKeysReadable,
          tested: data?.tested === true,
          providers: data?.providers,
          routing: data?.routing,
        });
        if (Array.isArray(data?.keyResults)) {
          setKeyActionMsg({ type: 'success', text: `آخر فحص تلقائي: ${data.keyResults.filter((x: any) => x.status === 'working').length} مفتاح يعمل، ${data.keyResults.filter((x: any) => x.status === 'quota_exhausted').length} حصة مستنفدة.` });
        }
      } catch {
        if (!cancelled) setAiHealthResult({ ok: false, message: 'تعذر الوصول إلى واجهة البرمجة (تعذر جلب البيانات). تحقق من نشر مسار الفحص والاتصال.' });
      }
    };
    // Check once when the admin panel opens; never poll in the background.
    void runHealthCheck();
    return () => { cancelled = true; };
  }, [isOpen, isAuthenticated]);

  const handleAddKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newApiKeyInput.trim()) {
      setKeyActionMsg({ type: 'error', text: 'يرجى إدخال مفتاح Gemini صالح.' });
      return;
    }
    setKeyAddingLoading(true);
    setKeyActionMsg(null);
    const cleanKey = sanitizeGeminiKey(newApiKeyInput);

    try {
      const res = await fetch('/api/admin/keys/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-session': getAdminSessionToken() },
        body: JSON.stringify({ apiKey: cleanKey }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'تعذر حفظ المفتاح على الخادم المركزي.');

      setKeyActionMsg({ type: 'success', text: 'تم اختبار المفتاح وحفظه على الخادم المركزي بنجاح.' });
      setNewApiKeyInput('');
      fetchKeysStatus();
    } catch (err: any) {
      setKeyActionMsg({ type: 'error', text: err?.message || 'تعذر حفظ المفتاح.' });
    } finally {
      setKeyAddingLoading(false);
    }
  };

  const handleTestKey = async () => {
    if (!newApiKeyInput.trim()) {
      setKeyActionMsg({ type: 'error', text: 'يرجى إدخال مفتاح Gemini أولاً.' });
      return;
    }

    setKeyAddingLoading(true);
    setKeyActionMsg(null);

    try {
      const res = await fetch('/api/admin/keys/test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-session': getAdminSessionToken(),
        },
        body: JSON.stringify({ apiKey: sanitizeGeminiKey(newApiKeyInput) }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || data?.success === false) {
        throw new Error(data?.message || data?.error || 'فشل فحص مفتاح Gemini.');
      }

      setKeyActionMsg({
        type: 'success',
        text: data?.message || 'تم فحص مفتاح Gemini بنجاح.',
      });
    } catch (err: any) {
      setKeyActionMsg({
        type: 'error',
        text: err?.message || 'تعذر فحص مفتاح Gemini.',
      });
    } finally {
      setKeyAddingLoading(false);
    }
  };

  const handleTestSavedKey = async (index: number) => {
    setKeyAddingLoading(true);
    setKeyActionMsg(null);
    try {
      const res = await fetch('/api/admin/keys/test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-session': getAdminSessionToken(),
        },
        body: JSON.stringify({ index }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.success === false) {
        throw new Error(data?.message || data?.error || 'فشل فحص المفتاح المحفوظ.');
      }
      setKeyActionMsg({
        type: 'success',
        text: data?.message || 'المفتاح المحفوظ يعمل بشكل صحيح.',
      });
    } catch (err: any) {
      setKeyActionMsg({
        type: 'error',
        text: err?.message || 'تعذر فحص المفتاح المحفوظ.',
      });
    } finally {
      setKeyAddingLoading(false);
    }
  };

  const handleDeleteKey = async (index: number) => {
    if (!confirm('هل ترغب في إزالة هذا المفتاح من حلقة التدوير؟')) return;
    try {
      const res = await fetch('/api/admin/keys/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-session': getAdminSessionToken() },
        body: JSON.stringify({ index }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || 'تعذر حذف المفتاح من التخزين الدائم.');
      fetchKeysStatus();
      setKeyActionMsg({ type: 'success', text: 'تمت إزالة المفتاح من التخزين الدائم بنجاح.' });
      setTimeout(() => setKeyActionMsg(null), 3500);
    } catch (err: any) {
      setKeyActionMsg({ type: 'error', text: err?.message || 'تعذر الحذف.' });
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchRemotePackages().then((pkgs) => {
        setManagedPackages(pkgs);
      });
      setCurrentBalance(getCurrentStoredCredits());
      fetchKeysStatus();
      fetchOCRKeysStatus();
      fetchGroqOCRFallbackStatus();
      if (isAuthenticated) {
        loadAnalytics();
        loadAccounts();
      }
    }
  }, [isOpen, isAuthenticated]);

  useEffect(() => {
    if (activeTab === 'stats' && isAuthenticated) {
      loadAnalytics();
    }
  }, [activeTab, isAuthenticated]);

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError('');
    try {
      await loginAdmin(passwordInput.trim());
      setIsAuthenticated(true);
      sessionStorage.setItem('admin_owner_logged_in', 'true');
      fetchRemotePackages().then((pkgs) => {
        setManagedPackages(pkgs);
        if (!codePackageId && pkgs[0]?.id) {
          setCodePackageId(String(pkgs[0].id));
          setCodeCredits(String(pkgs[0].credits));
        }
      });
      fetchKeysStatus();
      loadAnalytics();
      loadAccounts();
    } catch (err: any) {
      setPasswordError(err?.message || 'رمز المرور الإداري غير صحيح.');
    }
  };

  const handlePackageFieldChange = (
    index: number,
    field: keyof PlatformPackage,
    value: any
  ) => {
    const updated = [...managedPackages];
    const current = { ...updated[index] };
    if (field === 'credits') {
      const num = parseInt(value, 10);
      current.credits = isNaN(num) ? 0 : num;
    } else if (field === 'price') {
      current.price = value;
      const parsedNum = parseInt(String(value).replace(/[^0-9]/g, ''), 10);
      if (!isNaN(parsedNum)) {
        current.numericPrice = parsedNum;
      }
    } else {
      (current as any)[field] = value;
    }
    updated[index] = current;
    setManagedPackages(updated);
  };

  const handleSavePackages = async () => {
    setIsSavingPackages(true);
    setPackageSaveSuccess('');
    try {
      const saved = await saveManagedPackages(managedPackages);
      setManagedPackages(saved);
      setPackageSaveSuccess('تم حفظ وتسجيل الباقات بنجاح!');
      setTimeout(() => setPackageSaveSuccess(''), 4500);
    } catch (err: any) {
      alert('فشل الحفظ: ' + (err.message || ''));
    } finally {
      setIsSavingPackages(false);
    }
  };

  const handleResetPackages = async () => {
    if (confirm('هل ترغب في استعادة باقات المصنع الافتراضية؟')) {
      setIsSavingPackages(true);
      try {
        const defaults = await resetPlatformPackagesToDefaults();
        setManagedPackages(defaults);
        setPackageSaveSuccess('تمت استعادة الباقات الافتراضية.');
        setTimeout(() => setPackageSaveSuccess(''), 4500);
      } catch (err: any) {
        alert('فشل الاستعادة: ' + (err.message || ''));
      } finally {
        setIsSavingPackages(false);
      }
    }
  };

  const handleAddNewPackage = async () => {
    const newPkg: PlatformPackage = {
      id: `pkg_custom_${Date.now()}`,
      name: 'باقة مخصصة جديدة',
      credits: 15,
      price: '225 جنيه',
      numericPrice: 225,
      badge: 'جديد',
      description: 'باقة مخصصة للصياغة والاستشارات',
      features: [
        '15 عملية قضائية',
        'دعم ملفات وورد وبي دي إف',
        'استشارات قانونية فورية',
      ],
      enabled: true,
    };
    const updated = [...managedPackages, newPkg];
    setManagedPackages(updated);
    try {
      const saved = await saveManagedPackages(updated);
      setManagedPackages(saved);
      setPackageSaveSuccess('تمت إضافة الباقة وحفظها على الخادم المركزي.');
      setTimeout(() => setPackageSaveSuccess(''), 4500);
    } catch (err: any) {
      setManagedPackages(managedPackages);
      alert('فشل إضافة الباقة: ' + (err?.message || ''));
    }
  };

  const handleDeletePackage = async (id: string) => {
    if (confirm('هل ترغب في حذف هذه الباقة نهائياً؟')) {
      const updated = managedPackages.filter((p) => p.id !== id);
      setManagedPackages(updated);
      try {
        const saved = await saveManagedPackages(updated);
        setManagedPackages(saved);
        setPackageSaveSuccess('تم حذف الباقة وحفظ التغيير على الخادم المركزي.');
        setTimeout(() => setPackageSaveSuccess(''), 4500);
      } catch (err: any) {
        setManagedPackages(managedPackages);
        alert('فشل حذف الباقة: ' + (err?.message || ''));
      }
    }
  };

  const refreshSelectedAccountBalance = () => {
    const selected = accountsData.find((account) => String(account.id) === selectedAccountId);
    setCurrentBalance(Number(selected?.credits || 0));
  };

  useEffect(() => {
    refreshSelectedAccountBalance();
  }, [selectedAccountId, accountsData]);

  const handleDirectManualRecharge = async (requestedAmount?: number) => {
    const amount = requestedAmount ?? parseInt(manualRechargeAmount, 10);
    if (!selectedAccountId) { alert('يرجى اختيار حساب عميل أولاً.'); return; }
    if (isNaN(amount) || amount <= 0) { alert('يرجى تحديد عدد محاولات صالح.'); return; }
    setBalanceActionLoading(true);
    try {
      const res = await fetch('/api/auth/admin-balance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-session': getAdminSessionToken() },
        body: JSON.stringify({ userId: selectedAccountId, amount, mode: 'add' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'تعذر شحن الحساب.');
      setAccountsData((prev) => prev.map((account) => String(account.id) === selectedAccountId ? { ...account, credits: data.newTotal, account_status: data.accountStatus } : account));
      setCurrentBalance(Number(data.newTotal || 0));
      setManualRechargeMsg(`تمت إضافة ${amount} محاولة للحساب المحدد. الرصيد الحالي: ${data.newTotal}.`);
      setTimeout(() => setManualRechargeMsg(''), 4000);
    } catch (err: any) {
      setManualRechargeMsg(err?.message || 'تعذر شحن الحساب.');
    } finally { setBalanceActionLoading(false); }
  };

  const handleSetExactBalance = async () => {
    const amount = parseInt(manualRechargeAmount, 10);
    if (!selectedAccountId) { alert('يرجى اختيار حساب عميل أولاً.'); return; }
    if (isNaN(amount) || amount < 0) { alert('يرجى تحديد رصيد صالح.'); return; }
    setBalanceActionLoading(true);
    try {
      const res = await fetch('/api/auth/admin-balance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-session': getAdminSessionToken() },
        body: JSON.stringify({ userId: selectedAccountId, amount, mode: 'set' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'تعذر ضبط الرصيد.');
      setAccountsData((prev) => prev.map((account) => String(account.id) === selectedAccountId ? { ...account, credits: data.newTotal, account_status: data.accountStatus } : account));
      setCurrentBalance(Number(data.newTotal || 0));
      setManualRechargeMsg(`تم ضبط رصيد الحساب إلى: ${data.newTotal} محاولة.`);
      setTimeout(() => setManualRechargeMsg(''), 4000);
    } catch (err: any) {
      setManualRechargeMsg(err?.message || 'تعذر ضبط الرصيد.');
    } finally { setBalanceActionLoading(false); }
  };

  const handleDeleteAccount = async (account: any) => {
    if (!account?.id) return;
    const confirmed = confirm(`سيتم حذف حساب "${account.display_name || account.username}" نهائياً من قائمة الحسابات ومنع إعادة التسجيل من جهازه. هل أنت متأكد؟`);
    if (!confirmed) return;
    try {
      const res = await fetch('/api/auth/admin-delete-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-session': getAdminSessionToken() },
        body: JSON.stringify({ userId: account.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'تعذر حذف الحساب.');
      setAccountsData((prev) => prev.filter((item) => String(item.id) !== String(account.id)));
      if (selectedAccountId === String(account.id)) {
        setSelectedAccountId('');
        setCurrentBalance(0);
      }
      alert('تم حذف الحساب وحظر جهازه من إعادة التسجيل.');
    } catch (err: any) {
      alert(err?.message || 'تعذر حذف الحساب.');
    }
  };

  const generateActivationCode = async () => {
    const selectedPackage = managedPackages.find((pkg) => String(pkg.id) === codePackageId);
    const credits = Number(selectedPackage?.credits || codeCredits);
    if (!credits || credits <= 0) {
      alert('يرجى اختيار باقة صالحة.');
      return;
    }
    setCodeLoading(true);
    try {
      const res = await fetch('/api/auth/generate-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-session': getAdminSessionToken() },
        body: JSON.stringify({ credits, packageId: codePackageId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'تعذر إنشاء الكود.');
      setGeneratedCode(data.code);
      setCodeCopied(false);
    } catch (err: any) {
      alert('تعذر التوليد: ' + (err?.message || ''));
    } finally {
      setCodeLoading(false);
    }
  };

  const copyCode = () => {
    if (!generatedCode) return;
    navigator.clipboard.writeText(generatedCode);
    setCodeCopied(true);
    setTimeout(() => setCodeCopied(false), 2500);
  };

  const getWhatsAppMessageUrl = () => {
    if (!generatedCode) return '#';
    const text = encodeURIComponent(
      `كود شحن رصيد منصة أمين القضائية:\n\n${generatedCode}\n\nالرصيد الممنوح: ${codeCredits} محاولة صياغة واستشارة.\n\nمنصة أمين القضائية 2026`
    );
    return `https://wa.me/201009319562?text=${text}`;
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-slate-950/85 backdrop-blur-md animate-in fade-in duration-200">
      <div
        className="w-full max-w-4xl bg-[#0f172a] text-white rounded-2xl shadow-2xl border-2 border-[#b45309] overflow-hidden text-right flex flex-col max-h-[94vh] sm:max-h-[90vh]"
        style={{ fontFamily: 'Cairo, sans-serif' }}
      >
        {/* Header */}
        <div className="bg-[#090d16] text-white p-3 sm:p-5 border-b border-amber-600/40 flex items-center justify-between">
          <div className="flex items-center gap-2.5 sm:gap-3">
            <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-amber-500/20 border border-amber-400/40 flex items-center justify-center text-amber-400 flex-shrink-0">
              <Lock className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm sm:text-lg font-bold text-amber-300">
                لوحة الإدارة والتحكم المركزي
              </h2>
              <p className="text-xs text-slate-400">
                إدارة الباقات، مفاتيح الذكاء الاصطناعي، أكواد التفعيل، والإعلانات
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white text-2xl p-1.5 rounded-lg hover:bg-slate-800 transition-colors cursor-pointer"
          >
            ✕
          </button>
        </div>

        {!isAuthenticated ? (
          <div className="p-8 text-center space-y-6">
            <div className="w-16 h-16 mx-auto rounded-2xl bg-amber-500/15 border-2 border-amber-500/30 flex items-center justify-center text-amber-400 shadow-inner">
              <KeyRound className="w-8 h-8" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-white mb-1.5">
                منطقة مصرح بها فقط للمدير المسؤول
              </h3>
              <p className="text-xs text-slate-400 max-w-md mx-auto">
                يرجى إدخال رمز المرور الإداري المخصص لإدارة المنظومة.
              </p>
            </div>
            <form onSubmit={handlePasswordSubmit} className="max-w-xs mx-auto space-y-3">
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  placeholder="رمز المرور..."
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  className="w-full px-4 py-2.5 bg-[#090d16] text-white border border-slate-600 rounded-xl text-sm outline-none focus:border-[#b45309] text-center tracking-widest font-mono"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute left-3 top-3 text-slate-400 hover:text-slate-200"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {passwordError && (
                <div className="text-xs text-rose-400 font-bold bg-rose-950/60 p-2 rounded-lg border border-rose-800">
                  {passwordError}
                </div>
              )}
              <button
                type="submit"
                className="w-full py-2.5 bg-gradient-to-r from-[#b45309] to-amber-600 hover:from-amber-600 hover:to-amber-500 text-white font-bold text-sm rounded-xl shadow-lg transition-all cursor-pointer"
              >
                تأكيد الدخول
              </button>
            </form>
          </div>
        ) : (
          <>
            {/* Tabs */}
            <div className="bg-[#090d16] p-2.5 sm:p-3 border-b border-amber-900/50">
              <div className="grid grid-cols-2 sm:grid-cols-7 gap-2">
                <button
                  type="button"
                  onClick={() => setActiveTab('keyStatus')}
                  className={`flex items-center justify-center gap-1.5 sm:gap-2 px-2 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer border ${
                    activeTab === 'keyStatus'
                      ? 'bg-gradient-to-r from-amber-600 to-[#b45309] text-white border-amber-400 shadow-md shadow-amber-950/40'
                      : 'bg-slate-900/90 text-slate-300 hover:bg-slate-800 hover:text-white border-slate-700/80'
                  }`}
                >
                  <Cpu className="w-4 h-4 flex-shrink-0 text-amber-400" />
                  <span className="truncate">المفاتيح والتدوير</span>
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab('supabase')}
                  className={`flex items-center justify-center gap-1.5 sm:gap-2 px-2 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer border ${
                    activeTab === 'supabase'
                      ? 'bg-gradient-to-r from-emerald-600 to-teal-700 text-white border-emerald-400 shadow-md shadow-emerald-950/40'
                      : 'bg-slate-900/90 text-slate-300 hover:bg-slate-800 hover:text-white border-slate-700/80'
                  }`}
                >
                  <Cloud className="w-4 h-4 flex-shrink-0 text-emerald-400" />
                  <span className="truncate">مزامنة السحابة</span>
                  {supabaseConfig.isConnected && (
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab('packages')}
                  className={`flex items-center justify-center gap-1.5 sm:gap-2 px-2 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer border ${
                    activeTab === 'packages'
                      ? 'bg-gradient-to-r from-[#b45309] to-amber-600 text-white border-amber-400 shadow-md shadow-amber-950/40'
                      : 'bg-slate-900/90 text-slate-300 hover:bg-slate-800 hover:text-white border-slate-700/80'
                  }`}
                >
                  <Sliders className="w-4 h-4 flex-shrink-0 text-amber-300" />
                  <span className="truncate">إدارة الباقات</span>
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab('codes')}
                  className={`flex items-center justify-center gap-1.5 sm:gap-2 px-2 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer border ${
                    activeTab === 'codes'
                      ? 'bg-gradient-to-r from-emerald-600 to-teal-700 text-white border-emerald-400 shadow-md shadow-emerald-950/40'
                      : 'bg-slate-900/90 text-slate-300 hover:bg-slate-800 hover:text-white border-slate-700/80'
                  }`}
                >
                  <Ticket className="w-4 h-4 flex-shrink-0 text-emerald-300" />
                  <span className="truncate">أكواد التفعيل</span>
                </button>

                <button
                  type="button"
                  onClick={() => { setActiveTab('accounts'); loadAccounts(); }}
                  className={`flex items-center justify-center gap-1.5 sm:gap-2 px-2 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer border ${
                    activeTab === 'accounts'
                      ? 'bg-gradient-to-r from-cyan-600 to-blue-700 text-white border-cyan-400 shadow-md'
                      : 'bg-slate-900/90 text-slate-300 hover:bg-slate-800 hover:text-white border-slate-700/80'
                  }`}
                >
                  <Users className="w-4 h-4 flex-shrink-0 text-cyan-300" />
                  <span className="truncate">الحسابات</span>
                </button>

                <button
                  type="button"
                  onClick={() => setActiveTab('stats')}
                  className={`flex items-center justify-center gap-1.5 sm:gap-2 px-2 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer border ${
                    activeTab === 'stats'
                      ? 'bg-gradient-to-r from-blue-600 to-indigo-700 text-white border-blue-400 shadow-md shadow-blue-950/40'
                      : 'bg-slate-900/90 text-slate-300 hover:bg-slate-800 hover:text-white border-slate-700/80'
                  }`}
                >
                  <BarChart3 className="w-4 h-4 flex-shrink-0 text-sky-400" />
                  <span className="truncate">إحصائيات المنصة</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setActiveTab('broadcast');
                    loadBroadcast();
                  }}
                  className={`flex items-center justify-center gap-1.5 sm:gap-2 px-2 py-2 rounded-xl text-xs sm:text-sm font-bold transition-all cursor-pointer border ${
                    activeTab === 'broadcast'
                      ? 'bg-gradient-to-r from-rose-600 to-amber-600 text-white border-rose-400 shadow-md shadow-rose-950/40'
                      : 'bg-slate-900/90 text-slate-300 hover:bg-slate-800 hover:text-white border-slate-700/80'
                  }`}
                >
                  <Megaphone className="w-4 h-4 flex-shrink-0 text-amber-300" />
                  <span className="truncate">إعلان المنظومة</span>
                </button>
              </div>
            </div>

            {/* Content */}
            <div className="p-4 sm:p-6 overflow-y-auto space-y-5 flex-1">
              {activeTab === 'keyStatus' && (
                <div className="bg-[#1e293b] p-5 rounded-2xl border-2 border-[#b45309] space-y-4 shadow-xl">
                  <div className="border-b border-slate-700 pb-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <h4 className="text-amber-400 text-base font-bold flex items-center gap-2">
                          <Cpu className="w-5 h-5 text-amber-500" />
                          <span>تدوير المفاتيح الذكي</span>
                        </h4>
                        <span className="text-[11px] bg-emerald-950 text-emerald-300 border border-emerald-500/50 px-2.5 py-0.5 rounded-full font-bold flex items-center gap-1">
                          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping"></span>
                          إعدادات التدوير
                        </span>
                      </div>
                      <p className="text-xs text-slate-300 mt-1.5 leading-relaxed">
                        هذه المجموعة مخصصة للصياغة القانونية والتفنيد والتكييف والنزاعات والاستشارات. تدويرها منفصل تماماً، ولا تُستخدم لقراءة الصور أو ملفات PDF وWord أو الخزنة.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={fetchKeysStatus}
                      disabled={isRefreshingStatus}
                      className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-amber-300 rounded-lg text-xs font-bold border border-slate-700 flex items-center gap-1.5 cursor-pointer transition-all self-start sm:self-auto"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isRefreshingStatus ? 'animate-spin' : ''}`} />
                      <span>تحديث الحالة</span>
                    </button>
                  </div>

                  <div className="rounded-xl border border-sky-700/70 bg-slate-950 p-4 space-y-3">
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                      <div>
                        <h5 className="text-sm font-bold text-sky-300 flex items-center gap-2">
                          <Zap className="w-4 h-4" />
                          فحص وصول الذكاء الاصطناعي للعميل
                        </h5>
                        <p className="text-xs text-slate-300 mt-1 leading-relaxed">
                          فحص الإعدادات التلقائي لا يولّد نصًا. الاختبار الفعلي يرسل طلب توليد قصيرًا واحدًا إلى OpenRouter ومفتاح Gemini واحدًا فقط؛ قد يستهلك حصة بسيطة، ولا يعمل إلا عند ضغط الزر.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={handleCheckClientAiConnection}
                        disabled={aiHealthLoading}
                        className="shrink-0 px-4 py-2 rounded-lg bg-sky-700 hover:bg-sky-600 disabled:opacity-50 text-white text-xs font-bold flex items-center justify-center gap-2"
                      >
                        <RefreshCw className={`w-4 h-4 ${aiHealthLoading ? 'animate-spin' : ''}`} />
                        {aiHealthLoading ? 'جارٍ اختبار المزوّدين...' : 'اختبار فعلي للمزوّدين'}
                      </button>
                    </div>
                    {aiHealthResult && (
                      <div className={`rounded-lg border p-3 text-xs ${!aiHealthResult.tested ? 'border-slate-600 bg-slate-900/70 text-slate-200' : aiHealthResult.ok ? 'border-emerald-600 bg-emerald-950/60 text-emerald-200' : 'border-rose-600 bg-rose-950/60 text-rose-200'}`} role="status">
                        <div className="font-bold flex items-center gap-2">
                          {!aiHealthResult.tested ? <RefreshCw className="w-4 h-4" /> : aiHealthResult.ok ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
                          {aiHealthResult.tested ? (aiHealthResult.providers?.openrouter?.ok === true && aiHealthResult.providers?.gemini?.ok === true ? 'نجح التوليد من المزوّدين' : aiHealthResult.ok ? 'التوليد يعمل عبر مزوّد واحد على الأقل' : 'فشل اختبار التوليد من المزوّدين') : 'حالة الإعدادات فقط — التوليد لم يُختبر'}
                        </div>
                        <p className="mt-1 leading-relaxed">{aiHealthResult.message}</p>
                        {aiHealthResult.routing && <p className="mt-1 opacity-90">المزوّد الأساسي: {aiHealthResult.routing.primary === 'gemini' ? 'Gemini' : 'OpenRouter'} — البديل: {aiHealthResult.routing.fallback === 'gemini' ? 'Gemini' : 'OpenRouter'}</p>}
                        {aiHealthResult.providers && (
                          <div className="mt-3 grid gap-2 sm:grid-cols-2">
                            {(['openrouter', 'gemini'] as const).map((provider) => {
                              const result = aiHealthResult.providers?.[provider];
                              if (!result) return null;
                              const label = provider === 'openrouter' ? 'OpenRouter' : 'Gemini';
                              const status = result.ok === true ? 'نجح التوليد' : result.ok === false ? 'فشل التوليد' : result.configured ? 'مُعدّ — لم يُختبر' : 'غير مُعدّ';
                              return (
                                <div key={provider} className="rounded-lg border border-slate-600 bg-slate-900/70 p-2">
                                  <div className="font-bold">{label}: {status}</div>
                                  <div className="mt-1 leading-relaxed">{result.message}</div>
                                  {'keysCount' in result && typeof result.keysCount === 'number' && <div className="mt-1 opacity-80">عدد مفاتيح Gemini: {result.keysCount}</div>}
                                  {typeof result.latencyMs === 'number' && <div className="mt-1 opacity-80">زمن الاختبار: {result.latencyMs} مللي ثانية</div>}
                                </div>
                              );
                            })}
                          </div>
                        )}
                        <p className="mt-2 opacity-90">
                          {typeof aiHealthResult.latencyMs === 'number' ? `زمن الفحص: ${aiHealthResult.latencyMs} مللي ثانية` : ''}
                          {typeof aiHealthResult.checkedKeys === 'number' ? ` • المفاتيح التي تم فحصها: ${aiHealthResult.checkedKeys}` : ''}
                          {typeof aiHealthResult.cloudKeysReadable === 'boolean' ? ` • قراءة المفاتيح السحابية: ${aiHealthResult.cloudKeysReadable ? 'نجحت' : 'تعذرت'}` : ''}
                        </p>
                      </div>
                    )}
                  </div>

                  <div className="space-y-4 pt-2">
                    {keyActionMsg && (
                      <div
                        className={`p-3 rounded-xl border text-xs font-bold flex items-center justify-between gap-2 animate-in fade-in ${
                          keyActionMsg.type === 'success'
                            ? 'bg-emerald-950/90 border-emerald-500 text-emerald-200'
                            : 'bg-rose-950/90 border-rose-500 text-rose-200'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          {keyActionMsg.type === 'success' ? (
                            <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                          ) : (
                            <AlertTriangle className="w-4 h-4 text-rose-400 flex-shrink-0" />
                          )}
                          <span>{keyActionMsg.text}</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => setKeyActionMsg(null)}
                          className="text-slate-400 hover:text-white p-1 text-xs"
                        >
                          ✕
                        </button>
                      </div>
                    )}

                    <div className="bg-[#0f172a] p-4 rounded-xl border border-slate-700 space-y-3">
                      <div className="flex items-center justify-between">
                        <h5 className="text-xs font-bold text-amber-300 flex items-center gap-2">
                          <Plus className="w-4 h-4 text-amber-400" />
                          <span>إضافة مفتاح Gemini جديد:</span>
                        </h5>
                        <a
                          href="https://aistudio.google.com/app/apikey"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[11px] text-sky-400 hover:text-sky-300 underline font-semibold flex items-center gap-1"
                        >
                          <span>الحصول على مفتاح مجاني (منصة Google AI Studio)</span>
                        </a>
                      </div>
                      <div className="relative">
                        <input
                          type={showNewKey ? 'text' : 'password'}
                          value={newApiKeyInput}
                          onChange={(e) => setNewApiKeyInput(e.target.value)}
                          placeholder="ألصق مفتاح Gemini هنا (يبدأ بـ AIzaSy... أو AQ...)"
                          className="w-full p-2.5 pl-10 bg-slate-900 border border-slate-600 rounded-xl text-white font-mono text-xs focus:border-amber-500 focus:outline-none placeholder:text-slate-500"
                        />
                        <button
                          type="button"
                          onClick={() => setShowNewKey(!showNewKey)}
                          className="absolute left-3 top-2.5 text-slate-400 hover:text-white text-xs cursor-pointer"
                        >
                          {showNewKey ? 'إخفاء' : 'إظهار'}
                        </button>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <button
                          type="button"
                          onClick={handleTestKey}
                          disabled={keyAddingLoading || !newApiKeyInput.trim()}
                          className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-amber-300 border border-amber-500/40 rounded-lg text-xs font-bold shadow flex items-center gap-1.5 cursor-pointer disabled:opacity-50 transition-all"
                        >
                          {keyAddingLoading ? (
                            <>
                              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                              <span>جارٍ الفحص...</span>
                            </>
                          ) : (
                            <>
                              <ShieldCheck className="w-3.5 h-3.5" />
                              <span>فحص المفتاح فقط</span>
                            </>
                          )}
                        </button>

                        <button
                          type="button"
                          onClick={handleAddKey}
                          disabled={keyAddingLoading || !newApiKeyInput.trim()}
                          className="px-4 py-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white rounded-lg text-xs font-bold shadow flex items-center gap-1.5 cursor-pointer disabled:opacity-50 transition-all"
                        >
                          {keyAddingLoading ? (
                            <>
                              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                              <span>جارٍ الفحص والحفظ...</span>
                            </>
                          ) : (
                            <>
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              <span>فحص وحفظ وإضافة للتدوير</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>

                    <div className="space-y-2 pt-1">
                      <h5 className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                        <ShieldCheck className="w-4 h-4 text-emerald-400" />
                        <span>المفاتيح النشطة في حلقة التدوير ({keyStatusData.totalCount}):</span>
                      </h5>
                      {keyStatusData.keys && keyStatusData.keys.length > 0 ? (
                        <div className="space-y-2">
                          {keyStatusData.keys.map((k) => (
                            <div
                              key={k.id}
                              className={`p-3 rounded-xl border flex items-center justify-between text-xs transition-all ${
                                k.isActive
                                  ? 'bg-amber-950/40 border-amber-500/70 shadow-md shadow-amber-950/40'
                                  : 'bg-slate-900/80 border-slate-800'
                              }`}
                            >
                              <div className="flex items-center gap-3">
                                <span
                                  className={`w-2.5 h-2.5 rounded-full ${
                                    k.isActive ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'
                                  }`}
                                ></span>
                                <div>
                                  <div className="font-bold text-slate-200 flex items-center gap-2">
                                    <span>{k.name}</span>
                                    {k.isActive ? (
                                      <span className="text-[10px] bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-2 py-0.5 rounded-full font-bold">
                                        مفعل وجاهز للخدمة
                                      </span>
                                    ) : (
                                      <span className="text-[10px] bg-sky-500/10 text-sky-300 border border-sky-500/30 px-2 py-0.5 rounded-full font-bold">
                                        احتياطي جاهز
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                                    البادئة: <b className="text-amber-300 font-bold">{k.prefix || 'AQ'}</b> | المقنع: {k.masked}
                                  </div>
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() => handleTestSavedKey(k.index)}
                                  disabled={keyAddingLoading}
                                  className="px-2 py-1.5 rounded-lg border border-emerald-500/30 bg-emerald-950/20 text-emerald-300 hover:bg-emerald-950/50 transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-1"
                                  title="فحص هذا المفتاح المحفوظ"
                                >
                                  <ShieldCheck className="w-3.5 h-3.5" />
                                  <span>فحص</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteKey(k.index)}
                                  disabled={keyAddingLoading}
                                  className="text-rose-400 hover:text-rose-300 p-1.5 rounded hover:bg-rose-950/50 transition-colors cursor-pointer disabled:opacity-50"
                                  title="حذف هذا المفتاح"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 text-xs text-slate-300 space-y-1">
                          <div className="font-bold text-rose-300 flex items-center gap-1.5">
                            <AlertTriangle className="w-4 h-4 text-rose-400" />
                            <span>لا توجد مفاتيح مسجلة حالياً</span>
                          </div>
                          <p className="text-slate-400 text-[11px] leading-relaxed">
                            أضف هنا مفاتيح الذكاء الاصطناعي الخاصة بأدوات الصياغة والتفنيد والتكييف والنزاعات. مفاتيح الصور والمستندات لها مجموعة مستقلة أدناه.
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'keyStatus' && (
                <>
                <div className="bg-[#1e293b] p-5 rounded-2xl border-2 border-cyan-600/70 space-y-4 shadow-xl">
                  <div className="border-b border-slate-700 pb-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <h4 className="text-cyan-300 text-base font-bold flex items-center gap-2">
                        <ShieldCheck className="w-5 h-5 text-cyan-300" />
                        <span>مفاتيح الصور والمستندات والخزنة (OCR)</span>
                      </h4>
                      <p className="text-xs text-slate-300 mt-1.5 leading-relaxed">
                        مجموعة مستقلة حصرياً لاستخراج النص من الصور وملفات PDF، وأي قراءة مستند أو رفع للخزنة يحتاج OCR. تُحفظ المفاتيح على الخادم المركزي، وتُختبر وتُدوّر داخل هذه المجموعة فقط؛ لا رجوع للمفاتيح العامة.
                      </p>
                    </div>
                    <button type="button" onClick={fetchOCRKeysStatus} disabled={ocrKeyBusy} className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-cyan-200 rounded-lg text-xs font-bold border border-slate-700 flex items-center gap-1.5 disabled:opacity-50">
                      <RefreshCw className={`w-3.5 h-3.5 ${ocrKeyBusy ? 'animate-spin' : ''}`} /> تحديث الحالة
                    </button>
                  </div>

                  {ocrKeyActionMsg && (
                    <div className={`p-3 rounded-xl border text-xs font-bold flex items-start gap-2 ${ocrKeyActionMsg.type === 'success' ? 'bg-emerald-950/70 border-emerald-500 text-emerald-200' : 'bg-rose-950/70 border-rose-500 text-rose-200'}`} role="status">
                      {ocrKeyActionMsg.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
                      <span>{ocrKeyActionMsg.text}</span>
                    </div>
                  )}

                  <div className="rounded-xl border border-cyan-800/70 bg-slate-950 p-4 space-y-3">
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                      <h5 className="text-sm font-bold text-cyan-200 flex items-center gap-2"><Plus className="w-4 h-4" />إضافة مفتاح OCR جديد</h5>
                      <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" className="text-[11px] text-sky-400 hover:text-sky-300 underline">Google AI Studio</a>
                    </div>
                    <div className="relative">
                      <input type={showNewOcrKey ? 'text' : 'password'} value={ocrNewApiKeyInput} onChange={(e) => setOcrNewApiKeyInput(e.target.value)} placeholder="ألصق مفتاح Gemini المخصص للـ OCR" className="w-full p-2.5 pl-16 bg-slate-900 border border-slate-600 rounded-xl text-white font-mono text-xs focus:border-cyan-500 focus:outline-none placeholder:text-slate-500" />
                      <button type="button" onClick={() => setShowNewOcrKey(!showNewOcrKey)} className="absolute left-3 top-2.5 text-slate-400 hover:text-white text-xs">{showNewOcrKey ? 'إخفاء' : 'إظهار'}</button>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <button type="button" onClick={() => void handleOCRKeyAction('test')} disabled={ocrKeyBusy || !ocrNewApiKeyInput.trim()} className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-cyan-200 border border-cyan-700/50 rounded-lg text-xs font-bold disabled:opacity-50 flex items-center gap-1.5">
                        <ShieldCheck className="w-3.5 h-3.5" />{ocrKeyBusy ? 'جارٍ الفحص...' : 'فحص المفتاح فقط'}
                      </button>
                      <button type="button" onClick={() => void handleOCRKeyAction('add')} disabled={ocrKeyBusy || !ocrNewApiKeyInput.trim()} className="px-3 py-2 bg-gradient-to-r from-cyan-700 to-blue-700 hover:from-cyan-600 hover:to-blue-600 text-white rounded-lg text-xs font-bold disabled:opacity-50 flex items-center gap-1.5">
                        <CheckCircle2 className="w-3.5 h-3.5" />{ocrKeyBusy ? 'جارٍ الحفظ...' : 'فحص وحفظ وإضافة للتدوير'}
                      </button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <h5 className="text-xs font-bold text-slate-200 flex items-center gap-1.5"><ShieldCheck className="w-4 h-4 text-cyan-300" />مفاتيح OCR المحفوظة ({ocrKeyStatusData.totalCount})</h5>
                    {ocrKeyStatusData.keys.length ? ocrKeyStatusData.keys.map((key) => (
                      <div key={key.id} className="p-3 rounded-xl border border-slate-700 bg-slate-900/80 flex items-center justify-between gap-3 text-xs">
                        <div className="min-w-0">
                          <div className="font-bold text-slate-200">{key.name}</div>
                          <div className="text-[11px] text-slate-400 font-mono mt-1">{key.prefix || 'AQ'} • {key.masked}</div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button type="button" onClick={() => void handleOCRKeyAction('testSaved', key.index)} disabled={ocrKeyBusy} className="px-2 py-1.5 rounded-lg border border-emerald-500/30 bg-emerald-950/20 text-emerald-300 hover:bg-emerald-950/50 disabled:opacity-50 flex items-center gap-1" title="فحص مفتاح OCR المحفوظ"><ShieldCheck className="w-3.5 h-3.5" /><span>فحص</span></button>
                          <button type="button" onClick={() => void handleOCRKeyAction('delete', key.index)} disabled={ocrKeyBusy} className="text-rose-400 hover:text-rose-300 p-1.5 rounded hover:bg-rose-950/50 disabled:opacity-50" title="حذف مفتاح OCR"><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>
                      </div>
                    )) : (
                      <div className="p-4 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-300">
                        <div className="font-bold text-amber-300 flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" />لا توجد مفاتيح OCR محفوظة</div>
                        <p className="mt-1 text-slate-400 leading-relaxed">لن تبدأ معالجة الصور وملفات PDF قبل نجاح فحص الجاهزية. أضف مفاتيح في هذه المجموعة؛ المفاتيح العامة لن تُستخدم احتياطياً.</p>
                      </div>
                    )}
                  </div>
                </div>

                <div className="bg-[#1e293b] p-5 rounded-2xl border-2 border-violet-600/70 space-y-4 shadow-xl mt-4">
                  <div className="border-b border-slate-700 pb-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                    <div>
                      <h4 className="text-violet-300 text-base font-bold flex items-center gap-2"><Zap className="w-5 h-5" />احتياطي OCR باستخدام Groq Vision</h4>
                      <p className="text-xs text-slate-300 mt-1.5 leading-relaxed">عند استنفاد حصة مفاتيح Gemini، يمكن تحويل استخراج الصور تلقائياً إلى Groq. المفتاح محفوظ على الخادم في إعدادات Supabase المركزية ولا يظهر كاملاً بعد الحفظ.</p>
                    </div>
                    <span className={`text-[11px] px-2.5 py-1 rounded-full border font-bold ${groqOCRFallbackStatus.enabled && groqOCRFallbackStatus.configured ? 'bg-emerald-950 text-emerald-300 border-emerald-600/50' : 'bg-slate-900 text-slate-300 border-slate-700'}`}>
                      {groqOCRFallbackStatus.enabled && groqOCRFallbackStatus.configured ? 'الاحتياطي مفعل' : groqOCRFallbackStatus.configured ? 'المفتاح محفوظ — متوقف' : 'غير مضبوط'}
                    </span>
                  </div>

                  {groqOCRMsg && (
                    <div className={`p-3 rounded-xl border text-xs font-bold flex items-start gap-2 ${groqOCRMsg.type === 'success' ? 'bg-emerald-950/70 border-emerald-500 text-emerald-200' : 'bg-rose-950/70 border-rose-500 text-rose-200'}`} role="status">
                      {groqOCRMsg.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
                      <span>{groqOCRMsg.text}</span>
                    </div>
                  )}

                  <div className="rounded-xl border border-violet-800/70 bg-slate-950 p-4 space-y-3">
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                      <h5 className="text-sm font-bold text-violet-200 flex items-center gap-2"><KeyRound className="w-4 h-4" />مفتاح Groq الاحتياطي</h5>
                      <a href="https://console.groq.com/keys" target="_blank" rel="noopener noreferrer" className="text-[11px] text-sky-400 hover:text-sky-300 underline">إنشاء مفتاح Groq API</a>
                    </div>
                    {groqOCRFallbackStatus.configured && (
                      <div className="text-[11px] text-slate-300 font-mono">المفتاح المحفوظ: {groqOCRFallbackStatus.maskedKey} — النموذج: <span dir="ltr">{groqOCRFallbackStatus.model}</span></div>
                    )}
                    <div className="relative">
                      <input type={showGroqOCRKey ? 'text' : 'password'} value={groqOCRKeyInput} onChange={(e) => setGroqOCRKeyInput(e.target.value)} placeholder={groqOCRFallbackStatus.configured ? 'اتركه فارغاً للاحتفاظ بالمفتاح المحفوظ أو أدخل بديلاً' : 'ألصق مفتاح Groq الذي يبدأ بـ gsk_'} dir="ltr" autoComplete="off" className="w-full p-2.5 pl-16 bg-slate-900 border border-slate-600 rounded-xl text-white font-mono text-xs focus:border-violet-500 focus:outline-none placeholder:text-slate-500" />
                      <button type="button" onClick={() => setShowGroqOCRKey(!showGroqOCRKey)} className="absolute left-3 top-2.5 text-slate-400 hover:text-white text-xs">{showGroqOCRKey ? 'إخفاء' : 'إظهار'}</button>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <button type="button" onClick={() => void handleGroqOCRFallbackAction('test')} disabled={groqOCRBusy || (!groqOCRKeyInput.trim() && !groqOCRFallbackStatus.configured)} className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-violet-200 border border-violet-700/50 rounded-lg text-xs font-bold disabled:opacity-50 flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5" />{groqOCRBusy ? 'جارٍ الاختبار...' : 'اختبار المفتاح'}</button>
                      <button type="button" onClick={() => void handleGroqOCRFallbackAction('save')} disabled={groqOCRBusy || (!groqOCRKeyInput.trim() && !groqOCRFallbackStatus.configured)} className="px-3 py-2 bg-gradient-to-r from-violet-700 to-indigo-700 hover:from-violet-600 hover:to-indigo-600 text-white rounded-lg text-xs font-bold disabled:opacity-50 flex items-center gap-1.5"><Save className="w-3.5 h-3.5" />{groqOCRBusy ? 'جارٍ الحفظ...' : 'حفظ وتفعيل الاحتياطي'}</button>
                      <button type="button" onClick={() => void handleGroqOCRFallbackAction('delete')} disabled={groqOCRBusy || !groqOCRFallbackStatus.configured} className="px-3 py-2 bg-rose-950/60 hover:bg-rose-900/60 text-rose-300 border border-rose-800/60 rounded-lg text-xs font-bold disabled:opacity-50 flex items-center gap-1.5"><Trash2 className="w-3.5 h-3.5" />حذف المفتاح</button>
                    </div>
                  </div>

                  <label className="flex items-center gap-3 p-3 rounded-xl border border-slate-700 bg-slate-950 cursor-pointer">
                    <input type="checkbox" checked={groqOCRFallbackStatus.enabled} onChange={(e) => void handleGroqOCRFallbackAction('toggle', e.target.checked)} disabled={groqOCRBusy || !groqOCRFallbackStatus.configured} className="h-4 w-4 accent-violet-500" />
                    <span className="text-xs text-slate-200 font-bold">تفعيل Groq تلقائياً عند تجاوز حصة Gemini</span>
                  </label>
                  <p className="text-[11px] leading-relaxed text-amber-200/90">ملاحظة: نموذج Groq الاحتياطي المحدد للرؤية يدعم الصور. ملف PDF نفسه لا يتحول تلقائياً إلى صور بهذا المسار؛ عند نفاد Gemini قد يحتاج PDF إلى رفع صفحاته كصور. يظل رصيد المستخدم والتحقق من تسجيل الدخول معمولاً بهما.</p>
                </div>
                </>
              )}

              {activeTab === 'supabase' && (
                <div className="space-y-5">
                  <div className="bg-[#1e293b] p-5 rounded-2xl border-2 border-emerald-500/50 space-y-4 shadow-xl">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-700 pb-3">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <h4 className="text-emerald-400 text-base font-bold flex items-center gap-2">
                            <Cloud className="w-5 h-5 text-emerald-400" />
                            <span>مزامنة قاعدة البيانات السحابية (Supabase)</span>
                          </h4>
                          {supabaseConfig.isConnected ? (
                            <span className="text-[11px] bg-emerald-950 text-emerald-300 border border-emerald-500/50 px-2.5 py-0.5 rounded-full font-bold flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                              متصل بالسحابة
                            </span>
                          ) : (
                            <span className="text-[11px] bg-slate-900 text-slate-400 border border-slate-700 px-2.5 py-0.5 rounded-full font-bold flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-full bg-slate-500"></span>
                              غير متصل
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-slate-300 mt-1.5 leading-relaxed">
                          مزامنة مفاتيح Gemini والإعلانات وآراء المحامين تلقائياً.
                        </p>
                      </div>
                      {supabaseConfig.isConnected && (
                        <button
                          type="button"
                          onClick={handleDisconnectSupabase}
                          className="px-3 py-1.5 bg-rose-950/70 hover:bg-rose-900 text-rose-300 rounded-lg text-xs font-bold border border-rose-700/60 flex items-center gap-1.5 cursor-pointer transition-all self-start sm:self-auto"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>فصل الاتصال</span>
                        </button>
                      )}
                    </div>

                    <form onSubmit={handleTestAndSaveSupabase} className="space-y-3">
                      <div>
                        <label className="block text-xs font-bold text-slate-200 mb-1">
                          رابط المشروع (Supabase Project URL):
                        </label>
                        <input
                          type="text"
                          dir="ltr"
                          placeholder="https://xxxxxxxxxxxxxxxxxxxx.supabase.co"
                          value={supabaseUrlInput}
                          onChange={(e) => setSupabaseUrlInput(e.target.value)}
                          className="w-full px-3.5 py-2.5 bg-slate-900 text-emerald-300 border border-slate-700 rounded-xl text-xs font-mono outline-none focus:border-emerald-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-slate-200 mb-1">
                          المفتاح العام (Supabase Anon Public Key):
                        </label>
                        <input
                          type="password"
                          dir="ltr"
                          placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
                          value={supabaseKeyInput}
                          onChange={(e) => setSupabaseKeyInput(e.target.value)}
                          className="w-full px-3.5 py-2.5 bg-slate-900 text-emerald-300 border border-slate-700 rounded-xl text-xs font-mono outline-none focus:border-emerald-500"
                        />
                      </div>
                      {supabaseMsg && (
                        <div
                          className={`p-3 rounded-xl border text-xs leading-relaxed flex items-start gap-2 ${
                            supabaseMsg.type === 'success'
                              ? 'bg-emerald-950/70 border-emerald-500/80 text-emerald-200'
                              : 'bg-rose-950/70 border-rose-500/80 text-rose-200'
                          }`}
                        >
                          {supabaseMsg.type === 'success' ? (
                            <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0 mt-0.5" />
                          ) : (
                            <AlertTriangle className="w-4 h-4 text-rose-400 flex-shrink-0 mt-0.5" />
                          )}
                          <span className="flex-1">{supabaseMsg.text}</span>
                        </div>
                      )}
                      <div className="flex items-center gap-2 pt-1">
                        <button
                          type="submit"
                          disabled={supabaseTestLoading}
                          className="px-5 py-2.5 bg-gradient-to-r from-emerald-600 to-teal-700 hover:from-emerald-500 hover:to-teal-600 text-white font-bold text-xs rounded-xl shadow-lg transition-all flex items-center gap-2 cursor-pointer disabled:opacity-60"
                        >
                          <Save className={`w-4 h-4 ${supabaseTestLoading ? 'animate-spin' : ''}`} />
                          <span>{supabaseTestLoading ? 'جارٍ الاتصال...' : 'حفظ واختبار الاتصال'}</span>
                        </button>
                      </div>
                    </form>
                  </div>
                </div>
              )}

              {activeTab === 'packages' && (
                <div className="space-y-5">
                  <div className="bg-[#1e293b] p-4 rounded-xl border border-amber-500/40 space-y-3 shadow-md">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-700 pb-2">
                      <div className="flex items-center gap-2">
                        <Zap className="w-4 h-4 text-amber-400" />
                        <h4 className="text-sm font-bold text-amber-300">
                          إدارة رصيد حساب العميل المحدد
                        </h4>
                      </div>
                      <div className="text-xs text-slate-300">
                        الرصيد الفعلي الآن:{' '}
                        <b className="text-emerald-400 font-mono text-sm">{currentBalance} محاولة</b>
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <input
                        type="search"
                        value={accountSearch}
                        onChange={(e) => setAccountSearch(e.target.value)}
                        placeholder="ابحث بالاسم أو اسم المستخدم..."
                        className="min-w-[220px] px-2.5 py-1.5 bg-slate-900 border border-slate-600 rounded text-xs text-white outline-none focus:border-amber-400"
                      />
                      <select
                        value={selectedAccountId}
                        onChange={(e) => setSelectedAccountId(e.target.value)}
                        className="min-w-[190px] px-2.5 py-1.5 bg-slate-900 border border-slate-600 rounded text-xs text-white outline-none"
                        disabled={balanceActionLoading}
                      >
                        <option value="">اختر حساب العميل</option>
                        {filteredAccounts.map((account) => (
                          <option key={account.id} value={account.id}>{account.display_name} — {account.username}</option>
                        ))}
                      </select>
                      <span className="text-slate-300 font-bold">شحن سريع:</span>
                      {[10, 25, 50, 100].map((qty) => (
                        <button
                          key={qty}
                          type="button"
                          onClick={() => { setManualRechargeAmount(String(qty)); void handleDirectManualRecharge(qty); }}
                          disabled={balanceActionLoading}
                          className="px-2.5 py-1 bg-slate-800 hover:bg-[#b45309] text-amber-200 hover:text-white rounded border border-slate-700 font-mono font-bold transition-all cursor-pointer"
                        >
                          +{qty}
                        </button>
                      ))}
                      <div className="flex items-center gap-1.5 mr-auto">
                        <input
                          type="number"
                          value={manualRechargeAmount}
                          onChange={(e) => setManualRechargeAmount(e.target.value)}
                          className="w-20 px-2 py-1 bg-slate-900 border border-slate-600 rounded text-center text-xs font-mono text-white"
                          placeholder="العدد"
                        />
                        <button
                          type="button"
                          onClick={() => void handleDirectManualRecharge()}
                          disabled={balanceActionLoading}
                          className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded font-bold text-xs cursor-pointer shadow"
                        >
                          شحن
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleSetExactBalance()}
                          disabled={balanceActionLoading}
                          className="px-3 py-1 bg-sky-700 hover:bg-sky-600 text-white rounded font-bold text-xs cursor-pointer shadow disabled:opacity-50"
                        >
                          ضبط الرصيد
                        </button>
                      </div>
                    </div>
                    {manualRechargeMsg && (
                      <div className="p-2 bg-emerald-950/80 border border-emerald-500/50 rounded text-xs text-emerald-200 font-bold flex items-center gap-1.5 animate-in fade-in">
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                        <span>{manualRechargeMsg}</span>
                      </div>
                    )}
                  </div>

                  <div className="space-y-4">
                    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                      <div>
                        <h4 className="text-sm font-bold text-white flex items-center gap-2">
                          <DollarSign className="w-4 h-4 text-amber-400" />
                          <span>باقات الاشتراك المعروضة للجمهور:</span>
                        </h4>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={handleAddNewPackage}
                          className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-amber-300 rounded-lg text-xs font-bold border border-slate-700 transition-colors flex items-center gap-1 cursor-pointer"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          <span>إضافة باقة</span>
                        </button>
                        <button
                          type="button"
                          onClick={handleResetPackages}
                          className="px-3 py-1.5 bg-slate-800 hover:bg-rose-950 text-slate-400 hover:text-rose-300 rounded-lg text-xs font-semibold border border-slate-700 transition-colors flex items-center gap-1 cursor-pointer"
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                          <span>استعادة الافتراضي</span>
                        </button>
                      </div>
                    </div>

                    {packageSaveSuccess && (
                      <div className="p-3 bg-emerald-950/90 border border-emerald-500 rounded-xl text-xs text-emerald-200 font-bold flex items-center gap-2 animate-in fade-in">
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                        <span>{packageSaveSuccess}</span>
                      </div>
                    )}

                    <div className="space-y-3.5">
                      {managedPackages.map((pkg, idx) => (
                        <div
                          key={pkg.id}
                          className="bg-[#1e293b] border-2 border-slate-700/80 hover:border-amber-500/50 rounded-xl p-4 space-y-3 shadow-md transition-all"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-700 pb-2.5">
                            <div className="flex items-center gap-2">
                              <span className="w-2.5 h-2.5 rounded-full bg-amber-400"></span>
                              <span className="text-xs font-bold text-amber-300">
                                باقة #{idx + 1}
                              </span>
                            </div>
                            <button
                              type="button"
                              onClick={() => handleDeletePackage(pkg.id)}
                              className="text-rose-400 hover:text-rose-300 p-1 text-xs cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                            <div>
                              <label className="block text-[11px] font-bold text-slate-300 mb-1">
                                اسم الباقة:
                              </label>
                              <input
                                type="text"
                                value={pkg.name}
                                onChange={(e) =>
                                  handlePackageFieldChange(idx, 'name', e.target.value)
                                }
                                className="w-full p-2 bg-[#090d16] border border-slate-600 rounded-lg text-white font-bold outline-none focus:border-[#b45309]"
                              />
                            </div>
                            <div>
                              <label className="block text-[11px] font-bold text-slate-300 mb-1">
                                السعر:
                              </label>
                              <input
                                type="text"
                                value={pkg.price}
                                onChange={(e) =>
                                  handlePackageFieldChange(idx, 'price', e.target.value)
                                }
                                className="w-full p-2 bg-[#090d16] border border-slate-600 rounded-lg text-amber-300 font-mono font-bold outline-none focus:border-[#b45309]"
                              />
                            </div>
                            <div>
                              <label className="block text-[11px] font-bold text-slate-300 mb-1">
                                عدد العمليات:
                              </label>
                              <input
                                type="number"
                                value={pkg.credits}
                                onChange={(e) =>
                                  handlePackageFieldChange(
                                    idx,
                                    'credits',
                                    parseInt(e.target.value, 10) || 0
                                  )
                                }
                                className="w-full p-2 bg-[#090d16] border border-slate-600 rounded-lg text-emerald-400 font-mono font-bold outline-none focus:border-[#b45309]"
                              />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>

                    <button
                      type="button"
                      onClick={handleSavePackages}
                      disabled={isSavingPackages}
                      className="w-full py-3.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white rounded-xl font-bold text-sm shadow-lg flex items-center justify-center gap-2 cursor-pointer transition-all disabled:opacity-50"
                    >
                      <Save className="w-4 h-4" />
                      <span>{isSavingPackages ? 'جارٍ الحفظ...' : 'حفظ وتحديث باقات المنظومة'}</span>
                    </button>
                  </div>
                </div>
              )}

              {activeTab === 'codes' && (
                <div className="bg-[#0f172a] p-5 rounded-xl border border-slate-700 space-y-4">
                  <div className="border-b border-slate-700 pb-3">
                    <h4 className="text-amber-400 text-sm font-bold flex items-center gap-2">
                      <Ticket className="w-4 h-4 text-amber-500" />
                      <span>توليد أكواد شحن الرصيد الفورية:</span>
                    </h4>
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-bold text-slate-300">
                      اختر الباقة التي سيحملها كارت الشحن:
                    </label>
                    <select
                      value={codePackageId}
                      onChange={(e) => {
                        const id = e.target.value;
                        setCodePackageId(id);
                        const pkg = managedPackages.find((item) => String(item.id) === id);
                        if (pkg) setCodeCredits(String(pkg.credits));
                      }}
                      className="w-full p-2.5 bg-slate-900 border border-slate-600 rounded-lg text-white text-xs font-bold outline-none focus:border-emerald-500"
                    >
                      <option value="">اختر الباقة</option>
                      {managedPackages.filter((pkg) => pkg.enabled !== false).map((pkg) => (
                        <option key={pkg.id} value={pkg.id}>{pkg.name} — {pkg.credits} عملية</option>
                      ))}
                    </select>
                  </div>

                  <button
                    onClick={generateActivationCode}
                    disabled={codeLoading}
                    className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold transition-all disabled:opacity-50 cursor-pointer shadow-md flex items-center justify-center gap-1.5"
                  >
                    <Ticket className="w-4 h-4" />
                    <span>{codeLoading ? 'جارٍ التوليد...' : 'توليد الكود فوراً'}</span>
                  </button>
                  {generatedCode && (
                    <div className="p-4 bg-slate-900 border-2 border-emerald-500/50 rounded-xl space-y-3 text-center animate-in fade-in">
                      <span className="text-xs text-slate-300 font-semibold">
                        كارت شحن الباقة ({codeCredits} عملية):
                      </span>
                      <div className="text-emerald-400 font-mono text-xl font-extrabold tracking-widest bg-slate-950 p-2.5 rounded-lg border border-slate-800 select-all">
                        {generatedCode}
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                        <button
                          onClick={copyCode}
                          className="w-full py-2 bg-slate-800 hover:bg-slate-700 text-amber-300 rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer border border-amber-500/30"
                        >
                          {codeCopied ? <Check className="w-3.5 h-3.5" /> : null}
                          <span>{codeCopied ? 'تم النسخ!' : 'نسخ الكود'}</span>
                        </button>
                        <a
                          href={getWhatsAppMessageUrl()}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="w-full py-2 bg-emerald-700 hover:bg-emerald-600 text-white rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                        >
                          <Send className="w-3.5 h-3.5" />
                          <span>إرسال بالواتساب للمشتري</span>
                        </a>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'accounts' && (
                <div className="space-y-4">
                  <div className="bg-[#1e293b] p-5 rounded-2xl border-2 border-cyan-500/40">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
                      <h4 className="text-cyan-300 font-bold flex items-center gap-2"><Users className="w-5 h-5" /> حسابات العملاء المحامين</h4>
                      <div className="flex items-center gap-2">
                        <input
                          type="search"
                          value={accountSearch}
                          onChange={(e) => setAccountSearch(e.target.value)}
                          placeholder="بحث بالاسم أو المستخدم..."
                          className="w-full sm:w-56 px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-xs text-white outline-none focus:border-cyan-400"
                        />
                        <button type="button" onClick={loadAccounts} className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs font-bold">تحديث</button>
                      </div>
                    </div>
                    {accountsLoading ? <div className="text-sm text-slate-300">جارٍ تحميل الحسابات...</div> : accountsData.length === 0 ? <div className="text-sm text-slate-400">لا توجد حسابات مسجلة حتى الآن.</div> : (
                      <div className="space-y-2">
                        {filteredAccounts.map((account) => (
                          <div key={account.id} className="p-3 rounded-xl bg-slate-900 border border-slate-700 grid grid-cols-1 sm:grid-cols-4 gap-2 text-xs">
                            <div><span className="text-slate-500">الاسم:</span> <b className="text-white">{account.display_name}</b></div>
                            <div><span className="text-slate-500">المستخدم:</span> <b className="text-amber-300 font-mono">{account.username}</b></div>
                            <div><span className="text-slate-500">الرصيد:</span> <b className="text-emerald-300">{account.credits} عملية</b></div>
                            <div><span className="text-slate-500">الحالة:</span> <b className={account.account_status === 'active' ? 'text-emerald-300' : 'text-rose-300'}>{account.account_status === 'active' ? 'نشط' : 'متوقف'}</b></div>
                            <div className="sm:col-span-4 flex justify-end pt-1">
                              <button
                                type="button"
                                onClick={() => void handleDeleteAccount(account)}
                                className="px-3 py-1.5 rounded-lg bg-rose-950/70 hover:bg-rose-900 text-rose-300 border border-rose-700/60 text-xs font-bold"
                              >
                                حذف الحساب وحظر الجهاز
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {activeTab === 'stats' && (
                <div className="space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 bg-[#090d16] p-3.5 rounded-xl border border-slate-700/80">
                    <div className="flex items-center gap-2.5">
                      <div className="relative flex h-3 w-3">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
                      </div>
                      <div>
                        <h4 className="text-white text-sm font-bold flex items-center gap-1.5">
                          <BarChart3 className="w-4 h-4 text-sky-400" />
                          <span>لوحة قياس الاستخدام الحية</span>
                        </h4>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={loadAnalytics}
                      disabled={isAnalyticsLoading}
                      className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer border border-slate-600"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 text-sky-400 ${isAnalyticsLoading ? 'animate-spin' : ''}`} />
                      <span>تحديث</span>
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                    <div className="bg-[#1e293b] p-4 rounded-xl border-2 border-emerald-500/60 shadow-lg flex flex-col justify-between">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs text-emerald-300 font-bold">نشطون الآن:</span>
                        <Users className="w-4 h-4 text-emerald-400" />
                      </div>
                      <div className="text-3xl font-extrabold text-emerald-400 font-mono">
                        {analyticsData?.activeNow ?? 0}
                      </div>
                    </div>

                    <div className="bg-[#1e293b] p-4 rounded-xl border border-sky-500/50 shadow-md flex flex-col justify-between">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs text-sky-300 font-bold">إجمالي المستخدمين:</span>
                        <UserCheck className="w-4 h-4 text-sky-400" />
                      </div>
                      <div className="text-3xl font-extrabold text-sky-400 font-mono">
                        {analyticsData?.totalRegistered ?? 0}
                      </div>
                    </div>

                    <div className="bg-[#1e293b] p-4 rounded-xl border border-amber-500/50 shadow-md flex flex-col justify-between">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs text-amber-300 font-bold">العمليات القضائية:</span>
                        <Scale className="w-4 h-4 text-amber-400" />
                      </div>
                      <div className="text-3xl font-extrabold text-amber-400 font-mono">
                        {analyticsData?.totalOperations ?? 0}
                      </div>
                    </div>

                    <div className="bg-[#1e293b] p-4 rounded-xl border border-purple-500/50 shadow-md flex flex-col justify-between">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs text-purple-300 font-bold">الاشتراكات:</span>
                        <CreditCard className="w-4 h-4 text-purple-400" />
                      </div>
                      <div className="text-3xl font-extrabold text-purple-400 font-mono">
                        {analyticsData?.totalSubscribed ?? 0}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'broadcast' && (
                <div className="bg-[#1e293b] p-5 rounded-2xl border border-slate-700 space-y-4 shadow-xl">
                  <div className="flex items-center justify-between pb-3 border-b border-slate-700">
                    <span className="text-xs font-bold text-slate-200">إعلان الشريط العلوي العام</span>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={broadcastIsActive}
                        onChange={(e) => setBroadcastIsActive(e.target.value === 'true' || e.target.checked)}
                        className="w-4 h-4 accent-amber-500 cursor-pointer"
                      />
                      <span className="text-xs font-bold text-amber-300">مفعل وظاهر للجميع</span>
                    </label>
                  </div>
                  <div>
                    <label className="block text-xs font-bold mb-1 text-slate-300">عنوان الإعلان:</label>
                    <input
                      type="text"
                      value={broadcastTitle}
                      onChange={(e) => setBroadcastTitle(e.target.value)}
                      className="w-full px-3.5 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-white text-xs font-semibold outline-none focus:border-amber-400"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold mb-1 text-slate-300">نص الرسالة:</label>
                    <textarea
                      rows={3}
                      value={broadcastMessage}
                      onChange={(e) => setBroadcastMessage(e.target.value)}
                      className="w-full p-3.5 rounded-xl bg-slate-900 border border-slate-700 text-white text-xs leading-relaxed outline-none focus:border-amber-400"
                    />
                  </div>
                  {broadcastStatusMsg && (
                    <div
                      className={`p-3 rounded-xl text-xs font-bold flex items-center gap-2 ${
                        broadcastStatusMsg.type === 'success'
                          ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-500/50'
                          : 'bg-rose-950/80 text-rose-300 border border-rose-500/50'
                      }`}
                    >
                      <span>{broadcastStatusMsg.text}</span>
                    </div>
                  )}
                  <div className="flex items-center justify-end pt-2">
                    <button
                      type="button"
                      disabled={isSavingBroadcast}
                      onClick={async () => {
                        setIsSavingBroadcast(true);
                        const res = await updateBroadcastAnnouncement({
                          isActive: broadcastIsActive,
                          title: broadcastTitle.trim(),
                          message: broadcastMessage.trim(),
                          type: broadcastType,
                          actionText: broadcastActionText.trim(),
                          actionUrl: broadcastActionUrl.trim(),
                        });
                        setIsSavingBroadcast(false);
                        if (res.success) {
                          setBroadcastStatusMsg({ type: 'success', text: res.message });
                          setTimeout(() => setBroadcastStatusMsg(null), 4000);
                        } else {
                          setBroadcastStatusMsg({ type: 'error', text: res.message });
                        }
                      }}
                      className="px-6 py-2.5 bg-gradient-to-r from-amber-600 to-amber-700 hover:from-amber-700 hover:to-amber-800 text-white font-bold text-xs sm:text-sm rounded-xl shadow-lg transition-all flex items-center gap-2 cursor-pointer disabled:opacity-50"
                    >
                      <Save className="w-4 h-4" />
                      <span>{isSavingBroadcast ? 'جارٍ الحفظ...' : 'حفظ ونشر الإعلان فوراً'}</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        <div className="bg-[#090d16] p-4 border-t border-slate-700 flex justify-between items-center">
          {isAuthenticated && (
            <button
              onClick={() => {
                setIsAuthenticated(false);
                sessionStorage.removeItem('admin_owner_logged_in');
                sessionStorage.removeItem('amin_admin_session');
              }}
              className="text-xs text-rose-400 hover:text-rose-300 font-semibold cursor-pointer"
            >
              تسجيل الخروج
            </button>
          )}
          <button
            onClick={onClose}
            className="px-5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-bold transition-colors cursor-pointer mr-auto"
          >
            إغلاق
          </button>
        </div>
      </div>
    </div>
  );
};
