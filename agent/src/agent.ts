import { Agent, BedrockModel, SessionManager, AfterModelCallEvent } from '@strands-agents/sdk';
import { S3Storage } from '@strands-agents/sdk/dist/src/session/s3-storage.js';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { DocStore, DocIndex } from './lib/doc-context';
import { SYSTEM_PROMPT } from './system-prompt';
import { makeReadDocumentTool } from './tools/read-document';
import { makeFindInDocumentTool } from './tools/find-in-document';
import { makeListDocumentsTool } from './tools/list-documents';
import { makeFetchDocumentsTool } from './tools/fetch-documents';
import { makeGenerateDocxTool } from './tools/generate-docx';
import { makeEditDocumentTool } from './tools/edit-document';
import { makeReplicateDocumentTool } from './tools/replicate-document';
import { makeReadTableCellsTool } from './tools/read-table-cells';
import { makeListWorkflowsTool } from './tools/list-workflows';
import { makeReadWorkflowTool } from './tools/read-workflow';

// Validated Bedrock cross-region inference profile IDs for eu-west-1.
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

async function incrementCredits(userId: string): Promise<void> {
  const month = new Date().toISOString().slice(0, 7);
  await dynamo.send(new UpdateItemCommand({
    TableName: process.env.CREDITS_TABLE_NAME!,
    Key: { userId: { S: userId }, month: { S: month } },
    UpdateExpression: 'ADD credits_used :one',
    ExpressionAttributeValues: { ':one': { N: '1' } },
  }));
}

export function createAgent(
  userId: string,
  docStore: DocStore,
  docIndex: DocIndex,
  projectId?: string,
  modelId?: string,
  sessionId?: string,
): Agent {
  const model = new BedrockModel({
    modelId: resolveBedrockModelId(modelId),
    region: process.env.AWS_REGION ?? 'eu-west-1',
  });

  const tools = [
    makeReadDocumentTool(docStore),
    makeFindInDocumentTool(docStore),
    makeListDocumentsTool(docIndex),
    makeFetchDocumentsTool(docStore),
    makeGenerateDocxTool(userId, docStore, docIndex),
    makeEditDocumentTool(userId, docStore, docIndex),
    makeReadTableCellsTool(userId),
    makeListWorkflowsTool(userId),
    makeReadWorkflowTool(userId),
    ...(projectId ? [makeReplicateDocumentTool(userId, docStore, docIndex)] : []),
  ];

  let sessionManager: SessionManager | undefined;
  if (sessionId) {
    const storage = new S3Storage({
      bucket: process.env.SESSIONS_BUCKET_NAME!,
      prefix: 'sessions',
      s3Client: new S3Client({ region: process.env.AWS_REGION ?? 'eu-west-1' }),
    });
    sessionManager = new SessionManager({
      storage: { snapshot: storage },
      sessionId,
    });
  }

  const agent = new Agent({ model, systemPrompt: SYSTEM_PROMPT, tools, sessionManager });

  agent.addHook(AfterModelCallEvent, async () => {
    try {
      await incrementCredits(userId);
    } catch (err) {
      console.error('[credits] failed to increment:', err);
    }
  });

  return agent;
}
