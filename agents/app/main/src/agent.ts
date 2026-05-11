/**
 * AgentCore agent factory — constructs the Strands SDK Agent with all tools,
 * Bedrock model, and optional S3-backed session persistence.
 *
 * userId is always sourced from the JWT `sub` claim (validated in index.ts)
 * and is never derived from LLM input. The AfterModelCallEvent hook increments
 * DynamoDB credits after each model call; this is distinct from the backend's
 * pre-flight credit check (which runs before the request reaches the agent).
 *
 * replicate_document is only included when projectId is provided — the tool
 * makes no sense in a standalone-document context.
 */
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

async function addCredits(userId: string, tokens: number): Promise<void> {
  const month = new Date().toISOString().slice(0, 7);
  await dynamo.send(new UpdateItemCommand({
    TableName: process.env.CREDITS_TABLE_NAME!,
    Key: { userId: { S: userId }, month: { S: month } },
    UpdateExpression: 'ADD credits_used :tokens',
    ExpressionAttributeValues: { ':tokens': { N: String(tokens) } },
  }));
}

/**
 * Build and return a configured Strands Agent for a single invocation.
 *
 * @param userId Cognito sub — used for ownership checks inside tools.
 * @param docStore In-memory map of doc labels to storage metadata.
 * @param docIndex In-memory map of doc labels to DB metadata.
 * @param projectId When set, scopes the context to a project and enables replicate_document.
 * @param modelId Logical model tier name (e.g. "claude-sonnet-4-6"); defaults to mid tier.
 * @param sessionId When set, enables S3-backed conversation snapshot persistence.
 */
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
    cacheConfig: { strategy: 'auto' },
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
