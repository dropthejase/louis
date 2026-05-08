"use client";

import React, {
    createContext,
    useContext,
    useEffect,
    useState,
    ReactNode,
    useCallback,
} from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";

interface UserProfile {
    displayName: string | null;
    organisation: string | null;
    tabularModel: string;
}

interface UserProfileContextType {
    profile: UserProfile | null;
    loading: boolean;
    updateDisplayName: (name: string) => Promise<boolean>;
    updateOrganisation: (organisation: string) => Promise<boolean>;
    updateTabularModel: (modelId: string) => Promise<boolean>;
    reloadProfile: () => Promise<void>;
}

const UserProfileContext = createContext<UserProfileContextType | undefined>(
    undefined,
);

const DEFAULT_TABULAR_MODEL = "claude-sonnet-4-6";

export function UserProfileProvider({ children }: { children: ReactNode }) {
    const { user, isAuthenticated } = useAuth();
    const [profile, setProfile] = useState<UserProfile | null>(null);
    const [loading, setLoading] = useState(true);

    const loadProfile = useCallback(async (userId: string) => {
        try {
            const { data } = await supabase
                .from("user_profiles")
                .select("display_name, organisation, tabular_model")
                .eq("user_id", userId)
                .single();

            setProfile({
                displayName: data?.display_name ?? null,
                organisation: data?.organisation ?? null,
                tabularModel: data?.tabular_model ?? DEFAULT_TABULAR_MODEL,
            });
        } catch {
            setProfile({
                displayName: null,
                organisation: null,
                tabularModel: DEFAULT_TABULAR_MODEL,
            });
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (isAuthenticated && user) {
            setLoading(true);
            loadProfile(user.id);
        } else {
            setProfile(null);
            setLoading(false);
        }
    }, [isAuthenticated, user, loadProfile]);

    const updateDisplayName = useCallback(
        async (displayName: string): Promise<boolean> => {
            if (!user) return false;
            try {
                const { error } = await supabase
                    .from("user_profiles")
                    .update({
                        display_name: displayName,
                        updated_at: new Date().toISOString(),
                    })
                    .eq("user_id", user.id);
                if (error) throw error;
                setProfile((prev) => (prev ? { ...prev, displayName } : null));
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updateOrganisation = useCallback(
        async (organisation: string): Promise<boolean> => {
            if (!user) return false;
            try {
                const { error } = await supabase
                    .from("user_profiles")
                    .update({
                        organisation,
                        updated_at: new Date().toISOString(),
                    })
                    .eq("user_id", user.id);
                if (error) throw error;
                setProfile((prev) =>
                    prev ? { ...prev, organisation } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const updateTabularModel = useCallback(
        async (tabularModel: string): Promise<boolean> => {
            if (!user) return false;
            try {
                const { error } = await supabase
                    .from("user_profiles")
                    .update({
                        tabular_model: tabularModel,
                        updated_at: new Date().toISOString(),
                    })
                    .eq("user_id", user.id);
                if (error) throw error;
                setProfile((prev) =>
                    prev ? { ...prev, tabularModel } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [user],
    );

    const reloadProfile = useCallback(async () => {
        if (user) await loadProfile(user.id);
    }, [user, loadProfile]);

    return (
        <UserProfileContext.Provider
            value={{
                profile,
                loading,
                updateDisplayName,
                updateOrganisation,
                updateTabularModel,
                reloadProfile,
            }}
        >
            {children}
        </UserProfileContext.Provider>
    );
}

export function useUserProfile() {
    const context = useContext(UserProfileContext);
    if (context === undefined) {
        throw new Error(
            "useUserProfile must be used within a UserProfileProvider",
        );
    }
    return context;
}
