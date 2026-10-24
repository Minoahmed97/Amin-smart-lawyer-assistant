/**
 * دالة واجهة برمجة التطبيقات المركزية لـ Vercel
 * 
 * يتم توجيه جميع مسارات واجهة برمجة التطبيقات للتطبيق من خلال هذه الدالة الواحدة.
 * المعالجات الفردية موجودة تحت /backend وليست دوال Vercel مستقلة.
 */
import reviewsHandler from '../backend/reviews.ts';
import broadcastHandler from '../backend/broadcast.ts';
import adminAnalyticsHandler from '../backend/admin/analytics.ts';
import addKeyHandler from '../backend/admin/keys/add.ts';
import deleteKeyHandler from '../backend/admin/keys/delete.ts';
import testKeyHandler from '../backend/admin/keys/test.ts';
import keysStatusHandler from '../backend/admin/keys-status.ts';
import ocrKeysHandler from '../backend/admin/ocr-keys.ts';
import ocrFallbackHandler from '../backend/admin/ocr-fallback.ts';
import aiHealthHandler from '../backend/admin/ai-health.ts';
import packagesHandler from '../backend/admin/packages.ts';
import heartbeatHandler from '../backend/analytics/heartbeat.ts';
import eventHandler from '../backend/analytics/event.ts';
import deconstructHandler from '../backend/gemini/deconstruct.ts';
import counterBriefHandler from '../backend/gemini/counter-brief.ts';
import aiGenerationJobsHandler from '../backend/gemini/jobs.ts';
import qualifyHandler from '../backend/gemini/qualify.ts';
import refineHandler from '../backend/gemini/refine.ts';
import chatHandler from '../backend/gemini/chat.ts';
import geminiOcrHandler from '../backend/gemini/ocr.ts';
import ocrHandler from '../backend/ocr.ts';
import authHandler from '../backend/auth-api.ts';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '50mb',
    },
  },
};

type Handler = (req: any, res: any) => any;

const ROUTES: Record<string, Handler> = {
  '/auth/admin-login': authHandler,
  '/auth/register': authHandler,
  '/auth/login': authHandler,
  '/auth/me': authHandler,
  '/auth/consume': authHandler,
  '/auth/redeem': authHandler,
  '/auth/generate-code': authHandler,
  '/auth/accounts': authHandler,
  '/auth/admin-balance': authHandler,
  '/auth/admin-delete-account': authHandler,
  '/reviews': reviewsHandler,
  '/broadcast': broadcastHandler,

  '/admin/analytics': adminAnalyticsHandler,
  '/admin/keys-status': keysStatusHandler,
  '/admin/ocr-keys': ocrKeysHandler,
  '/admin/ocr-fallback': ocrFallbackHandler,
  '/admin/ai-health': aiHealthHandler,
  '/admin/keys/add': addKeyHandler,
  '/admin/keys/delete': deleteKeyHandler,
  '/admin/keys/test': testKeyHandler,
  '/admin/packages': packagesHandler,
  '/admin/packages/reset': packagesHandler,

  '/analytics/heartbeat': heartbeatHandler,
  '/analytics/event': eventHandler,

  '/gemini/deconstruct': deconstructHandler,
  '/gemini/counter-brief': counterBriefHandler,
  '/gemini/jobs': aiGenerationJobsHandler,
  '/gemini/qualify': qualifyHandler,
  '/gemini/refine': refineHandler,
  '/gemini/chat': chatHandler,
  '/gemini/ocr': geminiOcrHandler,
  '/ocr': ocrHandler,
};

function normalizeRoute(value: unknown): string {
  const raw = Array.isArray(value) ? value.join('/') : String(value || '');
  let route = raw.trim();

  if (!route) return '';
  if (!route.startsWith('/')) route = `/${route}`;
  if (route.startsWith('/api/')) route = route.slice(4);
  else if (route === '/api') route = '/';
  return route.replace(/\/+$/, '') || '/';
}

function getRoute(req: any): string {
  // إعادة توجيه Vercel: /api/:path* -> /api/index?route=:path*
  const queryRoute = req?.query?.route;
  if (queryRoute) return normalizeRoute(queryRoute);

  // دعم الاستدعاء المباشر والتطوير المحلي عبر Express أيضاً.
  const url = String(req?.url || '').split('?')[0];
  return normalizeRoute(url);
}

export default async function handler(req: any, res: any) {
  const route = getRoute(req);
  if (route.startsWith('/auth/')) {
    req.query = { ...(req.query || {}), subroute: route.slice('/auth/'.length) };
  }

  // الحفاظ على سلوك الاستجابة ودياً لطلبات الفحص المسبق للمتصفح.
  if (req.method === 'OPTIONS') {
    const target = ROUTES[route];
    if (target) return target(req, res);
    return res.status(200).end();
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cache-Control', 'no-store');

  const target = ROUTES[route];
  if (!target) {
    return res.status(404).json({
      error: 'مسار واجهة برمجة التطبيقات غير موجود.',
      route,
    });
  }

  try {
    return await target(req, res);
  } catch (error: any) {
    // عدم تسجيل كائنات الأخطاء الخام: قد تحتوي أخطاء المزود أو قاعدة البيانات على بيانات الطلب أو بيانات الاعتماد.
    const statusCode = Number(error?.statusCode) || 500;
    console.error(`Central API error [${req.method} ${route}] status=${statusCode}`);
    if (!res.headersSent) {
      if (error?.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
      return res.status(error?.statusCode || 500).json({
        error: error?.statusCode && error.statusCode < 500
          ? (error.message || 'عذراً، حدث خطأ أثناء تنفيذ الطلب.')
          : 'حدث خطأ داخلي في الخادم.',
      });
    }
  }
}
