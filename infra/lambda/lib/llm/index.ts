// backend/src/lib/llm/index.ts
//
// LLM router — all calls now go through Amazon Bedrock Converse API.
// Logical model tier names (claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5)
// are resolved to Bedrock cross-region inference profile IDs before dispatch.

import { streamBedrock, completeBedrockText } from "./bedrock";
import { resolveBedrockModelId } from "./models";
import type { StreamChatParams, StreamChatResult } from "./types";

export * from "./types";
export * from "./models";

/**
 * Run a streaming multi-turn conversation, optionally executing tool calls
 * in a loop until the model stops requesting tools or maxIterations is reached.
 * Resolves the logical model tier name to a Bedrock cross-region inference
 * profile ID before dispatching.
 */
export async function streamChatWithTools(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  const bedrockModelId = resolveBedrockModelId(params.model);
  return streamBedrock({ ...params, model: bedrockModelId });
}

/**
 * Non-streaming single-turn text completion (e.g. title generation).
 * Resolves the logical model tier name to a Bedrock profile ID before dispatch.
 */
export async function completeText(params: {
  model: string;
  systemPrompt?: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  const bedrockModelId = resolveBedrockModelId(params.model);
  return completeBedrockText({ ...params, model: bedrockModelId });
}
