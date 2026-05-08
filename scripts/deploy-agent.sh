#!/bin/bash
# Deploy Louis agent to AgentCore Runtime.
# Prerequisites: AWS CLI configured, @aws/agentcore installed (npm i -g @aws/agentcore)
# Note: No container build needed — AgentCore CLI zips built output directly.
# Finch is only required for the LibreOffice conversion Lambda (ConversionStack).
# Usage: AWS_ACCOUNT_ID=123456789 AWS_REGION=eu-west-1 ./scripts/deploy-agent.sh

set -e

ACCOUNT_ID=${AWS_ACCOUNT_ID:?AWS_ACCOUNT_ID required}
REGION=${AWS_REGION:-eu-west-1}
ROLE_NAME="LouisAgentCoreExecutionRole"

# Create or retrieve the AgentCore execution role (idempotent)
echo "==> Creating AgentCore execution role (if not exists)..."
EXISTING_ROLE_ARN=$(aws iam get-role --role-name "${ROLE_NAME}" --query 'Role.Arn' --output text 2>/dev/null || true)

if [[ -z "${EXISTING_ROLE_ARN}" || "${EXISTING_ROLE_ARN}" == "None" ]]; then
  TRUST_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AssumeRolePolicy",
    "Effect": "Allow",
    "Principal": { "Service": "bedrock-agentcore.amazonaws.com" },
    "Action": "sts:AssumeRole",
    "Condition": {
      "StringEquals": { "aws:SourceAccount": "${ACCOUNT_ID}" },
      "ArnLike": { "aws:SourceArn": "arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:*" }
    }
  }]
}
EOF
)
  aws iam create-role \
    --role-name "${ROLE_NAME}" \
    --assume-role-policy-document "${TRUST_POLICY}" \
    --description "AgentCore Runtime execution role for Louis agent"

  PERMISSIONS_POLICY=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudWatchLogs",
      "Effect": "Allow",
      "Action": ["logs:CreateLogGroup", "logs:DescribeLogGroups", "logs:DescribeLogStreams", "logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": ["arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/aws/bedrock-agentcore/runtimes/*", "arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:*"]
    },
    {
      "Sid": "XRayTracing",
      "Effect": "Allow",
      "Action": ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules", "xray:GetSamplingTargets"],
      "Resource": "*"
    },
    {
      "Sid": "CloudWatchMetrics",
      "Effect": "Allow",
      "Action": "cloudwatch:PutMetricData",
      "Resource": "*",
      "Condition": { "StringEquals": { "cloudwatch:namespace": "bedrock-agentcore" } }
    },
    {
      "Sid": "BedrockModelAccess",
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      "Resource": [
        "arn:aws:bedrock:${REGION}::foundation-model/eu.anthropic.claude-opus-4-7-20251101-v1:0",
        "arn:aws:bedrock:${REGION}::foundation-model/eu.anthropic.claude-sonnet-4-6-20250922-v1:0",
        "arn:aws:bedrock:${REGION}::foundation-model/eu.anthropic.claude-haiku-4-5-20251001-v1:0"
      ]
    }
  ]
}
EOF
)
  aws iam put-role-policy \
    --role-name "${ROLE_NAME}" \
    --policy-name "LouisAgentCorePolicy" \
    --policy-document "${PERMISSIONS_POLICY}"

  EXISTING_ROLE_ARN=$(aws iam get-role --role-name "${ROLE_NAME}" --query 'Role.Arn' --output text)
  echo "Created role: ${EXISTING_ROLE_ARN}"
else
  echo "Role exists: ${EXISTING_ROLE_ARN}"
fi

ROLE_ARN="${EXISTING_ROLE_ARN}"

echo "==> Wiring execution role into agentcore.json..."
node -e "
  const fs = require('fs');
  const p = 'agent/agentcore/agentcore.json';
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  cfg.agents[0].executionRoleArn = '${ROLE_ARN}';
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
"

echo "==> Building agent..."
cd agent && npm run build
cd ..

echo "==> Deploying to AgentCore..."
cd agent && agentcore deploy

echo "Done. Check status with: cd agent && agentcore status"
