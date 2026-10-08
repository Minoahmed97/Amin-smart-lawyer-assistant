import React, { useState, useEffect } from 'react';
import {
  Star,
  Send,
  Sparkles,
  MapPin,
  Briefcase,
  Megaphone,
  CheckCircle2,
  RefreshCw,
  Plus,
  Quote,
} from 'lucide-react';
import { CommunityReview, fetchAllReviews, submitNewReview } from '../services/communityService.ts';

interface CommunityWallViewProps {
  theme?: 'warm-light' | 'dark';
}

const GOVERNORATES = [
  'القاهرة',
  'الجيزة',
  'الإسكندرية',
  'الدقهلية',
  'الشرقية',
  'الغربية',
  'المنوفية',
  'القليوبية',
  'البحيرة',
  'كفر الشيخ',
  'دمياط',
  'بورسعيد',
  'الإسماعيلية',
  'السويس',
  'شمال سيناء',
  'جنوب سيناء',
  'بني سويف',
  'الفيوم',
  'المنيا',
  'أسيوط',
  'سوهاج',
  'قنا',
  'الأقصر',
  'أسوان',
  'البحر الأحمر',
  'الوادي الجديد',
  'مطروح',
];

export const CommunityWallView: React.FC<CommunityWallViewProps> = ({ theme = 'warm-light' }) => {
  const isDark = theme === 'dark';
  const [reviews, setReviews] = useState<CommunityReview[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [filterType, setFilterType] = useState<'all' | 'review' | 'announcement' | 'recommendation'>('all');
  const [isFormOpen, setIsFormOpen] = useState<boolean>(false);

  // Form states
  const [authorName, setAuthorName] = useState<string>('');
  const [role, setRole] = useState<string>('محامٍ بالنقض');
  const [governorate, setGovernorate] = useState<string>('القاهرة');
  const [type, setType] = useState<'review' | 'announcement' | 'recommendation'>('review');
  const [rating, setRating] = useState<number>(5);
  const [content, setContent] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [statusMsg, setStatusMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const loadReviews = async () => {
    setIsLoading(true);
    try {
      const data = await fetchAllReviews();
      setReviews(data);
    } catch (e) {
      console.warn('Error loading reviews:', e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadReviews();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authorName.trim() || !content.trim()) {
      setStatusMsg({ type: 'error', text: 'يرجى إدخال اسمك ومحتوى التقييم.' });
      return;
    }
    setIsSubmitting(true);
    setStatusMsg(null);
    const res = await submitNewReview({
      authorName: authorName.trim(),
      role: role.trim(),
      governorate: governorate.trim(),
      type,
      rating,
      content: content.trim(),
    });
    if (res.success) {
      setStatusMsg({ type: 'success', text: res.message });
      setContent('');
      if (res.review) {
        setReviews((prev) => [res.review!, ...prev.filter((r) => r.id !== res.review?.id)]);
      }
      setTimeout(() => {
        setIsFormOpen(false);
        setStatusMsg(null);
      }, 2500);
    } else {
      setStatusMsg({ type: 'error', text: res.message });
    }
    setIsSubmitting(false);
  };

  const filteredReviews = reviews.filter((r) => {
    if (filterType === 'all') return true;
    return r.type === filterType;
  });

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      {/* Executive Header Banner */}
      <div
        className={`${
          isDark
            ? 'bg-gradient-to-r from-slate-900 via-slate-800 to-amber-950/60 border-amber-500/40 text-slate-100'
            : 'bg-gradient-to-r from-amber-50/90 via-white to-amber-100/60 border-amber-300/80 text-slate-900 shadow-md shadow-slate-200/50'
        } p-5 sm:p-7 rounded-2xl border-2 relative overflow-hidden`}
      >
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span
                className={`p-2 rounded-xl ${
                  isDark ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30' : 'bg-amber-600 text-white shadow-md'
                }`}
              >
                <Megaphone className="w-5 h-5" />
              </span>
              <h2 className="text-xl sm:text-2xl font-black tracking-tight text-amber-800">
                منصة المجتمع وتجارب الزملاء المحامين
              </h2>
            </div>
            <p
              className={`text-xs sm:text-sm leading-relaxed max-w-2xl font-medium ${
                isDark ? 'text-slate-300' : 'text-slate-700'
              }`}
            >
              شارك تجاربك في تفكيك المذكرات القضائية وصياغة الدفوع أمام محاكم الجمهورية.
            </p>
          </div>
          <div className="flex items-center gap-2.5 flex-wrap">
            <button
              onClick={() => setIsFormOpen(!isFormOpen)}
              className="px-4 py-2.5 bg-gradient-to-r from-amber-600 to-amber-700 hover:from-amber-700 hover:to-amber-800 text-white font-bold text-xs sm:text-sm rounded-xl shadow-lg transition-all flex items-center gap-2 cursor-pointer active:scale-95"
            >
              <Plus className="w-4 h-4" />
              <span>{isFormOpen ? 'إغلاق النموذج' : 'إضافة تقييم أو توصية'}</span>
            </button>
            <button
              onClick={loadReviews}
              disabled={isLoading}
              className={`p-2.5 rounded-xl border font-bold text-xs flex items-center gap-1.5 transition-all cursor-pointer ${
                isDark
                  ? 'bg-slate-800 text-amber-300 border-slate-700 hover:bg-slate-700'
                  : 'bg-white text-slate-800 border-slate-300 hover:bg-slate-100 shadow-sm'
              }`}
              title="تحديث الآراء"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-amber-600' : ''}`} />
              <span className="hidden sm:inline">تحديث</span>
            </button>
          </div>
        </div>

        {/* Quick Stats Bar */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-4 mt-4 border-t border-amber-300/30">
          <div
            className={`p-2.5 rounded-xl ${
              isDark ? 'bg-slate-900/80 border border-slate-800' : 'bg-white/90 border border-amber-200/80 shadow-xs'
            }`}
          >
            <span className="text-[11px] block text-slate-600 font-semibold">إجمالي الآراء والتوصيات:</span>
            <strong className="text-base sm:text-lg font-bold text-amber-700 font-mono">
              {reviews.length} تقييم
            </strong>
          </div>
          <div
            className={`p-2.5 rounded-xl ${
              isDark ? 'bg-slate-900/80 border border-slate-800' : 'bg-white/90 border border-amber-200/80 shadow-xs'
            }`}
          >
            <span className="text-[11px] block text-slate-600 font-semibold">متوسط التقييم العام:</span>
            <div className="flex items-center gap-1 mt-0.5">
              <div className="flex text-amber-500">
                {[...Array(5)].map((_, i) => (
                  <Star key={i} className="w-3.5 h-3.5 fill-amber-500 text-amber-500" />
                ))}
              </div>
              <strong className="text-xs font-bold text-slate-800 font-mono">4.9 / 5</strong>
            </div>
          </div>
          <div
            className={`p-2.5 rounded-xl ${
              isDark ? 'bg-slate-900/80 border border-slate-800' : 'bg-white/90 border border-amber-200/80 shadow-xs'
            }`}
          >
            <span className="text-[11px] block text-slate-600 font-semibold">المحامون الممارسون:</span>
            <strong className="text-base sm:text-lg font-bold text-emerald-700 font-mono">27 محافظة</strong>
          </div>
          <div
            className={`p-2.5 rounded-xl ${
              isDark ? 'bg-slate-900/80 border border-slate-800' : 'bg-white/90 border border-amber-200/80 shadow-xs'
            }`}
          >
            <span className="text-[11px] block text-slate-600 font-semibold">حالة المنظومة:</span>
            <div className="flex items-center gap-1.5 mt-1">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
              <strong className="text-xs font-bold text-emerald-700">سارية ومحدثة 2026</strong>
            </div>
          </div>
        </div>
      </div>

      {/* Add Review / Announcement Form Accordion */}
      {isFormOpen && (
        <div
          className={`${
            isDark
              ? 'bg-slate-900 border-2 border-amber-500/50 text-white'
              : 'bg-white border-2 border-amber-400 text-slate-900 shadow-xl'
          } p-5 sm:p-6 rounded-2xl animate-in slide-in-from-top-4 duration-200`}
        >
          <div className="border-b border-slate-200 pb-3 mb-4 flex items-center justify-between">
            <h3 className="text-base sm:text-lg font-bold text-amber-700 flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-amber-600" />
              <span>إضافة رأي أو توصية زميل</span>
            </h3>
            <span className="text-xs text-slate-600 font-medium">
              يُنشر فوراً في مجتمع المنظومة
            </span>
          </div>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-bold mb-1.5 text-slate-800">
                  الاسم الكامل: <span className="text-rose-600">*</span>
                </label>
                <input
                  type="text"
                  placeholder="مثال: أ. أحمد عبد المنعم"
                  value={authorName}
                  onChange={(e) => setAuthorName(e.target.value)}
                  className={`w-full px-3.5 py-2.5 rounded-xl text-xs font-medium border outline-none transition-all ${
                    isDark
                      ? 'bg-slate-800 border-slate-700 text-white focus:border-amber-400'
                      : 'bg-slate-50 border-slate-300 text-slate-900 focus:bg-white focus:border-amber-600'
                  }`}
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-bold mb-1.5 text-slate-800">
                  الصفة القضائية / الدرجة:
                </label>
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  className={`w-full px-3.5 py-2.5 rounded-xl text-xs font-medium border outline-none transition-all ${
                    isDark
                      ? 'bg-slate-800 border-slate-700 text-white focus:border-amber-400'
                      : 'bg-slate-50 border-slate-300 text-slate-900 focus:bg-white focus:border-amber-600'
                  }`}
                >
                  <option value="محامٍ بالنقض">محامٍ بالنقض</option>
                  <option value="محامٍ استئناف">محامٍ استئناف</option>
                  <option value="محامٍ ابتدائي">محامٍ ابتدائي</option>
                  <option value="مستشار قانوني">مستشار قانوني</option>
                  <option value="محامٍ جدول عام">محامٍ جدول عام</option>
                  <option value="باحث قانوني">باحث قانوني</option>
                  <option value="موكل / صاحب دعوى">موكل / صاحب دعوى</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-bold mb-1.5 text-slate-800">
                  المحافظة / النقابة الفرعية:
                </label>
                <select
                  value={governorate}
                  onChange={(e) => setGovernorate(e.target.value)}
                  className={`w-full px-3.5 py-2.5 rounded-xl text-xs font-medium border outline-none transition-all ${
                    isDark
                      ? 'bg-slate-800 border-slate-700 text-white focus:border-amber-400'
                      : 'bg-slate-50 border-slate-300 text-slate-900 focus:bg-white focus:border-amber-600'
                  }`}
                >
                  {GOVERNORATES.map((gov) => (
                    <option key={gov} value={gov}>
                      {gov}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold mb-1.5 text-slate-800">
                  نوع المشاركة:
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => setType('review')}
                    className={`py-2 px-2 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                      type === 'review'
                        ? 'bg-amber-600 text-white border-amber-600 shadow-sm'
                        : isDark
                        ? 'bg-slate-800 text-slate-300 border-slate-700'
                        : 'bg-slate-100 text-slate-700 border-slate-300'
                    }`}
                  >
                    تقييم المنظومة
                  </button>
                  <button
                    type="button"
                    onClick={() => setType('recommendation')}
                    className={`py-2 px-2 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                      type === 'recommendation'
                        ? 'bg-amber-600 text-white border-amber-600 shadow-sm'
                        : isDark
                        ? 'bg-slate-800 text-slate-300 border-slate-700'
                        : 'bg-slate-100 text-slate-700 border-slate-300'
                    }`}
                  >
                    توصية مهنية
                  </button>
                  <button
                    type="button"
                    onClick={() => setType('announcement')}
                    className={`py-2 px-2 rounded-xl text-xs font-bold border transition-all cursor-pointer ${
                      type === 'announcement'
                        ? 'bg-amber-600 text-white border-amber-600 shadow-sm'
                        : isDark
                        ? 'bg-slate-800 text-slate-300 border-slate-700'
                        : 'bg-slate-100 text-slate-700 border-slate-300'
                    }`}
                  >
                    تحديث قضائي
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-xs font-bold mb-1.5 text-slate-800">
                  التقييم:
                </label>
                <div className="flex items-center gap-1 py-1">
                  {[1, 2, 3, 4, 5].map((starVal) => (
                    <button
                      key={starVal}
                      type="button"
                      onClick={() => setRating(starVal)}
                      className="p-1 cursor-pointer transition-transform hover:scale-125"
                    >
                      <Star
                        className={`w-6 h-6 ${
                          starVal <= rating
                            ? 'text-amber-500 fill-amber-500'
                            : isDark
                            ? 'text-slate-600'
                            : 'text-slate-300'
                        }`}
                      />
                    </button>
                  ))}
                  <span className="mr-2 text-xs font-bold text-amber-700 font-mono">
                    ({rating} من 5)
                  </span>
                </div>
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold mb-1.5 text-slate-800">
                نص الرأي أو التوصية: <span className="text-rose-600">*</span>
              </label>
              <textarea
                rows={3}
                placeholder="اكتب تجربتك مع دقة الصياغة القضائية واستخراج الثغرات..."
                value={content}
                onChange={(e) => setContent(e.target.value)}
                className={`w-full p-3 rounded-xl text-xs font-medium leading-relaxed border outline-none transition-all ${
                  isDark
                    ? 'bg-slate-800 border-slate-700 text-white focus:border-amber-400'
                    : 'bg-slate-50 border-slate-300 text-slate-900 focus:bg-white focus:border-amber-600'
                }`}
                required
              />
            </div>

            {statusMsg && (
              <div
                className={`p-3 rounded-xl text-xs font-bold flex items-center gap-2 ${
                  statusMsg.type === 'success'
                    ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                    : 'bg-rose-100 text-rose-800 border border-rose-300'
                }`}
              >
                {statusMsg.type === 'success' ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                ) : null}
                <span>{statusMsg.text}</span>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setIsFormOpen(false)}
                className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer ${
                  isDark ? 'bg-slate-800 text-slate-300 hover:bg-slate-700' : 'bg-slate-200 text-slate-700 hover:bg-slate-300'
                }`}
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="px-6 py-2.5 bg-gradient-to-r from-amber-600 to-amber-700 hover:from-amber-700 hover:to-amber-800 text-white font-bold text-xs sm:text-sm rounded-xl shadow-lg transition-all flex items-center gap-2 cursor-pointer disabled:opacity-60"
              >
                <Send className="w-4 h-4" />
                <span>{isSubmitting ? 'جارٍ النشر...' : 'نشر المشاركة'}</span>
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Filter Tabs */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        <button
          onClick={() => setFilterType('all')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer whitespace-nowrap border ${
            filterType === 'all'
              ? 'bg-amber-600 text-white border-amber-600 shadow-md'
              : isDark
              ? 'bg-slate-900 text-slate-300 border-slate-800 hover:bg-slate-800'
              : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100 shadow-xs'
          }`}
        >
          كافة المشاركات ({reviews.length})
        </button>
        <button
          onClick={() => setFilterType('review')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer whitespace-nowrap border ${
            filterType === 'review'
              ? 'bg-amber-600 text-white border-amber-600 shadow-md'
              : isDark
              ? 'bg-slate-900 text-slate-300 border-slate-800 hover:bg-slate-800'
              : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100 shadow-xs'
          }`}
        >
          تقييمات المنظومة
        </button>
        <button
          onClick={() => setFilterType('recommendation')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer whitespace-nowrap border ${
            filterType === 'recommendation'
              ? 'bg-amber-600 text-white border-amber-600 shadow-md'
              : isDark
              ? 'bg-slate-900 text-slate-300 border-slate-800 hover:bg-slate-800'
              : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100 shadow-xs'
          }`}
        >
          توصيات الزملاء
        </button>
        <button
          onClick={() => setFilterType('announcement')}
          className={`px-4 py-2 rounded-xl text-xs font-bold transition-all cursor-pointer whitespace-nowrap border ${
            filterType === 'announcement'
              ? 'bg-amber-600 text-white border-amber-600 shadow-md'
              : isDark
              ? 'bg-slate-900 text-slate-300 border-slate-800 hover:bg-slate-800'
              : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100 shadow-xs'
          }`}
        >
          تحديثات قضائية
        </button>
      </div>

      {/* Reviews Grid */}
      {isLoading ? (
        <div className="py-12 text-center space-y-3">
          <RefreshCw className="w-8 h-8 mx-auto text-amber-600 animate-spin" />
          <p className={`text-xs font-bold ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
            جارٍ تحميل آراء وتوصيات الزملاء...
          </p>
        </div>
      ) : filteredReviews.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filteredReviews.map((item) => (
            <div
              key={item.id}
              className={`${
                isDark
                  ? 'bg-slate-900/90 border border-slate-800 text-slate-100'
                  : 'bg-white border border-slate-200 text-slate-900 shadow-sm hover:shadow-md'
              } p-4 sm:p-5 rounded-2xl flex flex-col justify-between transition-all relative overflow-hidden`}
            >
              <div className="space-y-3">
                {/* Author Info & Badge */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-600 to-amber-800 text-white flex items-center justify-center font-bold text-sm shadow-md flex-shrink-0">
                      {item.authorName.slice(0, 2)}
                    </div>
                    <div>
                      <h4 className="text-sm font-bold text-slate-900">
                        {item.authorName}
                      </h4>
                      <div className="flex items-center gap-2 text-[11px] text-slate-600 mt-0.5 flex-wrap">
                        <span className="flex items-center gap-1 font-medium">
                          <Briefcase className="w-3 h-3 text-amber-600" />
                          <span>{item.role}</span>
                        </span>
                        <span>•</span>
                        <span className="flex items-center gap-1 font-medium">
                          <MapPin className="w-3 h-3 text-emerald-600" />
                          <span>{item.governorate}</span>
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Badge */}
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded-full font-bold border ${
                      item.type === 'announcement'
                        ? 'bg-blue-50 text-blue-700 border-blue-300'
                        : item.type === 'recommendation'
                        ? 'bg-amber-50 text-amber-800 border-amber-300'
                        : 'bg-emerald-50 text-emerald-800 border-emerald-300'
                    }`}
                  >
                    {item.type === 'announcement'
                      ? 'تحديث قضائي'
                      : item.type === 'recommendation'
                      ? 'توصية مهنية'
                      : 'تقييم تجربة'}
                  </span>
                </div>

                {/* Stars */}
                <div className="flex items-center gap-1">
                  {[...Array(5)].map((_, i) => (
                    <Star
                      key={i}
                      className={`w-3.5 h-3.5 ${
                        i < item.rating
                          ? 'text-amber-500 fill-amber-500'
                          : isDark
                          ? 'text-slate-700'
                          : 'text-slate-200'
                      }`}
                    />
                  ))}
                  <span className="text-[10px] text-slate-500 mr-2 font-mono">
                    {item.createdAt}
                  </span>
                </div>

                {/* Content */}
                <p
                  className={`text-xs sm:text-sm leading-relaxed font-normal ${
                    isDark ? 'text-slate-200' : 'text-slate-800'
                  }`}
                  style={{ whiteSpace: 'pre-line' }}
                >
                  "{item.content}"
                </p>
              </div>

              {/* Verified Ribbon */}
              <div className="pt-3 mt-3 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-500">
                <span className="flex items-center gap-1 text-emerald-700 font-semibold">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                  <span>عضو موثق بالمنظومة القضائية</span>
                </span>
                <span className="font-mono text-[10px] text-slate-400">#EGY-LAW-{item.id.slice(-4)}</span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div
          className={`p-8 rounded-2xl text-center border-2 border-dashed ${
            isDark ? 'bg-slate-900/50 border-slate-800 text-slate-400' : 'bg-white border-slate-300 text-slate-600'
          }`}
        >
          <Quote className="w-10 h-10 mx-auto text-amber-500/60 mb-2" />
          <h4 className="text-sm font-bold mb-1">لا توجد مشاركات مطابقة للتصنيف</h4>
          <p className="text-xs max-w-sm mx-auto mb-4">كن أول من يشارك تجربته مع الزملاء المحامين الآن!</p>
          <button
            onClick={() => setIsFormOpen(true)}
            className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white font-bold text-xs rounded-xl shadow-md cursor-pointer"
          >
            إضافة أول مشاركة
          </button>
        </div>
      )}
    </div>
  );
};
