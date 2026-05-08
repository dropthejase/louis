#!/bin/bash
# Deploy Mike agent to AgentCore Runtime.
# Prerequisites: AWS CLI configured, @aws/agentcore installed (npm i -g @aws/agentcore)
# The AgentCore execution role is managed by CDK (ApiStack). Deploy the CDK stacks first.
# Finch is only required for the LibreOffice conversion Lambda (ConversionStack).
# Usage: AWS_REGION=eu-west-1 ./scripts/deploy-agent.sh

set -euo pipefail

REGION=${AWS_REGION:-eu-west-1}
API_STACK=${API_STACK:-ApiStack}
AUTH_STACK=${AUTH_STACK:-AuthStack}
AGENTCORE_JSON="agent/agentcore/agentcore.json"

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
if ! command -v aws &>/dev/null; then
  echo "ERROR: aws CLI not found" && exit 1
fi
if ! aws sts get-caller-identity &>/dev/null; then
  echo "ERROR: No valid AWS credentials." && exit 1
fi
if ! command -v agentcore &>/dev/null; then
  echo "ERROR: agentcore CLI not found. Run: npm i -g @aws/agentcore" && exit 1
fi

# ---------------------------------------------------------------------------
# Read AgentCore execution role ARN from ApiStack
# ---------------------------------------------------------------------------
echo "==> Reading AgentCore execution role ARN from ${API_STACK}..."
ROLE_ARN=$(aws cloudformation describe-stacks \
  --stack-name "${API_STACK}" \
  --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='AgentCoreExecutionRoleArn'].OutputValue" \
  --output text)

if [[ -z "${ROLE_ARN}" || "${ROLE_ARN}" == "None" ]]; then
  echo "ERROR: AgentCoreExecutionRoleArn not found in ${API_STACK} outputs."
  echo "       Deploy CDK stacks first: cd infra && npx cdk deploy ApiStack"
  exit 1
fi

# ---------------------------------------------------------------------------
# Read Cognito config from AuthStack
# ---------------------------------------------------------------------------
echo "==> Reading Cognito config from ${AUTH_STACK}..."
USER_POOL_ID=$(aws cloudformation describe-stacks \
  --stack-name "${AUTH_STACK}" \
  --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" \
  --output text)

USER_POOL_CLIENT_ID=$(aws cloudformation describe-stacks \
  --stack-name "${AUTH_STACK}" \
  --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolClientId'].OutputValue" \
  --output text)

if [[ -z "${USER_POOL_ID}" || "${USER_POOL_ID}" == "None" ]]; then
  echo "ERROR: UserPoolId not found in ${AUTH_STACK} outputs."
  echo "       Deploy CDK stacks first: cd infra && npx cdk deploy AuthStack"
  exit 1
fi

if [[ -z "${USER_POOL_CLIENT_ID}" || "${USER_POOL_CLIENT_ID}" == "None" ]]; then
  echo "ERROR: UserPoolClientId not found in ${AUTH_STACK} outputs."
  exit 1
fi

DISCOVERY_URL="https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}/.well-known/openid-configuration"

echo "Role ARN:       ${ROLE_ARN}"
echo "User Pool ID:   ${USER_POOL_ID}"
echo "Client ID:      ${USER_POOL_CLIENT_ID}"
echo "Discovery URL:  ${DISCOVERY_URL}"

# ---------------------------------------------------------------------------
# Inject values into agentcore.json (skip fields already set to same value)
# ---------------------------------------------------------------------------
CURRENT_ROLE=$(node -e "
  const cfg = JSON.parse(require('fs').readFileSync('${AGENTCORE_JSON}', 'utf8'));
  process.stdout.write(cfg.agents[0].executionRoleArn ?? '');
")
CURRENT_DISCOVERY=$(node -e "
  const cfg = JSON.parse(require('fs').readFileSync('${AGENTCORE_JSON}', 'utf8'));
  process.stdout.write(cfg.agents[0].authorizerConfiguration?.customJwtAuthorizer?.discoveryUrl ?? '');
")

if [[ "${CURRENT_ROLE}" != "${ROLE_ARN}" ]] || [[ "${CURRENT_DISCOVERY}" != "${DISCOVERY_URL}" ]]; then
  echo "==> Wiring execution role and Cognito config into agentcore.json..."
  node -e "
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync('${AGENTCORE_JSON}', 'utf8'));
    cfg.agents[0].executionRoleArn = '${ROLE_ARN}';
    cfg.agents[0].authorizerConfiguration = {
      customJwtAuthorizer: {
        discoveryUrl: '${DISCOVERY_URL}',
        allowedAudience: ['${USER_POOL_CLIENT_ID}'],
        allowedClients: ['${USER_POOL_CLIENT_ID}'],
      }
    };
    fs.writeFileSync('${AGENTCORE_JSON}', JSON.stringify(cfg, null, 2) + '\n');
  "
else
  echo "==> agentcore.json already up to date, skipping."
fi

# ---------------------------------------------------------------------------
# Build and deploy
# ---------------------------------------------------------------------------
echo "==> Building agent..."
cd agent && npm run build
cd ..

echo "==> Deploying to AgentCore (zip)..."
cd agent && agentcore deploy

echo ""
echo "Done. Check status with: cd agent && agentcore status"
