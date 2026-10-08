import { getAnalyticsSummary } from '../analyticsStore.ts';
import { requireAdmin } from '../auth.ts';

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  try {
    requireAdmin(req);
    const summary = await getAnalyticsSummary();
    return res.json(summary);
  } catch (err: any) {
    console.error('Error fetching admin analytics:', err);
    return res.status(err?.statusCode || 500).json({ error: err?.statusCode ? err.message : 'حدث خطأ في النظام.' });
  }
}
