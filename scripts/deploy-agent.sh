#!/bin/bash
# Deploy a Louis agent to AgentCore Runtime via direct ZIP deployment (no Docker/CDK).
#
# Usage:
#   AWS_REGION=eu-west-1 ./scripts/deploy-agent.sh louisMain
#   AWS_REGION=eu-west-1 ./scripts/deploy-agent.sh louisTabular
#
# Prerequisites: AWS CLI configured, CDK stacks deployed.
# On first run: creates the AgentCore Runtime and stores its ID in SSM.
# On subsequent runs: updates the existing runtime with the new ZIP.

set -euo pipefail

AGENT_NAME=${1:-louisMain}
REGION=${AWS_REGION:-eu-west-1}
API_STACK=${API_STACK:-ApiStack}
AUTH_STACK=${AUTH_STACK:-AuthStack}
STORAGE_STACK=${STORAGE_STACK:-StorageStack}
DATABASE_STACK=${DATABASE_STACK:-DatabaseStack}
SSM_PARAM="/louis/agents/${AGENT_NAME}/runtimeId"

case "${AGENT_NAME}" in
  louisMain)    AGENT_DIR="agents/app/main" ;;
  louisTabular) AGENT_DIR="agents/app/tabular" ;;
  *) echo "ERROR: Unknown agent '${AGENT_NAME}'. Valid: louisMain, louisTabular" && exit 1 ;;
esac

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
if ! command -v aws &>/dev/null; then
  echo "ERROR: aws CLI not found" && exit 1
fi
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null)
if [[ -z "${ACCOUNT_ID}" ]]; then
  echo "ERROR: No valid AWS credentials." && exit 1
fi

# ---------------------------------------------------------------------------
# Read CFN outputs
# ---------------------------------------------------------------------------
cfn_output() {
  aws cloudformation describe-stacks \
    --stack-name "$1" --region "${REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" \
    --output text
}

echo "==> Reading CloudFormation outputs..."

ROLE_ARN=$(cfn_output "${API_STACK}" "AgentCoreExecutionRoleArn")
DEPLOY_BUCKET=$(cfn_output "${STORAGE_STACK}" "AgentDeployBucketName")
USER_POOL_ID=$(cfn_output "${AUTH_STACK}" "UserPoolId")
USER_POOL_CLIENT_ID=$(cfn_output "${AUTH_STACK}" "UserPoolClientId")
DB_CLUSTER_ARN=$(cfn_output "${DATABASE_STACK}" "ClusterArn")
DB_SECRET_ARN=$(cfn_output "${DATABASE_STACK}" "SecretArn")
DB_NAME=$(cfn_output "${DATABASE_STACK}" "DatabaseName")
DOCS_BUCKET=$(cfn_output "${STORAGE_STACK}" "DocsBucketName")
SESSIONS_BUCKET=$(cfn_output "${STORAGE_STACK}" "SessionsBucketName")
CREDITS_TABLE=$(cfn_output "${API_STACK}" "CreditsTableName")
API_URL=$(cfn_output "${API_STACK}" "ApiUrl")

for var in ROLE_ARN DEPLOY_BUCKET USER_POOL_ID USER_POOL_CLIENT_ID DB_CLUSTER_ARN DB_SECRET_ARN DB_NAME DOCS_BUCKET SESSIONS_BUCKET CREDITS_TABLE API_URL; do
  val="${!var}"
  if [[ -z "${val}" || "${val}" == "None" ]]; then
    echo "ERROR: Could not read ${var} from CloudFormation. Deploy CDK stacks first."
    exit 1
  fi
done

DISCOVERY_URL="https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}/.well-known/openid-configuration"

echo "Agent:          ${AGENT_NAME}"
echo "Role ARN:       ${ROLE_ARN}"
echo "Deploy bucket:  ${DEPLOY_BUCKET}"
echo "Discovery URL:  ${DISCOVERY_URL}"

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
echo "==> Building ${AGENT_NAME}..."
cd "${AGENT_DIR}"
npm ci --omit=dev --legacy-peer-deps
npm run build
cd - > /dev/null

# ---------------------------------------------------------------------------
# Package
# ---------------------------------------------------------------------------
ZIP_FILE="${AGENT_NAME}.zip"
S3_KEY="${AGENT_NAME}/${ZIP_FILE}"

echo "==> Packaging ${ZIP_FILE}..."
(cd "${AGENT_DIR}" && zip -qr "../../${ZIP_FILE}" dist/ node_modules/ package.json)

echo "==> Uploading to s3://${DEPLOY_BUCKET}/${S3_KEY}..."
aws s3 cp "${ZIP_FILE}" "s3://${DEPLOY_BUCKET}/${S3_KEY}" --region "${REGION}"
rm "${ZIP_FILE}"

