/**
 * Per-user model preference loader for the backend Lambda.
 *
 * Reads the user's chosen tabular model from user_profiles and falls back to
 * the system defaults for any unset fields. title_model is always the system
 * default (not user-configurable).
 */
import { queryOne } from "./db";
import { resolveModel, DEFAULT_TITLE_MODEL, DEFAULT_TABULAR_MODEL } from "./llm";

export type UserModelSettings = {
  title_model: string;
  tabular_model: string;
};

/**
 * Load model preferences for a user.
 * Falls back to system defaults when userId is omitted or no profile row exists.
 *
 * @returns `title_model` — always the system default (claude-haiku-4-5).
 * @returns `tabular_model` — user-configured model, or the system default.
 */
export async function getUserModelSettings(
  userId?: string,
): Promise<UserModelSettings> {
  if (userId) {
    const data = await queryOne<{ tabular_model: string | null }>(
      `SELECT tabular_model FROM user_profiles WHERE user_id = :userId`,
      [{ name: "userId", value: { stringValue: userId } }],
    );
    return {
      title_model: DEFAULT_TITLE_MODEL,
      tabular_model: resolveModel(data?.tabular_model, DEFAULT_TABULAR_MODEL),
    };
  }
  return { title_model: DEFAULT_TITLE_MODEL, tabular_model: DEFAULT_TABULAR_MODEL };
}
