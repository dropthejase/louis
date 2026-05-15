/**
 * Loads and caches the admin-managed MCP server config from S3.
 *
 * Config is read once per container cold start (module-level cache). Only
 * HTTP (StreamableHTTP) transport is supported — stdio and SSE are excluded.
 * Admin uploads mcp.json to the admin config bucket; if absent or
 * malformed the agent starts with no MCP servers.
 *
 * Optional per-server auth: set "authSecretName" to a Secrets Manager secret
 * under the louis/mcp/* prefix. The secret value is used as a Bearer token.
 *
 * buildMcpClients() returns only servers NOT in the user's disabledServerIds.
 */
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { McpClient } from '@strands-agents/sdk';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'eu-west-1' });
const secretsManager = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'eu-west-1' });
const ADMIN_CONFIG_BUCKET = process.env.ADMIN_BUCKET_NAME;
const MCP_CONFIG_KEY = 'mcp.json';

export interface McpServerConfig {
  id: string;
  url: string;
  authSecretName?: string;
}

interface McpJson {
  mcpServers: Record<string, { url: string; authSecretName?: string }>;
}

// Module-level cache — populated on first call, reused for container lifetime.
let cachedServers: McpServerConfig[] | null = null;

async function loadServerConfigs(): Promise<McpServerConfig[]> {
  if (cachedServers !== null) return cachedServers;
  if (!ADMIN_CONFIG_BUCKET) {
    cachedServers = [];
    return cachedServers;
  }
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: ADMIN_CONFIG_BUCKET, Key: MCP_CONFIG_KEY }));
    const body = await res.Body?.transformToString();
    if (!body) { cachedServers = []; return cachedServers; }
    const parsed = JSON.parse(body) as McpJson;
    cachedServers = parsed.mcpServers
      ? Object.entries(parsed.mcpServers).map(([id, cfg]) => ({ id, url: cfg.url, authSecretName: cfg.authSecretName }))
      : [];
  } catch (err) {
    console.warn('[mcp] failed to load mcp.json — no MCP servers will be available:', err);
    cachedServers = [];
  }
  return cachedServers;
}

async function resolveAuthHeader(secretName: string): Promise<string | undefined> {
  try {
    const res = await secretsManager.send(new GetSecretValueCommand({ SecretId: secretName }));
    const value = res.SecretString;
    if (!value) return undefined;
    return `Bearer ${value}`;
  } catch (err) {
    console.warn(`[mcp] failed to fetch secret ${secretName}:`, err);
    return undefined;
  }
}

export async function buildMcpClients(disabledServerIds: string[]): Promise<McpClient[]> {
  const servers = await loadServerConfigs();
  const disabled = new Set(disabledServerIds);
  const enabled = servers.filter(s => !disabled.has(s.id));

  return Promise.all(enabled.map(async (s) => {
    const authHeader = s.authSecretName ? await resolveAuthHeader(s.authSecretName) : undefined;
    return new McpClient({
      transport: new StreamableHTTPClientTransport(new URL(s.url), {
        requestInit: authHeader ? { headers: { Authorization: authHeader } } : undefined,
      }),
    });
  }));
}
