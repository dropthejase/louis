import { Router } from "express";
import {
  CognitoIdentityProviderClient,
  AdminDeleteUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";

export const userRouter = Router();

// POST /user/profile
userRouter.post("/profile", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const { error } = await db
    .from("user_profiles")
    .upsert(
      { user_id: userId },
      { onConflict: "user_id", ignoreDuplicates: true },
    );
  if (error) return void res.status(500).json({ detail: error.message });
  res.json({ ok: true });
});

// DELETE /user/account
userRouter.delete("/account", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const userPoolId = process.env.USER_POOL_ID;
  if (!userPoolId) return void res.status(500).json({ detail: "USER_POOL_ID not configured" });

  const cognito = new CognitoIdentityProviderClient({});
  try {
    await cognito.send(new AdminDeleteUserCommand({
      UserPoolId: userPoolId,
      Username: userId,
    }));
    res.status(204).send();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to delete user";
    res.status(500).json({ detail: message });
  }
});
