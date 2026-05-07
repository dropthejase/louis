"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  ReactNode,
} from "react";
import { fetchAuthSession, signOut as amplifySignOut } from "aws-amplify/auth";
import { ensureAmplifyConfigured } from "@/lib/aws/amplify-auth";
import { API_URL } from "@/lib/aws/config";

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
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  const ensureProfile = useCallback(async (idToken: string) => {
    await fetch(`${API_URL}/user/profile`, {
      method: "POST",
      headers: { Authorization: `Bearer ${idToken}` },
    }).catch((e) => console.log("[AuthContext] ensureProfile error:", e));
  }, []);

  const loadUser = useCallback(async () => {
    try {
      ensureAmplifyConfigured();
      const session = await fetchAuthSession();
      const idToken = session.tokens?.idToken;
      if (!idToken) {
        setUser(null);
        setAuthLoading(false);
        return;
      }
      const payload = idToken.payload;
      const id = payload.sub as string;
      const email = (payload.email as string) ?? "";
      setUser({ id, email });
      void ensureProfile(idToken.toString());
    } catch {
      setUser(null);
    } finally {
      setAuthLoading(false);
    }
  }, [ensureProfile]);

  useEffect(() => {
    loadUser();
    const onFocus = () => void loadUser();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadUser]);

  const signOut = async () => {
    await amplifySignOut();
    setUser(null);
  };

  return (
    <AuthContext.Provider
      value={{ user, isAuthenticated: !!user, authLoading, signOut }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
