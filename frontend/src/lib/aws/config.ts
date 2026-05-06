// AWS configuration — all values from environment variables set at build time.
// These are NEXT_PUBLIC_ so they are embedded in the static bundle.

export const AWS_REGION =
  process.env.NEXT_PUBLIC_AWS_REGION ?? "eu-west-1";

export const IDENTITY_POOL_ID =
  process.env.NEXT_PUBLIC_IDENTITY_POOL_ID ?? "";

export const DOCS_BUCKET_NAME =
  process.env.NEXT_PUBLIC_DOCS_BUCKET_NAME ?? "";

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export const AGENTCORE_URL =
  process.env.NEXT_PUBLIC_AGENTCORE_URL ?? "";

// The Supabase OIDC logins key for Cognito Identity Pool.
// Must match the provider registered in the Identity Pool (AuthStack).
export const SUPABASE_LOGINS_KEY =
  `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1`;
