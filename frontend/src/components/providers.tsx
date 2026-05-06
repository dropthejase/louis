"use client";

import { AuthProvider } from "@/contexts/AuthContext";
import { UserProfileProvider } from "@/contexts/UserProfileContext";
import { AwsProvider } from "@/contexts/AwsContext";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <AwsProvider>
        <UserProfileProvider>{children}</UserProfileProvider>
      </AwsProvider>
    </AuthProvider>
  );
}
