import { getAdminSessionToken } from './authService.ts';

export interface BroadcastAnnouncement {
  id: string;
  isActive: boolean;
  title: string;
  message: string;
  type: 'info' | 'urgent' | 'offer' | 'welcome';
  updatedAt: string;
  actionUrl?: string;
  actionText?: string;
}

const LOCAL_STORAGE_KEY = 'judicial_admin_broadcast';

const DEFAULT_BROADCAST: BroadcastAnnouncement = {
  id: 'announcement_default',
  isActive: true,
  title: 'تحديث قضائي عام 2026',
  message: 'تم تفعيل التحديث القضائي الشامل لمحاكم النقض والاستئناف لعام 2026.',
  type: 'welcome',
  updatedAt: 'اليوم',
  actionText: 'عرض الباقات',
  actionUrl: '#packages',
};

export async function fetchCurrentBroadcast(): Promise<BroadcastAnnouncement> {
  // 1. Try server API
  try {
    const res = await fetch('/api/broadcast', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.broadcast) {
        try {
          localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(data.broadcast));
        } catch {}
        return data.broadcast;
      }
    }
  } catch (err) {
    console.warn('Broadcast fetch error:', err);
  }

  // 3. Fallback to localStorage
  try {
    const cached = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed && typeof parsed.title === 'string') {
        return parsed;
      }
    }
  } catch {}

  return DEFAULT_BROADCAST;
}

export async function updateBroadcastAnnouncement(
  data: Omit<BroadcastAnnouncement, 'id' | 'updatedAt'>
): Promise<{ success: boolean; message: string; broadcast?: BroadcastAnnouncement }> {
  // 1. Post to Server API
  try {
    const res = await fetch('/api/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Session': getAdminSessionToken() },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      const respData = await res.json();
      if (respData.success && respData.broadcast) {
        try {
          localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(respData.broadcast));
        } catch {}
        window.dispatchEvent(new CustomEvent('broadcast_updated', { detail: respData.broadcast }));
        return { success: true, message: respData.message, broadcast: respData.broadcast };
      }
    }
  } catch (err) {
    console.warn('Server broadcast update error:', err);
  }

  return { success: false, message: 'تعذر حفظ الإعلان على الخادم المركزي. تحقق من اتصال الخادم وبيانات Supabase.' };
}