function centralConfig() {
  return {
    url: (process.env.SUPABASE_URL || '').trim().replace(/\/$/, ''),
    key: (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim(),
  };
}

async function supabase(path: string, init: RequestInit = {}) {
  const { url, key } = centralConfig();
  if (!url || !key) throw new Error('إعدادات Supabase المركزية غير مكتملة.');
  return fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
}

export async function recordHeartbeat(deviceId: string, role = 'lawyer', isLawyer = true) {
  // Heartbeats are now tied to the authenticated platform account where possible.
  if (!deviceId) return;
  try {
    const res = await supabase(`platform_users?select=id&device_fingerprint=eq.${encodeURIComponent(deviceId)}&limit=1`);
    const user = (await res.json())?.[0];
    if (user?.id) {
      await supabase(`platform_users?id=eq.${encodeURIComponent(user.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ last_seen_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
      });
    }
  } catch {}
}

export async function recordEvent(
  type: 'register' | 'use' | 'subscribe',
  deviceId: string,
  role = 'lawyer',
  metadata?: any
) {
  if (type === 'use') return recordHeartbeat(deviceId, role, true);
  return recordHeartbeat(deviceId, role, true);
}

export function incrementOperationCount(_deviceId?: string) {
  // Operation counting is performed atomically by consume_platform_operation.
}

export async function getAnalyticsSummary() {
  const res = await supabase('platform_users?select=credits,account_status,operations_used,last_seen_at,created_at');
  if (!res.ok) throw new Error('تعذر قراءة إحصائيات الحسابات.');
  const users = await res.json();
  const rows = Array.isArray(users) ? users : [];
  const cutoff = Date.now() - 2 * 60 * 1000;
  const activeNow = rows.filter((u: any) => u.last_seen_at && Date.parse(u.last_seen_at) >= cutoff).length;
  const totalOperations = rows.reduce((sum: number, u: any) => sum + Number(u.operations_used || 0), 0);
  const activeAccounts = rows.filter((u: any) => u.account_status === 'active').length;
  const subscribed = rows.filter((u: any) => Number(u.credits || 0) > 0).length;

  return {
    activeNow,
    totalRegistered: rows.length,
    totalUsed: rows.filter((u: any) => Number(u.operations_used || 0) > 0).length,
    totalSubscribed: subscribed,
    totalOperations,
    lawyersCount: rows.length,
    clientsCount: 0,
    activeSessionsCount: activeAccounts,
  };
}

export default async function handler(req: any, res: any) {
  try {
    return res.status(200).json({ ok: true, analytics: await getAnalyticsSummary() });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err?.message || 'تعذر قراءة الإحصائيات.' });
  }
}
