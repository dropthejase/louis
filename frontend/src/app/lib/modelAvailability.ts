import { MODELS, type ModelOption } from "../components/assistant/ModelToggle";

export type ModelProvider = "claude" | "gemini";

export function getModelLabel(modelId: string): string {
    return MODELS.find((m) => m.id === modelId)?.label ?? modelId;
}

// ---------------------------------------------------------------------------
// Compatibility shims — all models always available via Bedrock IAM.
// These functions are kept to avoid modifying callers (ChatInput, TRChatPanel,
// TabularReviewView, ApiKeyMissingModal). They always return "available".
// ---------------------------------------------------------------------------

export function getModelProvider(_modelId: string): ModelProvider | null {
    return "claude";
}

export function isModelAvailable(
    _modelId: string,
    _apiKeys: { claudeApiKey: string | null; geminiApiKey: string | null },
): boolean {
    return true;
}

export function isProviderAvailable(
    _provider: ModelProvider,
    _apiKeys: { claudeApiKey: string | null; geminiApiKey: string | null },
): boolean {
    return true;
}

export function providerLabel(_provider: ModelProvider): string {
    return "Anthropic (via Bedrock)";
}

export function modelGroupToProvider(
    _group: ModelOption["group"],
): ModelProvider {
    return "claude";
}
