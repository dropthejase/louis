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
import { Hub } from "aws-amplify/utils";
import {
  getIdentityPoolCredentials,
  clearCredentialCache,
} from "@/lib/aws/credentials";
import { configureAmplifyStorage } from "@/lib/aws/storage";
import { getIdToken, ensureAmplifyConfigured } from "@/lib/aws/amplify-auth";

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

  const jwtRef = useRef<string | null>(null);

  const getCredentials = useCallback(async (): Promise<AwsCredentialIdentity> => {
    const jwt = jwtRef.current;
    if (!jwt) throw new Error("Not authenticated — no Cognito id token");
    const creds = await getIdentityPoolCredentials(jwt);
    setCredentials(creds);
    return creds;
  }, []);

  useEffect(() => {
    configureAmplifyStorage(getCredentials);
  }, [getCredentials]);

  const bootstrap = useCallback(async () => {
    try {
      ensureAmplifyConfigured();
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
      console.error("AwsContext: credential exchange failed", e);
    } finally {
      setAwsLoading(false);
    }
  }, []);

  useEffect(() => {
    bootstrap();

    const unsubscribe = Hub.listen("auth", ({ payload }) => {
      if (payload.event === "signedIn" || payload.event === "tokenRefresh") {
        void bootstrap();
      }
      if (payload.event === "signedOut") {
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
  if (!ctx) throw new Error("useAws must be used within AwsProvider");
  return ctx;
}
