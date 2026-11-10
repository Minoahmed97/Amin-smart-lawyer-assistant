import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.ameenlegal.assistant',
  appName: 'Ameen Legal',
  webDir: 'dist',
  // Keep the existing authenticated Vercel application and its /api routes
  // as the single source of truth while the Android shell is introduced.
  server: {
    url: 'https://amin-smart-lawyer-assistant.vercel.app',
    cleartext: false,
    allowNavigation: ['amin-smart-lawyer-assistant.vercel.app'],
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
