
import React, {
    createContext,
    useContext,
    useEffect,
    useState,
    useCallback,
} from "react";
import type { ReactNode } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { apiRequest } from "@/app/lib/mikeApi";

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
    const { isAuthenticated } = useAuth();
    const [profile, setProfile] = useState<UserProfile | null>(null);
    const [loading, setLoading] = useState(true);

    const loadProfile = useCallback(async () => {
        try {
            const data = await apiRequest<{
                display_name: string | null;
                organisation: string | null;
                tabular_model: string | null;
            }>("/user/profile");
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
        if (isAuthenticated) {
            setLoading(true);
            loadProfile();
        } else {
            setProfile(null);
            setLoading(false);
        }
    }, [isAuthenticated, loadProfile]);

    const updateDisplayName = useCallback(
        async (displayName: string): Promise<boolean> => {
            try {
                await apiRequest("/user/profile", {
                    method: "PUT",
                    body: JSON.stringify({ display_name: displayName }),
                });
                setProfile((prev) => (prev ? { ...prev, displayName } : null));
                return true;
            } catch {
                return false;
            }
        },
        [],
    );

    const updateOrganisation = useCallback(
        async (organisation: string): Promise<boolean> => {
            try {
                await apiRequest("/user/profile", {
                    method: "PUT",
                    body: JSON.stringify({ organisation }),
                });
                setProfile((prev) =>
                    prev ? { ...prev, organisation } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [],
    );

    const updateTabularModel = useCallback(
        async (tabularModel: string): Promise<boolean> => {
            try {
                await apiRequest("/user/profile", {
                    method: "PUT",
                    body: JSON.stringify({ tabular_model: tabularModel }),
                });
                setProfile((prev) =>
                    prev ? { ...prev, tabularModel } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [],
    );

    const reloadProfile = useCallback(async () => {
        await loadProfile();
    }, [loadProfile]);

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
