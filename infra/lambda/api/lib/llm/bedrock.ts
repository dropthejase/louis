// backend/src/lib/llm/bedrock.ts
//
// Amazon Bedrock Converse API adapter.
// Implements the same interface as claude.ts: streamChatWithTools + completeText.
//
// Required at runtime:
//   AWS_REGION — set automatically by Lambda; for local dev set in .env
//   IAM permissions: bedrock:InvokeModelWithResponseStream, bedrock:InvokeModel

import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
  ConverseCommand,
  type Message,
  type Tool,
  type ContentBlock,
  type ContentBlockStart,
  type ToolInputSchema,
} from "@aws-sdk/client-bedrock-runtime";
import type { DocumentType } from "@smithy/types";
import type {
  StreamChatParams,
  StreamChatResult,
  NormalizedToolCall,
  NormalizedToolResult,
  OpenAIToolSchema,
} from "./types";

const MAX_TOKENS = 16384;

let _client: BedrockRuntimeClient | null = null;
function getClient(): BedrockRuntimeClient {
  if (!_client) _client = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "eu-west-1" });
  return _client;
}

// ---------------------------------------------------------------------------
// Tool schema conversion: OpenAI → Bedrock toolSpec
// ---------------------------------------------------------------------------

function toBedrockTools(tools: OpenAIToolSchema[]): Tool[] {
  return tools.map((t) => ({
    toolSpec: {
      name: t.function.name,
      description: t.function.description,
      inputSchema: {
        json: t.function.parameters as unknown as DocumentType,
      } as ToolInputSchema,
    },
  }));
}

// ---------------------------------------------------------------------------
// Message conversion: LlmMessage[] → Bedrock Message[]
// ---------------------------------------------------------------------------

function toBedrockMessages(
  messages: StreamChatParams["messages"],
): Message[] {
  return messages.map((m) => ({
    role: m.role as "user" | "assistant",
    content: [{ text: m.content }],
  }));
}

// ---------------------------------------------------------------------------
// streamChatWithTools
// ---------------------------------------------------------------------------

/**
 * Streaming multi-turn chat via the Bedrock Converse API with tool-call loop.
 *
 * Runs up to `maxIterations` model turns. After each turn where the model
 * requests tools, it calls `runTools` and appends the results as a user
 * message before continuing. Stops when stop_reason is not "tool_use",
 * when no tools are requested, or when the iteration cap is hit.
 *
 * @param params.runTools Callback that executes all tool calls for one turn.
 */
export async function streamBedrock(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  const {
    model,
    systemPrompt,
    tools = [],
    callbacks = {},
    runTools,
  } = params;
  const maxIter = params.maxIterations ?? 10;
  const bedrockTools = toBedrockTools(tools);

  // Bedrock messages accumulate across tool-call iterations.
  const messages: Message[] = toBedrockMessages(params.messages);
  let fullText = "";

  for (let iter = 0; iter < maxIter; iter++) {
    const command = new ConverseStreamCommand({
      modelId: model,
      system: systemPrompt ? [{ text: systemPrompt }] : undefined,
      messages,
      inferenceConfig: { maxTokens: MAX_TOKENS },
      toolConfig: bedrockTools.length
        ? { tools: bedrockTools }
        : undefined,
    });

    const response = await getClient().send(command);

    // Accumulate assistant content blocks for the follow-up message.
    const assistantBlocks: ContentBlock[] = [];
    const toolCalls: NormalizedToolCall[] = [];

    // In-flight state for the current content block.
    let currentToolId = "";
    let currentToolName = "";
    let currentToolInputAccumulator = "";
    let currentBlockIsText = false;
    let iterText = "";
    let stopReason = "end_turn";

    if (!response.stream) break;

    for await (const event of response.stream) {
      if (event.contentBlockStart) {
        const { start, contentBlockIndex: _idx } = event.contentBlockStart;
        currentBlockIsText = false;
        currentToolId = "";
        currentToolName = "";
        currentToolInputAccumulator = "";

        // start is a ContentBlockStart discriminated union
        const blockStart = start as ContentBlockStart | undefined;
        if (blockStart && "toolUse" in blockStart && blockStart.toolUse) {
          currentToolId = blockStart.toolUse.toolUseId ?? "";
          currentToolName = blockStart.toolUse.name ?? "";
        } else {
          currentBlockIsText = true;
        }
      }

      if (event.contentBlockDelta) {
        const { delta } = event.contentBlockDelta;
        if (delta && "text" in delta && typeof delta.text === "string") {
          callbacks.onContentDelta?.(delta.text);
          if (currentBlockIsText) {
            iterText += delta.text;
            fullText += delta.text;
          }
        }
        if (delta && "toolUse" in delta && delta.toolUse && "input" in delta.toolUse) {
          currentToolInputAccumulator += (delta.toolUse.input as string) ?? "";
        }
      }

      if (event.contentBlockStop) {
        if (currentToolId) {
          let parsedInput: Record<string, unknown> = {};
          try {
            parsedInput = JSON.parse(currentToolInputAccumulator || "{}");
          } catch {
            parsedInput = {};
          }
          const call: NormalizedToolCall = {
            id: currentToolId,
            name: currentToolName,
            input: parsedInput,
          };
          callbacks.onToolCallStart?.(call);
          toolCalls.push(call);
          assistantBlocks.push({
            toolUse: {
              toolUseId: currentToolId,
              name: currentToolName,
              input: parsedInput as unknown as DocumentType,
            },
          });
        } else if (iterText) {
          assistantBlocks.push({ text: iterText });
          iterText = "";
        }
      }

      if (event.messageStop) {
        stopReason = event.messageStop.stopReason ?? "end_turn";
      }
    }

    if (stopReason !== "tool_use" || !toolCalls.length || !runTools) {
      break;
    }

    // Execute tools.
    const results: NormalizedToolResult[] = await runTools(toolCalls);

    // Append assistant message with all content blocks from this turn.
    messages.push({
      role: "assistant",
      content: assistantBlocks,
    });

    // Append user message with tool results.
    messages.push({
      role: "user",
      content: results.map((r) => ({
        toolResult: {
          toolUseId: r.tool_use_id,
          content: [{ text: r.content }],
        },
      })),
    });
  }

  return { fullText };
}

// ---------------------------------------------------------------------------
// completeText (non-streaming)
// ---------------------------------------------------------------------------

/**
 * Non-streaming single-turn completion via the Bedrock Converse API.
 * Returns the model's full text response; used for lightweight tasks like
 * title generation where streaming is unnecessary.
 */
export async function completeBedrockText(params: {
  model: string;
  systemPrompt?: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  const command = new ConverseCommand({
    modelId: params.model,
    system: params.systemPrompt ? [{ text: params.systemPrompt }] : undefined,
    messages: [
      { role: "user", content: [{ text: params.user }] },
    ],
    inferenceConfig: { maxTokens: params.maxTokens ?? 512 },
  });

  const response = await getClient().send(command);
  const outputMessage = response.output?.message;
  if (!outputMessage) return "";

  return (outputMessage.content ?? [])
    .filter((b): b is ContentBlock & { text: string } => typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}
