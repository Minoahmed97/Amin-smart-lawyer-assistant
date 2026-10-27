/** * Persistent Storage Engine for Egyptian Judicial Assistant. * Keeps the newest field value available when localStorage reaches quota, * while preserving the existing localStorage/sessionStorage/memory behavior. */
const memoryCache = new Map<string, string>();
const localStorageFallbackKeys = new Set<string>();
const FALLBACK_MARKER_PREFIX = '__judicial_persistent_fallback__:';

export const persistentStorage = {
  getItem(key: string, defaultValue: string = ''): string {
    if (localStorageFallbackKeys.has(key) && memoryCache.has(key)) {
      return memoryCache.get(key) ?? defaultValue;
    }

    // A failed localStorage write can leave an older value under the same key.
    // In that case, use the current session copy before reading that stale value.
    try {
      if (typeof window !== 'undefined' && window.sessionStorage) {
        const fallbackMarker = `${FALLBACK_MARKER_PREFIX}${key}`;
        if (window.sessionStorage.getItem(fallbackMarker) === '1') {
          const fallbackValue = window.sessionStorage.getItem(key);
          if (fallbackValue !== null && fallbackValue !== undefined) {
            memoryCache.set(key, fallbackValue);
            return fallbackValue;
          }
        }
      }
    } catch {}

    // 1. Try localStorage when it is the current source of truth.
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const val = window.localStorage.getItem(key);
        if (val !== null && val !== undefined) {
          memoryCache.set(key, val);
          return val;
        }
      }
    } catch {}

    // 2. Try sessionStorage.
    try {
      if (typeof window !== 'undefined' && window.sessionStorage) {
        const val = window.sessionStorage.getItem(key);
        if (val !== null && val !== undefined) {
          memoryCache.set(key, val);
          return val;
        }
      }
    } catch {}

    // 3. Fallback to memoryCache.
    if (memoryCache.has(key)) {
      return memoryCache.get(key) ?? defaultValue;
    }
    return defaultValue;
  },

  setItem(key: string, rawValue: string): void {
    const value = rawValue === undefined || rawValue === null ? '' : String(rawValue);
    const fallbackMarker = `${FALLBACK_MARKER_PREFIX}${key}`;
    memoryCache.set(key, value);

    let localStorageSaved = false;
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        try {
          window.localStorage.setItem(key, value);
          localStorageSaved = true;
        } catch (firstError) {
          // Preserve the newest text first, then retry after freeing only this
          // key's obsolete value. This is useful when a long OCR/legal result
          // makes replacing the previous value exceed the browser's quota.
          try {
            if (window.sessionStorage) {
              window.sessionStorage.setItem(key, value);
              window.sessionStorage.setItem(fallbackMarker, '1');
            }
          } catch {}

          try {
            window.localStorage.removeItem(key);
            window.localStorage.setItem(key, value);
            localStorageSaved = true;
          } catch (retryError) {
            console.warn('localStorage setItem skipped; using session fallback where available:', retryError || firstError);
          }
        }
      }
    } catch (e) {
      console.warn('localStorage is unavailable; using fallback storage where available:', e);
    }

    // Mirror the latest value. Mark the session copy as authoritative if the
    // local write failed, so getItem never revives a stale localStorage value.
    if (localStorageSaved) localStorageFallbackKeys.delete(key);
    else localStorageFallbackKeys.add(key);

    try {
      if (typeof window !== 'undefined' && window.sessionStorage) {
        window.sessionStorage.setItem(key, value);
        if (localStorageSaved) {
          window.sessionStorage.removeItem(fallbackMarker);
        } else {
          window.sessionStorage.setItem(fallbackMarker, '1');
        }
      }
    } catch (e) {
      if (!localStorageSaved) {
        console.warn('Session fallback storage write failed:', e);
      }
    }
  },

  getJSON<T>(key: string, defaultValue: T | null = null): T | null {
    const raw = this.getItem(key, '');
    if (!raw) return defaultValue;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return defaultValue;
    }
  },

  setJSON<T>(key: string, value: T): void {
    try {
      const serialized = JSON.stringify(value);
      this.setItem(key, serialized);
    } catch (e) {
      console.warn('setJSON serialization error:', e);
    }
  },

  removeItem(key: string): void {
    memoryCache.delete(key);
    localStorageFallbackKeys.delete(key);
    const fallbackMarker = `${FALLBACK_MARKER_PREFIX}${key}`;
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.removeItem(key);
      }
    } catch {}
    try {
      if (typeof window !== 'undefined' && window.sessionStorage) {
        window.sessionStorage.removeItem(key);
        window.sessionStorage.removeItem(fallbackMarker);
      }
    } catch {}
  },
};
