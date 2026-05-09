// backend/src/middleware/auth.ts
//
// Auth middleware — extracts userId from Cognito User Pool authorizer claims.
// API Gateway native Cognito authorizer injects JWT claims into
// requestContext.authorizer.claims. The sub claim is the Cognito user ID.

import { Request, Response, NextFunction } from "express";

type ApiGatewayContext = {
  event?: {
    requestContext?: {
      authorizer?: {
        claims?: {
          sub?: string;
          email?: string;
        };
      };
    };
  };
};

declare module "express-serve-static-core" {
  interface Request {
    apiGateway?: ApiGatewayContext;
  }
}

/**
 * Express middleware that enforces Cognito authentication.
 *
 * Reads the JWT claims injected by API Gateway's native Cognito authorizer
 * from `req.apiGateway.event.requestContext.authorizer.claims`. Sets
 * `res.locals.userId` (from `sub`), `res.locals.userEmail`, and
 * `res.locals.token` (the raw Bearer token, forwarded to the agent).
 * Returns 401 if the `sub` claim is absent.
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const claims = req.apiGateway?.event?.requestContext?.authorizer?.claims;
  if (!claims?.sub) {
    res.status(401).json({ detail: "Unauthorized" });
    return;
  }

  res.locals.userId = claims.sub;
  res.locals.userEmail = claims.email ? claims.email.toLowerCase() : undefined;
  const auth = req.headers.authorization ?? "";
  res.locals.token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  next();
}
