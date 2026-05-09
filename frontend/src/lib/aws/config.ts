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

export const AGENTCORE_TABULAR_URL =
  process.env.NEXT_PUBLIC_AGENTCORE_TABULAR_URL ?? "";

export const USER_POOL_ID =
  process.env.NEXT_PUBLIC_USER_POOL_ID ?? "";

export const USER_POOL_CLIENT_ID =
  process.env.NEXT_PUBLIC_USER_POOL_CLIENT_ID ?? "";

// Cognito logins key for Identity Pool — matches the User Pool provider name
export const COGNITO_LOGINS_KEY =
  `cognito-idp.${AWS_REGION}.amazonaws.com/${USER_POOL_ID}`;
