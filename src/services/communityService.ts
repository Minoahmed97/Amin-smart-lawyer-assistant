import { getStoredSupabaseConfig } from './supabaseSyncService.ts';

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

const LOCAL_STORAGE_KEY = 'judicial_community_reviews';

const INITIAL_FALLBACK_REVIEWS: CommunityReview[] = [
  {
    id: 'seed_1',
    authorName: 'أحمد محمود عبد العال',
    role: 'محامٍ بالنقض',
    governorate: 'القاهرة',
    type: 'recommendation',
    rating: 5,
    content: 'المنصة ممتازة في تفكيك المذكرات واستخراج الثغرات الموضوعية بدقة تفوق التوقعات.',
    createdAt: 'منذ يومين',
  },
  {
    id: 'seed_2',
    authorName: 'مروان الشافعي',
    role: 'محامٍ استئناف',
    governorate: 'الإسكندرية',
    type: 'review',
    rating: 5,
    content: 'صياغة المذكرات مطابقة تماماً للأصول القضائية وقواعد محكمة النقض المصرية.',
    createdAt: 'منذ 3 أيام',
  },
  {
    id: 'seed_3',
    authorName: 'ياسر كمال الدين',
    role: 'مستشار قانوني',
    governorate: 'الجيزة',
    type: 'announcement',
    rating: 5,
    content: 'تم تفعيل التحديث القضائي الشامل وربط محاكم مجلس الدولة والاستئناف لعام 2026.',
    createdAt: 'منذ أسبوع',
  },
  {
    id: 'seed_4',
    authorName: 'د. سمير النجار',
    role: 'محامٍ بالنقض والدستورية العليا',
    governorate: 'الدقهلية',
    type: 'review',
    rating: 5,
    content: 'منظومة رصينة تحفظ خصوصية المحامي وتنجز إعداد الدفوع في ثوانٍ معدودة.',
    createdAt: 'منذ أسبوع',
  },
];

export async function fetchAllReviews(): Promise<CommunityReview[]> {
  try {
    const res = await fetch('/api/reviews', { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      if (data.success && Array.isArray(data.reviews) && data.reviews.length > 0) {
        try {
          localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(data.reviews));
        } catch {}
        return data.reviews;
      }
    }
  } catch (err) {
    console.warn('Reviews API fetch failed, checking Supabase direct...', err);
  }

  const cfg = getStoredSupabaseConfig();
  if (cfg.isConnected) {
    try {
      const endpoint = `${cfg.url}/rest/v1/app_community_reviews?select=*&order=created_at.desc&limit=50`;
      const res = await fetch(endpoint, {
        method: 'GET',
        headers: {
          apikey: cfg.anonKey,
          Authorization: `Bearer ${cfg.anonKey}`,
        },
      });
      if (res.ok) {
        const records = await res.json();
        if (Array.isArray(records) && records.length > 0) {
          const mapped: CommunityReview[] = records.map((r: any) => ({
            id: r.id ? String(r.id) : `sb_${Date.now()}_${Math.random()}`,
            authorName: r.author_name || r.authorName || 'زميل محام',
            role: r.role || 'محامٍ',
            governorate: r.governorate || 'القاهرة',
            type: r.type || 'review',
            rating: Number(r.rating) || 5,
            content: r.content || '',
            createdAt: r.created_at ? new Date(r.created_at).toLocaleDateString('ar-EG') : 'حديثاً',
          }));
          try {
            localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(mapped));
          } catch {}
          return mapped;
        }
      }
    } catch (e) {
      console.warn('Direct Supabase reviews fetch error:', e);
    }
  }

  try {
    const cached = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch {}

  return INITIAL_FALLBACK_REVIEWS;
}

export async function submitNewReview(
  reviewData: Omit<CommunityReview, 'id' | 'createdAt'>
): Promise<{ success: boolean; message: string; review?: CommunityReview }> {
  try {
    const res = await fetch('/api/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reviewData),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.review) {
        return { success: true, message: 'تم نشر رأيك بنجاح!', review: data.review };
      }
    }
  } catch (err) {
    console.warn('Server review submit error:', err);
  }

  const cfg = getStoredSupabaseConfig();
  if (cfg.isConnected) {
    try {
      const endpoint = `${cfg.url}/rest/v1/app_community_reviews`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          apikey: cfg.anonKey,
          Authorization: `Bearer ${cfg.anonKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({
          author_name: reviewData.authorName,
          role: reviewData.role,
          governorate: reviewData.governorate,
          type: reviewData.type,
          rating: reviewData.rating,
          content: reviewData.content,
        }),
      });
      if (res.ok) {
        const createdRecord = await res.json();
        const created: CommunityReview = {
          id: createdRecord[0]?.id ? String(createdRecord[0].id) : `sb_${Date.now()}`,
          authorName: reviewData.authorName,
          role: reviewData.role,
          governorate: reviewData.governorate,
          type: reviewData.type,
          rating: reviewData.rating,
          content: reviewData.content,
          createdAt: 'الآن',
        };
        return { success: true, message: 'تم حفظ الرأي بنجاح في السحابة!', review: created };
      }
    } catch (e) {
      console.warn('Direct Supabase review save error:', e);
    }
  }

  const localItem: CommunityReview = {
    id: `local_${Date.now()}`,
    authorName: reviewData.authorName,
    role: reviewData.role,
    governorate: reviewData.governorate,
    type: reviewData.type,
    rating: reviewData.rating,
    content: reviewData.content,
    createdAt: 'الآن',
  };
  try {
    const cached = localStorage.getItem(LOCAL_STORAGE_KEY);
    const list = cached ? JSON.parse(cached) : [...INITIAL_FALLBACK_REVIEWS];
    list.unshift(localItem);
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(list));
  } catch {}
  return { success: true, message: 'تم نشر التقييم محلياً بنجاح!', review: localItem };
}
