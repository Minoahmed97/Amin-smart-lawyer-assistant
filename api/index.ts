/** * Central Vercel API Function * * All application API routes are dispatched through this single function. * The individual handlers live under /backend and are NOT Vercel Functions. */
import reviewsHandler from '../backend/reviews.ts';
import broadcastHandler from '../backend/broadcast.ts';
import adminAnalyticsHandler from '../backend/admin/analytics.ts';
import addKeyHandler from '../backend/admin/keys/add.ts';
import deleteKeyHandler from '../backend/admin/keys/delete.ts';
import testKeyHandler from '../backend/admin/keys/test.ts';
import keysStatusHandler from '../backend/admin/keys-status.ts';
import aiHealthHandler from '../backend/admin/ai-health.ts';
import packagesHandler from '../backend/admin/packages.ts';
import heartbeatHandler from '../backend/analytics/heartbeat.ts';
import eventHandler from '../backend/analytics/event.ts';
import deconstructHandler from '../backend/gemini/deconstruct.ts';
import counterBriefHandler from '../backend/gemini/counter-brief.ts';
import qualifyHandler from '../backend/gemini/qualify.ts';
import refineHandler from '../backend/gemini/refine.ts';
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
  '/gemini/qualify': qualifyHandler,
  '/gemini/refine': refineHandler,
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
  // Vercel rewrite: /api/:path* -> /api/index?route=:path*
  const queryRoute = req?.query?.route;
  if (queryRoute) return normalizeRoute(queryRoute);

  // Also support direct invocation and local Express development.
  const url = String(req?.url || '').split('?')[0];
  return normalizeRoute(url);
}

export default async function handler(req: any, res: any) {
  const route = getRoute(req);
  if (route.startsWith('/auth/')) {
    req.query = { ...(req.query || {}), subroute: route.slice('/auth/'.length) };
  }

  // Keep the response behavior friendly for browser preflight requests.
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
      error: 'API route not found.',
      route,
    });
  }

  try {
    return await target(req, res);
  } catch (error: any) {
    // Never serialize provider/database error objects to logs: they may contain
    // request details or credentials. Keep only bounded operational metadata.
    console.error(`Central API error [${String(req.method || '').slice(0, 10)} ${route}] status=${Number(error?.statusCode) || 500}`);
    if (!res.headersSent) {
      if (error?.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
      return res.status(error?.statusCode || 500).json({
        error: error?.statusCode && error.statusCode < 500
          ? (error.message || 'تعذر تنفيذ الطلب.')
          : 'حدث خطأ داخلي في الخادم.',
      });
    }
  }
}
