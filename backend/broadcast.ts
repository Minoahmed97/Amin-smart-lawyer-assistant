import fs from 'fs';
import path from 'path';
import { requireAdmin } from './auth.ts';

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

const BROADCAST_FILE = path.join(process.cwd(), '.broadcast_data.json');
const DEFAULT_BROADCAST: BroadcastAnnouncement = {
  id: 'announcement_default',
  isActive: true,
  title: 'تحديث قضائي عام 2026',
  message: 'تم تفعيل التحديث القضائي الشامل لمحاكم النقض والاستئناف لعام 2026.',
  type: 'welcome',
  updatedAt: new Date().toLocaleDateString('ar-EG'),
  actionText: 'عرض الباقات',
  actionUrl: '#packages',
};

let inMemoryBroadcast: BroadcastAnnouncement = { ...DEFAULT_BROADCAST };

export function getLocalBroadcast(): BroadcastAnnouncement {
  try {
    if (fs.existsSync(BROADCAST_FILE)) {
      const data = fs.readFileSync(BROADCAST_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed.title === 'string') {
        return parsed;
      }
    }
  } catch (e) {
    // fallback
  }
  return inMemoryBroadcast;
}

export function saveLocalBroadcast(announcement: BroadcastAnnouncement): void {
  inMemoryBroadcast = announcement;
  try {
    fs.writeFileSync(BROADCAST_FILE, JSON.stringify(announcement, null, 2), 'utf-8');
  } catch (e) {
    // ignore on readonly
  }
}

export async function fetchSupabaseBroadcast(): Promise<BroadcastAnnouncement | null> {
  const supabaseUrl = (process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
  const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim();

  if (!supabaseUrl || !supabaseKey) return null;

  try {
    const endpoint = `${supabaseUrl}/rest/v1/app_broadcast_announcements?select=*&order=updated_at.desc&limit=1`;
    const res = await fetch(endpoint, {
      method: 'GET',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
    });
    if (res.ok) {
      const records = (await res.json()) as any[];
      if (Array.isArray(records) && records.length > 0) {
        const r = records[0];
        return {
          id: r.id ? String(r.id) : 'sb_broadcast',
          isActive: r.is_active !== false,
          title: r.title || 'إشعار المنظومة القضائية',
          message: r.message || '',
          type: r.type || 'info',
          updatedAt: r.updated_at ? new Date(r.updated_at).toLocaleDateString('ar-EG') : 'اليوم',
          actionText: r.action_text || '',
          actionUrl: r.action_url || '',
        };
      }
    }
  } catch (err) {
    console.warn('Supabase broadcast fetch error:', err);
  }
  return null;
}

export async function saveSupabaseBroadcast(announcement: BroadcastAnnouncement): Promise<boolean> {
  const supabaseUrl = (process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
  const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim();

  if (!supabaseUrl || !supabaseKey) return false;

  try {
    const endpoint = `${supabaseUrl}/rest/v1/app_broadcast_announcements`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({
        id: 'global_admin_broadcast',
        is_active: announcement.isActive,
        title: announcement.title,
        message: announcement.message,
        type: announcement.type,
        action_text: announcement.actionText,
        action_url: announcement.actionUrl,
        updated_at: new Date().toISOString(),
      }),
    });
    return res.ok || res.status === 201;
  } catch (err) {
    console.warn('Supabase broadcast save error:', err);
    return false;
  }
}

export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Session');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    const cloudBroadcast = await fetchSupabaseBroadcast();
    if (cloudBroadcast) {
      return res.status(200).json({ success: true, broadcast: cloudBroadcast });
    }
    const local = getLocalBroadcast();
    return res.status(200).json({ success: true, broadcast: local });
  }

  if (req.method === 'POST') {
    try {
      requireAdmin(req);
      const { title, message, type, isActive, actionText, actionUrl } = req.body || {};
      if (!title?.trim() || !message?.trim()) {
        return res.status(400).json({ error: 'العنوان والرسالة مطلوبان.' });
      }
      const updated: BroadcastAnnouncement = {
        id: 'global_admin_broadcast',
        isActive: isActive !== false,
        title: title.trim(),
        message: message.trim(),
        type: type || 'info',
        updatedAt: 'الآن',
        actionText: actionText?.trim() || '',
        actionUrl: actionUrl?.trim() || '',
      };
      const persisted = await saveSupabaseBroadcast(updated);
      if (!persisted) throw new Error('تعذر حفظ الإعلان على قاعدة البيانات المركزية.');
      saveLocalBroadcast(updated);
      return res.status(200).json({
        success: true,
        message: 'تم حفظ ونشر الإعلان بنجاح!',
        broadcast: updated,
      });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || 'حدث خطأ في الحفظ.' });
    }
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}
