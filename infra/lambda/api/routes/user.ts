/**
 * User profile routes — read/write profile data and account deletion.
 *
 * Handles display name, organisation, and per-user model preference. Account
 * deletion cascades through all owned data (FK constraints) then removes
 * the user from the Cognito User Pool via AdminDeleteUser.
 */
import { Router } from "express";
import {
  CognitoIdentityProviderClient,
  AdminDeleteUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { requireAuth } from "../middleware/auth";
import { execute, queryOne } from "../lib/db";

const s3 = new S3Client({ region: process.env.AWS_REGION ?? "eu-west-1" });
const ADMIN_CONFIG_BUCKET = process.env.ADMIN_BUCKET_NAME;

interface McpServerConfig {
  id: string;
  url: string;
}

async function loadMcpServers(): Promise<McpServerConfig[]> {
  if (!ADMIN_CONFIG_BUCKET) return [];
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: ADMIN_CONFIG_BUCKET, Key: "mcp.json" }));
    const body = await res.Body?.transformToString();
    if (!body) return [];
    const parsed = JSON.parse(body) as { mcpServers?: Record<string, { url: string }> };
    return parsed.mcpServers
      ? Object.entries(parsed.mcpServers).map(([id, cfg]) => ({ id, url: cfg.url }))
      : [];
  } catch (err) {
    console.error('[mcp] loadMcpServers error:', err);
    return [];
  }
}

export const userRouter = Router();

// GET /user/profile
userRouter.get("/profile", requireAuth, async (_req, res) => {
  try {
    const userId = res.locals.userId as string;
    const data = await queryOne<{
      display_name: string | null;
      organisation: string | null;
      tabular_model: string | null;
      tier: string | null;
      disabled_mcp_servers: string | string[] | null;
    }>(
      `SELECT display_name, organisation, tabular_model, tier, disabled_mcp_servers
       FROM user_profiles WHERE user_id = :userId`,
      [{ name: "userId", value: { stringValue: userId } }],
    );
    if (!data) return void res.status(404).json({ detail: "Profile not found" });
    const disabled_mcp_servers: string[] = typeof data.disabled_mcp_servers === 'string'
      ? JSON.parse(data.disabled_mcp_servers)
      : (data.disabled_mcp_servers ?? []);
    res.json({ ...data, disabled_mcp_servers });
  } catch (err) {
    console.error("[user] GET /profile error:", err);
    res.status(500).json({ detail: "Internal server error" });
  }
});

// PUT /user/profile
userRouter.put("/profile", requireAuth, async (req, res) => {
  try {
    const userId = res.locals.userId as string;
    const { display_name, organisation, tabular_model, disabled_mcp_servers } = req.body as {
      display_name?: string;
      organisation?: string;
      tabular_model?: string;
      disabled_mcp_servers?: string[];
    };
    await execute(
      `UPDATE user_profiles
       SET display_name = COALESCE(:displayName, display_name),
           organisation = COALESCE(:organisation, organisation),
           tabular_model = COALESCE(:tabularModel, tabular_model),
           disabled_mcp_servers = COALESCE(:disabledMcpServers::jsonb, disabled_mcp_servers),
           updated_at = NOW()
       WHERE user_id = :userId`,
      [
        { name: "displayName", value: display_name != null ? { stringValue: display_name } : { isNull: true } },
        { name: "organisation", value: organisation != null ? { stringValue: organisation } : { isNull: true } },
        { name: "tabularModel", value: tabular_model != null ? { stringValue: tabular_model } : { isNull: true } },
        { name: "disabledMcpServers", value: disabled_mcp_servers != null ? { stringValue: JSON.stringify(disabled_mcp_servers) } : { isNull: true } },
        { name: "userId", value: { stringValue: userId } },
      ],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("[user] PUT /profile error:", err);
    res.status(500).json({ detail: "Internal server error" });
  }
});

// POST /user/profile (upsert on signup)
userRouter.post("/profile", requireAuth, async (_req, res) => {
  try {
    const userId = res.locals.userId as string;
    await execute(
      `INSERT INTO user_profiles (user_id, updated_at)
       VALUES (:userId, NOW())
       ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()`,
      [{ name: "userId", value: { stringValue: userId } }],
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("[user] POST /profile error:", err);
    res.status(500).json({ detail: "Internal server error" });
  }
});

// GET /user/mcp-servers
userRouter.get("/mcp-servers", requireAuth, async (_req, res) => {
  try {
    const servers = await loadMcpServers();
    res.json({ servers });
  } catch (err) {
    console.error("[user] GET /mcp-servers error:", err);
    res.status(500).json({ detail: "Internal server error" });
  }
});

// DELETE /user/account
userRouter.delete("/account", requireAuth, async (_req, res) => {
  try {
    const userId = res.locals.userId as string;
    const userPoolId = process.env.USER_POOL_ID;
    if (!userPoolId) return void res.status(500).json({ detail: "USER_POOL_ID not configured" });

    // Delete all user data synchronously before removing the Cognito account.
    // FK cascades handle child rows: subfolders, documents, versions, chats,
    // tabular_cells, workflow_shares, etc.
    await execute(`DELETE FROM projects WHERE user_id = :userId`,
      [{ name: "userId", value: { stringValue: userId } }]);
    await execute(`DELETE FROM workflows WHERE user_id = :userId`,
      [{ name: "userId", value: { stringValue: userId } }]);
    await execute(`DELETE FROM tabular_reviews WHERE user_id = :userId`,
      [{ name: "userId", value: { stringValue: userId } }]);
    await execute(`DELETE FROM chats WHERE user_id = :userId AND project_id IS NULL`,
      [{ name: "userId", value: { stringValue: userId } }]);
    await execute(`DELETE FROM user_profiles WHERE user_id = :userId`,
      [{ name: "userId", value: { stringValue: userId } }]);

    const cognito = new CognitoIdentityProviderClient({});
    try {
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: userId }));
      res.status(204).send();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to delete user";
      res.status(500).json({ detail: message });
    }
  } catch (err) {
    console.error("[user] DELETE /account error:", err);
    res.status(500).json({ detail: "Internal server error" });
  }
});
