import fs from 'fs';
import path from 'path';
import { requireSession } from './auth.ts';
import { rateLimit, limitBodyString } from './security.ts';

export interface CommunityReview {
  id: string;
  authorName: string;
  role: string;
  governorate: string;
  type: 'review' | 'announcement' | 'recommendation';
  rating: number;
  content: string;
  createdAt: string;
}

const SEED_REVIEWS: CommunityReview[] = [
  {
    id: 'rev_seed_1',
    authorName: 'أحمد محمود عبد العال',
    role: 'محامٍ بالنقض',
    governorate: 'القاهرة',
    type: 'recommendation',
    rating: 5,
    content: 'المنصة ممتازة في تفكيك المذكرات واستخراج الثغرات الموضوعية بدقة تفوق التوقعات.',
    createdAt: 'منذ يومين',
  },
  {
    id: 'rev_seed_2',
    authorName: 'مروان الشافعي',
    role: 'محامٍ استئناف',
    governorate: 'الإسكندرية',
    type: 'review',
    rating: 5,
    content: 'صياغة المذكرات مطابقة تماماً للأصول القضائية وقواعد محكمة النقض المصرية.',
    createdAt: 'منذ 3 أيام',
  },
  {
    id: 'rev_seed_3',
    authorName: 'ياسر كمال الدين',
    role: 'مستشار قانوني',
    governorate: 'الجيزة',
    type: 'announcement',
    rating: 5,
    content: 'تم تفعيل التحديث القضائي الشامل وربط محاكم مجلس الدولة والاستئناف لعام 2026.',
    createdAt: 'منذ أسبوع',
  },
  {
    id: 'rev_seed_4',
    authorName: 'د. سمير النجار',
    role: 'محامٍ بالنقض والدستورية العليا',
    governorate: 'الدقهلية',
    type: 'review',
    rating: 5,
    content: 'منظومة رصينة تحفظ خصوصية المحامي وتنجز إعداد الدفوع في ثوانٍ معدودة.',
    createdAt: 'منذ أسبوع',
  },
];

const REVIEWS_FILE = path.join(process.cwd(), '.reviews_data.json');
let inMemoryReviews: CommunityReview[] = [...SEED_REVIEWS];

export function getLocalReviews(): CommunityReview[] {
  try {
    if (fs.existsSync(REVIEWS_FILE)) {
      const data = fs.readFileSync(REVIEWS_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch (e) {
    // fallback
  }
  return inMemoryReviews;
}

export function saveLocalReviews(reviews: CommunityReview[]): void {
  inMemoryReviews = reviews;
  try {
    fs.writeFileSync(REVIEWS_FILE, JSON.stringify(reviews, null, 2), 'utf-8');
  } catch (e) {
    // ignore on readonly
  }
}

export async function fetchSupabaseReviews(): Promise<CommunityReview[] | null> {
  const supabaseUrl = (process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
  const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim();

  if (!supabaseUrl || !supabaseKey) return null;

  try {
    const endpoint = `${supabaseUrl}/rest/v1/app_community_reviews?select=*&order=created_at.desc&limit=50`;
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
        return records.map((r) => ({
          id: r.id ? String(r.id) : `sb_${Date.now()}_${Math.random()}`,
          authorName: r.author_name || r.authorName || 'زميل محام',
          role: r.role || 'محامٍ',
          governorate: r.governorate || 'القاهرة',
          type: r.type || 'review',
          rating: Number(r.rating) || 5,
          content: r.content || '',
          createdAt: r.created_at ? new Date(r.created_at).toLocaleDateString('ar-EG') : 'حديثاً',
        }));
      }
    }
  } catch (err) {
    console.warn('Supabase reviews fetch error:', err);
  }
  return null;
}

export async function saveReviewToSupabase(review: Omit<CommunityReview, 'id' | 'createdAt'>): Promise<boolean> {
  const supabaseUrl = (process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
  const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '').trim();

  if (!supabaseUrl || !supabaseKey) return false;

  try {
    const endpoint = `${supabaseUrl}/rest/v1/app_community_reviews`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        author_name: review.authorName,
        role: review.role,
        governorate: review.governorate,
        type: review.type,
        rating: review.rating,
        content: review.content,
      }),
    });
    return res.ok || res.status === 201;
  } catch (err) {
    console.warn('Supabase review insert error:', err);
    return false;
  }
}

export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    const cloudReviews = await fetchSupabaseReviews();
    if (cloudReviews && cloudReviews.length > 0) {
      return res.status(200).json({ success: true, reviews: cloudReviews });
    }
    const local = getLocalReviews();
    return res.status(200).json({ success: true, reviews: local });
  }

  if (req.method === 'POST') {
    try {
      requireSession(req);
      rateLimit(req, 'reviews-post', 3, 60 * 60 * 1000);
      const { authorName, role, governorate, type, rating, content } = req.body || {};
      limitBodyString(authorName, 120, 'الاسم');
      limitBodyString(role, 120, 'الصفة');
      limitBodyString(governorate, 80, 'المحافظة');
      limitBodyString(content, 4000, 'التقييم');
      if (!authorName?.trim() || !content?.trim()) {
        return res.status(400).json({ error: 'الاسم والمحتوى مطلوبان.' });
      }
      const newReview: CommunityReview = {
        id: `rev_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        authorName: authorName.trim(),
        role: (role || 'محامٍ').trim(),
        governorate: (governorate || 'القاهرة').trim(),
        type: ['review','announcement','recommendation'].includes(type) ? type : 'review',
        rating: Number.isFinite(Number(rating)) && Number(rating) >= 1 && Number(rating) <= 5 ? Math.floor(Number(rating)) : 5,
        content: content.trim(),
        createdAt: 'الآن',
      };
      await saveReviewToSupabase(newReview);
      const current = getLocalReviews();
      const updated = [newReview, ...current];
      saveLocalReviews(updated);
      return res.status(201).json({ success: true, review: newReview, reviews: updated });
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || 'حدث خطأ في الحفظ.' });
    }
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}
