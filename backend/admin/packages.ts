import { requireAdmin } from '../auth.ts';

const DEFAULT_SERVER_PACKAGES = [
  {
    id: 'pkg_15',
    name: 'باقة 15 عملية قضائية',
    credits: 15,
    price: '225 جنيه',
    numericPrice: 225,
    badge: 'أساسية',
    description: '15 عملية قضائية — 15 جنيه للعملية الواحدة.',
    features: ['15 عملية قضائية', 'رفع وتحليل المستندات', 'البث المباشر للإجابة'],
    enabled: true,
  },
  {
    id: 'pkg_30',
    name: 'باقة 30 عملية قضائية',
    credits: 30,
    price: '450 جنيه',
    numericPrice: 450,
    badge: 'الأكثر طلباً',
    popular: true,
    description: '30 عملية قضائية — 15 جنيه للعملية الواحدة.',
    features: ['30 عملية قضائية', 'رفع وتحليل المستندات', 'البث المباشر للإجابة'],
    enabled: true,
  },
  {
    id: 'pkg_60',
    name: 'باقة 60 عملية قضائية',
    credits: 60,
    price: '900 جنيه',
    numericPrice: 900,
    badge: 'مكاتب',
    description: '60 عملية قضائية — 15 جنيه للعملية الواحدة.',
    features: ['60 عملية قضائية', 'رفع وتحليل المستندات', 'البث المباشر للإجابة'],
    enabled: true,
  },
];

let inMemoryPackages: any[] = DEFAULT_SERVER_PACKAGES;

function cfg() {
  return {
    url: (process.env.SUPABASE_URL || '').trim().replace(/\/$/, ''),
    key: (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim(),
  };
}

async function readCloud() {
  const { url, key } = cfg();
  if (!url || !key) return null;
  const headers: Record<string, string> = { apikey: key };
  // Supabase sb_secret_* keys are not JWTs and must not be sent as Bearer tokens.
  if (!key.startsWith('sb_')) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`${url}/rest/v1/platform_packages?select=*&order=id.asc`, { headers });
  if (!res.ok) return null;
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) return null;
  return rows.map((r: any) => ({
    id: r.id, name: r.name, credits: Number(r.credits), price: r.price,
    numericPrice: Number(r.numeric_price || 0), badge: r.badge || undefined,
    popular: !!r.popular, description: r.description || '', features: Array.isArray(r.features) ? r.features : [],
    enabled: r.enabled !== false,
  }));
}

async function saveCloud(packages: any[]) {
  const { url, key } = cfg();
  if (!url || !key) return false;
  const headers: Record<string, string> = {
    apikey: key,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=representation',
  };
  // Legacy service_role keys are JWTs; new sb_secret_* keys are not.
  if (!key.startsWith('sb_')) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`${url}/rest/v1/platform_packages`, {
    method: 'POST',
    headers,
    body: JSON.stringify(packages.map((p) => ({
      id: p.id, name: p.name, credits: Number(p.credits), price: p.price,
      numeric_price: Number(p.numericPrice || 0), badge: p.badge || null,
      popular: !!p.popular, description: p.description || '',
      features: Array.isArray(p.features) ? p.features : [], enabled: p.enabled !== false,
      updated_at: new Date().toISOString(),
    }))),
  });
  if (!res.ok) return false;

  // Upsert alone does not remove deleted packages. Remove stale rows after
  // the new set has been saved so the database matches the admin's current list.
  const ids = packages.map((p) => String(p.id || '').trim()).filter(Boolean);
  if (ids.length > 0) {
    const filter = `not.in.(${ids.map((id) => `\"${id.replace(/\"/g, '\\\"')}\"`).join(',')})`; const cleanup = await fetch(`${url}/rest/v1/platform_packages?id=${encodeURIComponent(filter)}`, { method: 'DELETE',
      headers: {
        apikey: key,
        ...(key.startsWith('sb_') ? {} : { Authorization: `Bearer ${key}` }),
        Prefer: 'return=minimal',
      },
    });
    if (!cleanup.ok) return false;
  }
  return true;
}

export default async function handler(req: any, res: any) {
  if (req.method === 'GET') {
    const cloud = await readCloud().catch(() => null);
    if (cloud) inMemoryPackages = cloud;
    return res.json({ ok: true, packages: inMemoryPackages });
  }
  if (req.method === 'POST') {
    try { requireAdmin(req); } catch (e: any) { return res.status(401).json({ error: e.message }); }
    const route = String(req?.query?.route || '').replace(/^\/+|\/+$/g, '');
    const isReset = route === 'admin/packages/reset';
    if (isReset) {
      const defaults = DEFAULT_SERVER_PACKAGES.map((pkg) => ({ ...pkg, features: [...pkg.features] }));
      const persisted = await saveCloud(defaults);
      if (!persisted) {
        return res.status(503).json({ error: 'تعذر حفظ الباقات الافتراضية على قاعدة البيانات المركزية.' });
      }
      inMemoryPackages = defaults;
      return res.json({ ok: true, packages: defaults });
    }
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch {} }
    const { packages } = body || {};
    if (Array.isArray(packages) && packages.length > 0) {
      const normalized = packages.map((p: any) => ({
        ...p,
        credits: Number(p.credits),
        numericPrice: Number(p.numericPrice || 0),
        enabled: p.enabled !== false,
      }));
      if (normalized.some((p: any) => !p.id || !p.name || !Number.isFinite(p.credits) || p.credits <= 0)) {
        return res.status(400).json({ error: 'بيانات إحدى الباقات غير صالحة.' });
      }
      const persisted = await saveCloud(normalized);
      if (!persisted) {
        return res.status(503).json({ error: 'تعذر حفظ الباقات على قاعدة البيانات المركزية.' });
      }
      inMemoryPackages = normalized;
      return res.json({ ok: true, packages: normalized });
    }
    return res.status(400).json({ error: 'بيانات غير صالحة.' });
  }
  return res.status(405).json({ error: 'Method Not Allowed' });
}
