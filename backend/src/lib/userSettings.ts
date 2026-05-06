import { createServerSupabase } from "./supabase";
import {
    resolveModel,
    DEFAULT_TITLE_MODEL,
    DEFAULT_TABULAR_MODEL,
    type UserApiKeys,
} from "./llm";

export type UserModelSettings = {
    title_model: string;
    tabular_model: string;
    api_keys: UserApiKeys;
};

// All LLM calls go through Bedrock — no user API keys needed for routing.
// DEFAULT_TITLE_MODEL is always used for title generation.
function resolveTitleModel(_apiKeys: UserApiKeys): string {
    return DEFAULT_TITLE_MODEL;
}

export async function getUserModelSettings(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserModelSettings> {
    const client = db ?? createServerSupabase();
    const { data } = await client
        .from("user_profiles")
        .select("tabular_model, claude_api_key")
        .eq("user_id", userId)
        .single();

    const api_keys: UserApiKeys = {
        claude: data?.claude_api_key ?? null,
    };

    return {
        title_model: resolveTitleModel(api_keys),
        tabular_model: resolveModel(data?.tabular_model, DEFAULT_TABULAR_MODEL),
        api_keys,
    };
}

export async function getUserApiKeys(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UserApiKeys> {
    const client = db ?? createServerSupabase();
    const { data } = await client
        .from("user_profiles")
        .select("claude_api_key")
        .eq("user_id", userId)
        .single();
    return {
        claude: data?.claude_api_key ?? null,
    };
}
