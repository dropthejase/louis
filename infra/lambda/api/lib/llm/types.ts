/**
 * Shared type definitions for the LLM abstraction layer.
 *
 * All callers use these types when calling streamChatWithTools or completeText;
 * the Bedrock-specific wire format is handled internally in bedrock.ts.
 */
// backend/src/lib/llm/types.ts

export type Provider = "claude"; // Gemini removed — all calls go through Bedrock

export type OpenAIToolSchema = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type LlmMessage = {
  role: "user" | "assistant";
  content: string;
};

export type NormalizedToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type NormalizedToolResult = {
  tool_use_id: string;
  content: string;
};

export type StreamCallbacks = {
  onReasoningDelta?: (text: string) => void;
  onReasoningBlockEnd?: () => void;
  onContentDelta?: (text: string) => void;
  onToolCallStart?: (call: NormalizedToolCall) => void;
};

export type StreamChatParams = {
  model: string;
  systemPrompt: string;
  messages: LlmMessage[];
  tools?: OpenAIToolSchema[];
  maxIterations?: number;
  callbacks?: StreamCallbacks;
  runTools?: (calls: NormalizedToolCall[]) => Promise<NormalizedToolResult[]>;
  enableThinking?: boolean;
};

export type StreamChatResult = {
  fullText: string;
};
