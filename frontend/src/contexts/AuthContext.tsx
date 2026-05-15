import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
} from 'react';
import type { ReactNode } from 'react';
import { fetchAuthSession, signOut as amplifySignOut } from 'aws-amplify/auth';
import { useAuthenticator } from '@aws-amplify/ui-react';
import { API_URL } from '@/lib/aws/config';

interface User {
  id: string;
  email: string;
}

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  authLoading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { authStatus } = useAuthenticator((context) => [context.authStatus]);
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  const ensureProfile = useCallback(async (idToken: string) => {
    await fetch(`${API_URL}/user/profile`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}` },
    }).catch((e) => console.log('[AuthContext] ensureProfile error:', e));
  }, []);

  const loadUser = useCallback(async () => {
    try {
      const session = await fetchAuthSession();
      const idToken = session.tokens?.idToken;
      if (!idToken) {
        setUser(null);
        setAuthLoading(false);
        return;
      }
      const payload = idToken.payload;
      const id = payload.sub as string;
      const email = (payload.email as string) ?? '';
      setUser({ id, email });
      void ensureProfile(idToken.toString());
    } catch {
      setUser(null);
    } finally {
      setAuthLoading(false);
    }
  }, [ensureProfile]);

  useEffect(() => {
    if (authStatus === 'authenticated') {
      void loadUser();
    } else if (authStatus === 'unauthenticated') {
      setUser(null);
      setAuthLoading(false);
    }
  }, [authStatus, loadUser]);

  const signOut = async () => {
    await amplifySignOut();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, isAuthenticated: !!user, authLoading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
