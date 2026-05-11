import { Agent, BedrockModel, AfterModelCallEvent } from '@strands-agents/sdk';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { makeReadTableCellsTool } from './tools/read-table-cells';

const BEDROCK_MODEL_IDS: Record<string, string> = {
  'claude-opus-4-7':   'eu.anthropic.claude-opus-4-7-20251101-v1:0',
  'claude-sonnet-4-6': 'eu.anthropic.claude-sonnet-4-6-20250922-v1:0',
  'claude-haiku-4-5':  'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
};
const DEFAULT_BEDROCK_MODEL_ID = BEDROCK_MODEL_IDS['claude-sonnet-4-6'];

function resolveBedrockModelId(logicalModel?: string): string {
  return BEDROCK_MODEL_IDS[logicalModel ?? ''] ?? DEFAULT_BEDROCK_MODEL_ID;
}

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION ?? 'eu-west-1' });

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
  systemPrompt: string,
  modelId?: string,
): Agent {
  const model = new BedrockModel({
    modelId: resolveBedrockModelId(modelId),
    region: process.env.AWS_REGION ?? 'eu-west-1',
  });

  const agent = new Agent({
    model,
    systemPrompt,
    tools: [makeReadTableCellsTool(userId)],
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
