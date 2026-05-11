import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import type { AwsCredentialIdentity } from '@smithy/types';
import { Hub } from 'aws-amplify/utils';
import { getIdentityPoolCredentials, clearCredentialCache } from '@/lib/aws/credentials';
import { getIdToken } from '@/lib/aws/amplify-auth';

// Storage is configured in App.tsx via amplifyConfig — no per-call setup needed.

interface AwsContextType {
  credentials: AwsCredentialIdentity | null;
  getCredentials: () => Promise<AwsCredentialIdentity>;
  awsLoading: boolean;
}

const AwsContext = createContext<AwsContextType | undefined>(undefined);

export function AwsProvider({ children }: { children: ReactNode }) {
  const [credentials, setCredentials] = useState<AwsCredentialIdentity | null>(null);
  const [awsLoading, setAwsLoading] = useState(true);
  const jwtRef = useRef<string | null>(null);

  const getCredentials = useCallback(async (): Promise<AwsCredentialIdentity> => {
    const jwt = jwtRef.current;
    if (!jwt) throw new Error('Not authenticated — no Cognito id token');
    const creds = await getIdentityPoolCredentials(jwt);
    setCredentials(creds);
    return creds;
  }, []);

  const bootstrap = useCallback(async () => {
    try {
      const jwt = await getIdToken().catch(() => null);
      if (!jwt) {
        jwtRef.current = null;
        clearCredentialCache();
        setCredentials(null);
        setAwsLoading(false);
        return;
      }
      jwtRef.current = jwt;
      const creds = await getIdentityPoolCredentials(jwt);
      setCredentials(creds);
    } catch (e) {
      console.error('AwsContext: credential exchange failed', e);
    } finally {
      setAwsLoading(false);
    }
  }, []);

  useEffect(() => {
    void bootstrap();

    const unsubscribe = Hub.listen('auth', ({ payload }) => {
      if (payload.event === 'signedIn' || payload.event === 'tokenRefresh') {
        void bootstrap();
      }
      if (payload.event === 'signedOut') {
        jwtRef.current = null;
        clearCredentialCache();
        setCredentials(null);
        setAwsLoading(false);
      }
    });

    return unsubscribe;
  }, [bootstrap]);

  return (
    <AwsContext.Provider value={{ credentials, getCredentials, awsLoading }}>
      {children}
    </AwsContext.Provider>
  );
}

export function useAws(): AwsContextType {
  const ctx = useContext(AwsContext);
  if (!ctx) throw new Error('useAws must be used within AwsProvider');
  return ctx;
}
