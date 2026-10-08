import { useCallback, useState } from 'react';
import { MainApp } from './components/MainApp.tsx';
import { AuthGate } from './components/AuthGate.tsx';
import { clearSession, PlatformUser } from './services/authService.ts';

export default function App() {
  const [currentUser, setCurrentUser] = useState<PlatformUser | null>(null);

  const handleAuthenticated = useCallback((user: PlatformUser) => {
    setCurrentUser(user);
  }, []);

  const handleLogout = useCallback(() => {
    clearSession();
    setCurrentUser(null);
  }, []);

  if (!currentUser) {
    return <AuthGate onAuthenticated={handleAuthenticated} />;
  }

  return <MainApp user={currentUser} onLogout={handleLogout} />;
}
