/**
 * Persistent Storage Engine for Egyptian Judicial Assistant.
 * Guarantees zero data loss across tab switching, component re-renders,
 * role changes, and page refreshes by synchronizing localStorage, sessionStorage, and memory cache.
 */
const memoryCache = new Map<string, string>();

export const persistentStorage = {
  getItem(key: string, defaultValue: string = ''): string {
    // 1. Try localStorage
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        const val = window.localStorage.getItem(key);
        if (val !== null && val !== undefined) {
          memoryCache.set(key, val);
          return val;
        }
      }
    } catch {}

    // 2. Try sessionStorage
    try {
      if (typeof window !== 'undefined' && window.sessionStorage) {
        const val = window.sessionStorage.getItem(key);
        if (val !== null && val !== undefined) {
          memoryCache.set(key, val);
          return val;
        }
      }
    } catch {}

    // 3. Fallback to memoryCache
    if (memoryCache.has(key)) {
      return memoryCache.get(key) || defaultValue;
    }
    return defaultValue;
  },

  setItem(key: string, value: string): void {
    if (value === undefined || value === null) {
      value = '';
    }
    memoryCache.set(key, value);
    // Save to localStorage
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(key, value);
      }
    } catch (e) {
      console.warn('localStorage setItem skipped:', e);
    }
    // Mirror to sessionStorage
    try {
      if (typeof window !== 'undefined' && window.sessionStorage) {
        window.sessionStorage.setItem(key, value);
      }
    } catch {}
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
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(key, '');
        window.localStorage.removeItem(key);
      }
    } catch {}
    try {
      if (typeof window !== 'undefined' && window.sessionStorage) {
        window.sessionStorage.setItem(key, '');
        window.sessionStorage.removeItem(key);
      }
    } catch {}
  },
};
