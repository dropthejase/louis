#!/bin/bash
# Deploy Louis agent to AgentCore Runtime.
# Prerequisites: AWS CLI configured, Finch running (https://github.com/runfinch/finch),
#   @aws/agentcore installed (npm i -g @aws/agentcore)
# Usage: AWS_ACCOUNT_ID=123456789 AWS_REGION=eu-west-1 ./scripts/deploy-agent.sh

set -e

ACCOUNT_ID=${AWS_ACCOUNT_ID:?AWS_ACCOUNT_ID required}
REGION=${AWS_REGION:-eu-west-1}
ECR_REPO="louis-agent"
IMAGE_TAG="latest"
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPO}:${IMAGE_TAG}"

# Finch is required — Docker Desktop not supported
if ! command -v finch &>/dev/null; then
  echo "ERROR: finch not found. Install: brew install --cask finch && finch vm init && finch vm start"
  exit 1
fi
CONTAINER_CLI="finch"

echo "==> Using container CLI: ${CONTAINER_CLI}"

echo "==> Building agent..."
cd agent && npm run build
cd ..

echo "==> Building container image (ARM64)..."
${CONTAINER_CLI} build --platform linux/arm64 -t "${ECR_REPO}:${IMAGE_TAG}" agent/

echo "==> Authenticating with ECR..."
aws ecr get-login-password --region "${REGION}" | \
  ${CONTAINER_CLI} login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

echo "==> Creating ECR repo if needed..."
aws ecr describe-repositories --repository-names "${ECR_REPO}" --region "${REGION}" 2>/dev/null || \
  aws ecr create-repository --repository-name "${ECR_REPO}" --region "${REGION}"

echo "==> Pushing image..."
${CONTAINER_CLI} tag "${ECR_REPO}:${IMAGE_TAG}" "${ECR_URI}"
${CONTAINER_CLI} push "${ECR_URI}"

echo "==> Deploying to AgentCore..."
cd agent && agentcore deploy

echo "Done. Check status with: cd agent && agentcore status"
