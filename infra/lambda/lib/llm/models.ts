// backend/src/lib/llm/models.ts
//
// Bedrock model IDs for eu-west-1 (cross-region inference profile IDs).
// Gemini references removed — all LLM calls now go through Bedrock.

// ---------------------------------------------------------------------------
// Bedrock model ID constants
// ---------------------------------------------------------------------------

export const BEDROCK_HIGH_MODEL =
  "eu.anthropic.claude-opus-4-7-20251101-v1:0";

export const BEDROCK_MID_MODEL =
  "eu.anthropic.claude-sonnet-4-6-20250922-v1:0";

export const BEDROCK_LOW_MODEL =
  "eu.anthropic.claude-haiku-4-5-20251001-v1:0";

// ---------------------------------------------------------------------------
// Public-facing model tier names (used in DB records + frontend settings).
// These are the logical tiers callers pass to streamChatWithTools().
// Mapping to Bedrock IDs happens in resolveBedrockModelId() below.
// ---------------------------------------------------------------------------

// High tier — interactive chat (main model)
export const CLAUDE_MAIN_MODELS = ["claude-opus-4-7", "claude-sonnet-4-6"] as const;

// Mid tier — tabular review, bulk jobs
export const CLAUDE_MID_MODELS = ["claude-sonnet-4-6"] as const;

// Low tier — title generation, lightweight extraction
export const CLAUDE_LOW_MODELS = ["claude-haiku-4-5"] as const;

export const DEFAULT_MAIN_MODEL = "claude-sonnet-4-6";
export const DEFAULT_TITLE_MODEL = "claude-haiku-4-5";
export const DEFAULT_TABULAR_MODEL = "claude-sonnet-4-6";

const ALL_LOGICAL_MODELS = new Set<string>([
  ...CLAUDE_MAIN_MODELS,
  ...CLAUDE_MID_MODELS,
  ...CLAUDE_LOW_MODELS,
]);

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

/**
 * Maps a logical model tier name (as stored in DB / sent by frontend) to the
 * concrete Bedrock cross-region inference profile ID for eu-west-1.
 */
export function resolveBedrockModelId(logicalModel: string): string {
  switch (logicalModel) {
    case "claude-opus-4-7":
      return BEDROCK_HIGH_MODEL;
    case "claude-sonnet-4-6":
      return BEDROCK_MID_MODEL;
    case "claude-haiku-4-5":
      return BEDROCK_LOW_MODEL;
    default:
      // Unknown model — default to mid tier.
      return BEDROCK_MID_MODEL;
  }
}

/**
 * Return `id` if it is a known logical model name, otherwise return `fallback`.
 * Used to sanitise user-supplied model preferences from the database.
 */
export function resolveModel(
  id: string | null | undefined,
  fallback: string,
): string {
  if (id && ALL_LOGICAL_MODELS.has(id)) return id;
  return fallback;
}
