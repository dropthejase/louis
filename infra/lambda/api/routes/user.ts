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
import { requireAuth } from "../middleware/auth";
import { execute, queryOne } from "../lib/db";

export const userRouter = Router();

// GET /user/profile
userRouter.get("/profile", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const data = await queryOne<{
    display_name: string | null;
    organisation: string | null;
    tabular_model: string | null;
    tier: string | null;
  }>(
    `SELECT display_name, organisation, tabular_model, tier
     FROM user_profiles WHERE user_id = :userId`,
    [{ name: "userId", value: { stringValue: userId } }],
  );
  if (!data) return void res.status(404).json({ detail: "Profile not found" });
  res.json(data);
});

// PUT /user/profile
userRouter.put("/profile", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { display_name, organisation, tabular_model } = req.body as {
    display_name?: string;
    organisation?: string;
    tabular_model?: string;
  };
  await execute(
    `UPDATE user_profiles
     SET display_name = COALESCE(:displayName, display_name),
         organisation = COALESCE(:organisation, organisation),
         tabular_model = COALESCE(:tabularModel, tabular_model),
         updated_at = NOW()
     WHERE user_id = :userId`,
    [
      { name: "displayName", value: display_name != null ? { stringValue: display_name } : { isNull: true } },
      { name: "organisation", value: organisation != null ? { stringValue: organisation } : { isNull: true } },
      { name: "tabularModel", value: tabular_model != null ? { stringValue: tabular_model } : { isNull: true } },
      { name: "userId", value: { stringValue: userId } },
    ],
  );
  res.json({ ok: true });
});

// POST /user/profile (upsert on signup)
userRouter.post("/profile", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  await execute(
    `INSERT INTO user_profiles (user_id, updated_at)
     VALUES (:userId, NOW())
     ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()`,
    [{ name: "userId", value: { stringValue: userId } }],
  );
  res.json({ ok: true });
});

// DELETE /user/account
userRouter.delete("/account", requireAuth, async (_req, res) => {
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
});
