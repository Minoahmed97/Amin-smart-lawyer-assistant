import { getKeysStatus } from '../keyRotation.ts';
import { requireAdmin } from '../auth.ts';
import { fetchServerCloudGeminiKeys, fetchServerCloudGeminiKeyRuntimeStatuses } from '../supabaseSync.ts';

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  try {
    requireAdmin(req);
    const status = getKeysStatus();
    const [cloudKeys, runtimeStatuses] = await Promise.all([
      fetchServerCloudGeminiKeys(),
      fetchServerCloudGeminiKeyRuntimeStatuses(),
    ]);
    const runtimeByMasked = new Map(runtimeStatuses.map((item) => [item.masked, item]));
    const merged = [...status.keys];
    for (const key of cloudKeys) {
      const masked = key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-4)}` : '****';
      const runtime = runtimeByMasked.get(masked);
      const existingKey = merged.find((item: any) => item.masked === masked);
      if (existingKey) {
        if (runtime) Object.assign(existingKey, runtime);
        continue;
      }
      merged.push({
        index: merged.length,
        id: `cloud_${merged.length + 1}`,
        name: 'مفتاح مركزي من Supabase',
        masked,
        prefix: key.slice(0, 2),
        isActive: true,
        ...(runtime || {}),
      });
    }
    return res.json({
      ...status,
      keys: merged,
      totalCount: merged.length,
      isConfigured: merged.length > 0,
      rotationEnabled: merged.length > 1,
    });
  } catch (err: any) {
    console.error('Error in keys status handler:', err);
    return res.status(err?.statusCode || 500).json({ error: err?.statusCode ? err.message : 'حدث خطأ في النظام.' });
  }
}
