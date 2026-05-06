// backend/src/middleware/auth.ts
//
// Auth middleware for Express routes.
//
// Prod (Lambda + API Gateway):
//   The Lambda authorizer (Plan 1) validates the Supabase JWT against the
//   JWKS endpoint and injects userId + userEmail into the API Gateway
//   request context. serverless-http surfaces this as req.apiGateway.event.
//   No Supabase network call needed here.
//
// Local dev:
//   No API Gateway wrapper — fall back to Supabase getUser() as before.

import { Request, Response, NextFunction } from "express";
import { createClient } from "@supabase/supabase-js";

// serverless-http attaches the raw Lambda event to req.apiGateway when running
// inside a Lambda. We type just the fields we need.
type ApiGatewayContext = {
  event?: {
    requestContext?: {
      authorizer?: {
        userId?: string;
        userEmail?: string;
      };
    };
  };
};

declare module "express-serve-static-core" {
  interface Request {
    apiGateway?: ApiGatewayContext;
  }
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // --- Prod path: read from API Gateway authorizer context ---
  const authorizer = req.apiGateway?.event?.requestContext?.authorizer;
  if (authorizer?.userId) {
    res.locals.userId = authorizer.userId;
    res.locals.userEmail = (authorizer.userEmail ?? "").toLowerCase();
    // Preserve the raw Bearer token for any Supabase DB calls that need it.
    const auth = req.headers.authorization ?? "";
    res.locals.token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    next();
    return;
  }

  // --- Local dev fallback: Supabase getUser() ---
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) {
    res.status(401).json({ detail: "Missing or invalid Authorization header" });
    return;
  }
  const token = auth.slice(7).trim();

  const supabaseUrl = process.env.SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SECRET_KEY ?? "";

  if (!supabaseUrl || !serviceKey) {
    res.status(500).json({ detail: "Server auth is not configured" });
    return;
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const { data } = await admin.auth.getUser(token);
  if (!data.user) {
    res.status(401).json({ detail: "Invalid or expired token" });
    return;
  }

  res.locals.userId = data.user.id;
  res.locals.userEmail = data.user.email?.toLowerCase() ?? "";
  res.locals.token = token;
  next();
}
