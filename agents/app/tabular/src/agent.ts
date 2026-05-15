import { Agent, BedrockModel, AfterModelCallEvent, AfterInvocationEvent } from '@strands-agents/sdk';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import type { MessageData } from '@strands-agents/sdk';
import { makeReadTableCellsTool } from './tools/read-table-cells';

const BEDROCK_MODEL_IDS: Record<string, string> = {
  'claude-opus-4-7':   'eu.anthropic.claude-opus-4-7',
  'claude-sonnet-4-6': 'eu.anthropic.claude-sonnet-4-6',
  'claude-haiku-4-5':  'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
};
const DEFAULT_BEDROCK_MODEL_ID = BEDROCK_MODEL_IDS['claude-sonnet-4-6'];

function resolveBedrockModelId(logicalModel?: string): string {
  return BEDROCK_MODEL_IDS[logicalModel ?? ''] ?? DEFAULT_BEDROCK_MODEL_ID;
}

const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'eu-west-1' });
const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'eu-west-1' });

const SESSIONS_BUCKET = process.env.SESSIONS_BUCKET_NAME!;

function conversationKey(chatId: string): string {
  return `conversations/${chatId}/messages.json`;
}

export async function loadMessages(chatId: string): Promise<MessageData[]> {
  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: SESSIONS_BUCKET,
      Key: conversationKey(chatId),
    }));
    const body = await res.Body?.transformToString();
    return body ? JSON.parse(body) as MessageData[] : [];
  } catch {
    return [];
  }
}

async function addCredits(userId: string, tokens: number): Promise<void> {
  const month = new Date().toISOString().slice(0, 7);
  await dynamo.send(new UpdateItemCommand({
    TableName: process.env.CREDITS_TABLE_NAME!,
    Key: { userId: { S: userId }, month: { S: month } },
    UpdateExpression: 'ADD credits_used :tokens',
    ExpressionAttributeValues: { ':tokens': { N: String(tokens) } },
  }));
}

export function createAgent(
  userId: string,
  chatId: string,
  previousMessages: MessageData[],
  systemPrompt: string,
  modelId?: string,
): Agent {
  const model = new BedrockModel({
    modelId: resolveBedrockModelId(modelId),
    region: process.env.AWS_REGION ?? 'eu-west-1',
    cacheConfig: { strategy: 'auto' },
    additionalRequestFields: {
      thinking: { type: 'enabled', budget_tokens: 4096 },
    },
  });

  const agent = new Agent({
    model,
    systemPrompt,
    tools: [makeReadTableCellsTool(userId)],
    messages: previousMessages,
    printer: false,
  });

  agent.addHook(AfterInvocationEvent, async () => {
    try {
      await s3.send(new PutObjectCommand({
        Bucket: SESSIONS_BUCKET,
        Key: conversationKey(chatId),
        Body: JSON.stringify(agent.messages),
        ContentType: 'application/json',
      }));
    } catch (err) {
      console.error('[session] failed to save messages:', err);
    }
  });

  agent.addHook(AfterModelCallEvent, async (event) => {
    const tokens = event.stopData?.message?.metadata?.usage?.totalTokens;
    if (!tokens) return;
    try {
      await addCredits(userId, tokens);
    } catch (err) {
      console.error('[credits] failed to add:', err);
    }
  });

  return agent;
}
