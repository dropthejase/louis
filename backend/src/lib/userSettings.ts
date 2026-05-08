import { queryOne } from "./db";
import { resolveModel, DEFAULT_TITLE_MODEL, DEFAULT_TABULAR_MODEL } from "./llm";

export type UserModelSettings = {
  title_model: string;
  tabular_model: string;
};

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
