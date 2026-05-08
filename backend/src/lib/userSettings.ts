import { DEFAULT_TITLE_MODEL, DEFAULT_TABULAR_MODEL } from "./llm";

export type UserModelSettings = {
    title_model: string;
    tabular_model: string;
};

export async function getUserModelSettings(): Promise<UserModelSettings> {
    return {
        title_model: DEFAULT_TITLE_MODEL,
        tabular_model: DEFAULT_TABULAR_MODEL,
    };
}