# ---------------------------------------------------------------------------
# Create or update AgentCore Runtime
# ---------------------------------------------------------------------------
ARTIFACT=$(node -e "
  process.stdout.write(JSON.stringify({
    codeConfiguration: {
      code: { s3: { bucket: '${DEPLOY_BUCKET}', prefix: '${S3_KEY}' } },
      runtime: 'NODE_22',
      entryPoint: ['opentelemetry-instrument', 'dist/index.js'],
    }
  }));
")

# Read sibling agent ARN from SSM (best-effort — may not exist yet on first deploy)
TABULAR_AGENT_ARN=$(aws ssm get-parameter \
  --name "/louis/agents/louisTabular/runtimeArn" --region "${REGION}" \
  --query "Parameter.Value" --output text 2>/dev/null || echo "")
MAIN_AGENT_ARN=$(aws ssm get-parameter \
  --name "/louis/agents/louisMain/runtimeArn" --region "${REGION}" \
  --query "Parameter.Value" --output text 2>/dev/null || echo "")

ENV_VARS=$(node -e "
  const env = {
    DB_CLUSTER_ARN: '${DB_CLUSTER_ARN}',
    DB_SECRET_ARN: '${DB_SECRET_ARN}',
    DB_NAME: '${DB_NAME}',
    DOCS_BUCKET_NAME: '${DOCS_BUCKET}',
    SESSIONS_BUCKET_NAME: '${SESSIONS_BUCKET}',
    CREDITS_TABLE_NAME: '${CREDITS_TABLE}',
    API_BASE_URL: '${API_URL}',
    AWS_REGION: '${REGION}',
  };
  if ('${TABULAR_AGENT_ARN}') env.TABULAR_AGENT_ARN = '${TABULAR_AGENT_ARN}';
  if ('${MAIN_AGENT_ARN}') env.MAIN_AGENT_ARN = '${MAIN_AGENT_ARN}';
  process.stdout.write(JSON.stringify(env));
")

RUNTIME_ID=$(aws ssm get-parameter \
  --name "${SSM_PARAM}" --region "${REGION}" \
  --query "Parameter.Value" --output text 2>/dev/null || echo "")

if [[ -z "${RUNTIME_ID}" || "${RUNTIME_ID}" == "None" ]]; then
  echo "==> Creating new AgentCore Runtime '${AGENT_NAME}'..."
  RESPONSE=$(aws bedrock-agentcore-control create-agent-runtime \
    --agent-runtime-name "${AGENT_NAME}" \
    --agent-runtime-artifact "${ARTIFACT}" \
    --role-arn "${ROLE_ARN}" \
    --network-configuration '{"networkMode":"PUBLIC"}' \
    --authorizer-configuration "{\"customJWTAuthorizer\":{\"discoveryUrl\":\"${DISCOVERY_URL}\",\"allowedAudience\":[\"${USER_POOL_CLIENT_ID}\"],\"allowedClients\":[\"${USER_POOL_CLIENT_ID}\"]}}" \
    --request-header-configuration '{"requestHeaderAllowlist":["Authorization"]}' \
    --environment-variables "${ENV_VARS}" \
    --region "${REGION}" \
    --output json)

  RUNTIME_ID=$(echo "${RESPONSE}" | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    process.stdout.write(d.agentRuntimeId ?? '');
  ")
  RUNTIME_ARN=$(echo "${RESPONSE}" | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    process.stdout.write(d.agentRuntimeArn ?? '');
  ")

  aws ssm put-parameter \
    --name "${SSM_PARAM}" --value "${RUNTIME_ID}" \
    --type String --overwrite --region "${REGION}" > /dev/null

  echo "Created runtime ID: ${RUNTIME_ID}"
  echo "ARN: ${RUNTIME_ARN}"

  # Store ARN in SSM too — frontend needs it
  aws ssm put-parameter \
    --name "/louis/agents/${AGENT_NAME}/runtimeArn" --value "${RUNTIME_ARN}" \
    --type String --overwrite --region "${REGION}" > /dev/null
else
  echo "==> Updating existing AgentCore Runtime '${RUNTIME_ID}'..."
  aws bedrock-agentcore-control update-agent-runtime \
    --agent-runtime-id "${RUNTIME_ID}" \
    --agent-runtime-artifact "${ARTIFACT}" \
    --role-arn "${ROLE_ARN}" \
    --network-configuration '{"networkMode":"PUBLIC"}' \
    --authorizer-configuration "{\"customJWTAuthorizer\":{\"discoveryUrl\":\"${DISCOVERY_URL}\",\"allowedAudience\":[\"${USER_POOL_CLIENT_ID}\"],\"allowedClients\":[\"${USER_POOL_CLIENT_ID}\"]}}" \
    --request-header-configuration '{"requestHeaderAllowlist":["Authorization"]}' \
    --environment-variables "${ENV_VARS}" \
    --region "${REGION}" > /dev/null
  echo "Updated runtime ID: ${RUNTIME_ID}"
fi

echo ""
echo "Done. Agent '${AGENT_NAME}' deployed."
echo "SSM runtime ID:  ${SSM_PARAM}"
echo "SSM runtime ARN: /louis/agents/${AGENT_NAME}/runtimeArn"
