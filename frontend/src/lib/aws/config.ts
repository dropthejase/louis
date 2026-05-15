// AWS configuration — all values from VITE_ environment variables set at build time.

function required(key: string): string {
  const value = import.meta.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

export const AWS_REGION = required('VITE_AWS_REGION');
export const DOCS_BUCKET_NAME = required('VITE_DOCS_BUCKET_NAME');
export const API_URL = required('VITE_API_URL').replace(/\/$/, '');
export const USER_POOL_ID = required('VITE_USER_POOL_ID');
export const USER_POOL_CLIENT_ID = required('VITE_USER_POOL_CLIENT_ID');

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

// Amplify configuration — single source of truth used in App.tsx
export const amplifyConfig = {
  Auth: {
    Cognito: {
      userPoolId: USER_POOL_ID,
      userPoolClientId: USER_POOL_CLIENT_ID,
    },
  },
};
