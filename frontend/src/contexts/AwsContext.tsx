"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import type { AwsCredentialIdentity } from "@smithy/types";
import { supabase } from "@/lib/supabase";
import {
  getIdentityPoolCredentials,
  clearCredentialCache,
  configureAmplifyStorage,
} from "@/lib/aws";

interface AwsContextType {
  /** Current IAM credentials, or null while loading / not signed in. */
  credentials: AwsCredentialIdentity | null;
  /**
   * Returns fresh credentials, refreshing from Cognito if within 5 min of
   * expiry. Throws if the user is not signed in.
   */
  getCredentials: () => Promise<AwsCredentialIdentity>;
  /** True while the initial credential exchange is in flight. */
  awsLoading: boolean;
}

const AwsContext = createContext<AwsContextType | undefined>(undefined);

export function AwsProvider({ children }: { children: ReactNode }) {
  const [credentials, setCredentials] = useState<AwsCredentialIdentity | null>(
    null,
  );
  const [awsLoading, setAwsLoading] = useState(true);

  // Stable ref so that getCredentials always uses the latest JWT without
  // needing the caller to re-subscribe to context changes.
  const jwtRef = useRef<string | null>(null);

  const getCredentials = useCallback(async (): Promise<AwsCredentialIdentity> => {
    const jwt = jwtRef.current;
    if (!jwt) throw new Error("Not authenticated — no Supabase session");
    const creds = await getIdentityPoolCredentials(jwt);
    setCredentials(creds);
    return creds;
  }, []);

  useEffect(() => {
    // Amplify Storage only needs to be configured once — pass getCredentials
    // as the provider so it always uses the current (cached) creds.
    configureAmplifyStorage(getCredentials);
  }, [getCredentials]);

  useEffect(() => {
    let mounted = true;

    const bootstrap = async (jwt: string | null) => {
      if (!jwt) {
        jwtRef.current = null;
        clearCredentialCache();
        setCredentials(null);
        setAwsLoading(false);
        return;
      }
      jwtRef.current = jwt;
      try {
        const creds = await getIdentityPoolCredentials(jwt);
        if (mounted) setCredentials(creds);
      } catch (e) {
        console.error("AwsContext: credential exchange failed", e);
      } finally {
        if (mounted) setAwsLoading(false);
      }
    };

    // Initialise from current session
    supabase.auth.getSession().then(({ data: { session } }) => {
      bootstrap(session?.access_token ?? null);
    });

    // Re-exchange whenever the Supabase session changes (new login, token refresh)
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      bootstrap(session?.access_token ?? null);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  return (
    <AwsContext.Provider value={{ credentials, getCredentials, awsLoading }}>
      {children}
    </AwsContext.Provider>
  );
}

export function useAws(): AwsContextType {
  const ctx = useContext(AwsContext);
  if (!ctx) throw new Error("useAws must be used within AwsProvider");
  return ctx;
}
