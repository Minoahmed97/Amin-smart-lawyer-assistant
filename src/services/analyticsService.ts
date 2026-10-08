import { getDeviceFingerprint, getUserRole, isLawyerVerified } from '../utils/deviceFingerprint.ts';
import { getAdminSessionToken, getSessionToken, getSessionExpiry, saveSession, clearSession } from './authService.ts';

export interface PlatformAnalyticsMetrics {
  activeNow: number;
  totalRegistered: number;
  totalUsed: number;
  totalSubscribed: number;
  totalOperations: number;
  lawyersCount: number;
  clientsCount: number;
  lastUpdated: string;
}

let isTrackingStarted = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let sessionExpiryTimer: ReturnType<typeof setTimeout> | null = null;

export async function initAnalyticsTracking(onSessionExpired?: () => void): Promise<void> {
  if (typeof window === 'undefined' || isTrackingStarted) return;
  isTrackingStarted = true;

  try {
    const deviceId = await getDeviceFingerprint();
    const role = getUserRole() || 'unspecified';
    const isLawyer = isLawyerVerified();

    const scheduleSessionExpiry = () => {
      if (sessionExpiryTimer) clearTimeout(sessionExpiryTimer);
      const expiresAt = getSessionExpiry();
      if (!expiresAt) return;
      const delay = Math.max(0, expiresAt - Date.now() + 250);
      sessionExpiryTimer = setTimeout(() => {
        if (getSessionExpiry() <= Date.now()) {
          clearSession();
          onSessionExpired?.();
        } else {
          scheduleSessionExpiry();
        }
      }, delay);
    };

    const sendHeartbeat = async () => {
      try {
        const token = getSessionToken();
        if (!token) return;
        const res = await fetch('/api/analytics/heartbeat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            deviceId,
            role,
            isLawyer,
            timestamp: Date.now(),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 401 || res.status === 403) {
          clearSession();
          onSessionExpired?.();
          return;
        }
        if (res.ok && typeof data?.sessionToken === 'string' && data.sessionToken) {
          saveSession(data.sessionToken);
          scheduleSessionExpiry();
        }
      } catch {
        // Keep the short-lived session; the expiry timer will end it if the connection stays unavailable.
      }
    };

    scheduleSessionExpiry();
    await sendHeartbeat();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(sendHeartbeat, 30000);

    if (role === 'lawyer') {
      await recordAnalyticsEvent('register', { role, isLawyer });
    }
  } catch (err) {
    console.warn('Analytics tracking init warning:', err);
  }
}

export function stopAnalyticsTracking(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (sessionExpiryTimer) clearTimeout(sessionExpiryTimer);
  heartbeatTimer = null;
  sessionExpiryTimer = null;
  isTrackingStarted = false;
}

export async function recordAnalyticsEvent(
  type: 'register' | 'use' | 'subscribe',
  metadata?: Record<string, any>
): Promise<void> {
  try {
    const deviceId = await getDeviceFingerprint();
    await fetch('/api/analytics/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type,
        deviceId,
        role: getUserRole() || 'unspecified',
        metadata: metadata || {},
        timestamp: Date.now(),
      }),
    });
  } catch {
    // Silent background handling
  }
}

export async function fetchPlatformAnalytics(): Promise<PlatformAnalyticsMetrics> {
  try {
    const res = await fetch('/api/admin/analytics', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', 'x-admin-session': getAdminSessionToken() },
    });
    if (res.ok) {
      const data = await res.json();
      return {
        activeNow: Number(data.activeNow || 0),
        totalRegistered: data.totalRegistered || 0,
        totalUsed: data.totalUsed || 0,
        totalSubscribed: data.totalSubscribed || 0,
        totalOperations: data.totalOperations || 0,
        lawyersCount: data.lawyersCount || 0,
        clientsCount: data.clientsCount || 0,
        lastUpdated: new Date().toLocaleTimeString('ar-EG', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
      };
    }
  } catch (err) {
    console.warn('Could not fetch analytics from server:', err);
  }

  return {
    activeNow: 0,
    totalRegistered: 0,
    totalUsed: 0,
    totalSubscribed: 0,
    totalOperations: 0,
    lawyersCount: 0,
    clientsCount: 0,
    lastUpdated: new Date().toLocaleTimeString('ar-EG'),
  };
}
