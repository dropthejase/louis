import { createServerSupabase } from "./supabase";
import { resolveModel, DEFAULT_TITLE_MODEL, DEFAULT_TABULAR_MODEL } from "./llm";

export type UserModelSettings = {
    title_model: string;
    tabular_model: string;
};

export async function getUserModelSettings(
    userId?: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserModelSettings> {
    if (userId) {
        const client = db ?? createServerSupabase();
        const { data } = await client
            .from("user_profiles")
            .select("tabular_model")
            .eq("user_id", userId)
            .single();
        return {
            title_model: DEFAULT_TITLE_MODEL,
            tabular_model: resolveModel(data?.tabular_model, DEFAULT_TABULAR_MODEL),
        };
    }
    return {
        title_model: DEFAULT_TITLE_MODEL,
        tabular_model: DEFAULT_TABULAR_MODEL,
    };
}
