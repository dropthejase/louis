// AWS configuration — all values from VITE_ environment variables set at build time.

export const AWS_REGION =
  import.meta.env.VITE_AWS_REGION ?? 'eu-west-1';

export const IDENTITY_POOL_ID =
  import.meta.env.VITE_IDENTITY_POOL_ID ?? '';

export const DOCS_BUCKET_NAME =
  import.meta.env.VITE_DOCS_BUCKET_NAME ?? '';

export const API_URL =
  import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

export const USER_POOL_ID =
  import.meta.env.VITE_USER_POOL_ID ?? '';

export const USER_POOL_CLIENT_ID =
  import.meta.env.VITE_USER_POOL_CLIENT_ID ?? '';

// AgentCore runtime ARNs — used to build invocation URLs.
// Format: https://bedrock-agentcore.{region}.amazonaws.com/runtimes/{escaped_arn}/invocations?qualifier=DEFAULT
export const AGENTCORE_MAIN_ARN =
  import.meta.env.VITE_AGENTCORE_MAIN_ARN ?? '';

export const AGENTCORE_TABULAR_ARN =
  import.meta.env.VITE_AGENTCORE_TABULAR_ARN ?? '';

function buildAgentCoreUrl(arn: string): string {
  return `https://bedrock-agentcore.${AWS_REGION}.amazonaws.com/runtimes/${encodeURIComponent(arn)}/invocations?qualifier=DEFAULT`;
}

export const AGENTCORE_URL = AGENTCORE_MAIN_ARN ? buildAgentCoreUrl(AGENTCORE_MAIN_ARN) : '';
export const AGENTCORE_TABULAR_URL = AGENTCORE_TABULAR_ARN ? buildAgentCoreUrl(AGENTCORE_TABULAR_ARN) : '';

// Cognito logins key for Identity Pool
export const COGNITO_LOGINS_KEY =
  `cognito-idp.${AWS_REGION}.amazonaws.com/${USER_POOL_ID}`;

// Amplify configuration — single source of truth used in App.tsx
export const amplifyConfig = {
  Auth: {
    Cognito: {
      userPoolId: USER_POOL_ID,
      userPoolClientId: USER_POOL_CLIENT_ID,
      identityPoolId: IDENTITY_POOL_ID,
    },
  },
  Storage: {
    S3: {
      bucket: DOCS_BUCKET_NAME,
      region: AWS_REGION,
    },
  },
};
