// backend/src/middleware/auth.ts
//
// Auth middleware for Express routes.
//
// Lambda + API Gateway only:
//   The Lambda authorizer validates the Supabase JWT against the JWKS endpoint
//   and injects userId + userEmail into the API Gateway request context.
//   serverless-http surfaces this as req.apiGateway.event.

import { Request, Response, NextFunction } from "express";

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
  const authorizer = req.apiGateway?.event?.requestContext?.authorizer;
  if (!authorizer?.userId) {
    res.status(401).json({ detail: "Unauthorized" });
    return;
  }

  res.locals.userId = authorizer.userId;
  res.locals.userEmail = (authorizer.userEmail ?? "").toLowerCase();
  const auth = req.headers.authorization ?? "";
  res.locals.token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  next();
}
