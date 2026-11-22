import { getKeysStatus } from '../keyRotation.ts';
import { requireAdmin } from '../auth.ts';
import { fetchServerCloudGeminiKeys } from '../supabaseSync.ts';

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });
  try {
    requireAdmin(req);
    const cloudKeys = await fetchServerCloudGeminiKeys();
    return res.json(getKeysStatus(cloudKeys));
  } catch (err: any) {
    console.error('Error in keys status handler:', err);
    return res.status(err?.statusCode || 500).json({ error: err?.statusCode ? err.message : 'تعذر تحميل مفاتيح Gemini من Supabase.' });
  }
}
