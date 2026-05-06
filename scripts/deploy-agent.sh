#!/bin/bash
# Deploy Mike agent to AgentCore Runtime.
# Prerequisites: AWS CLI configured, Docker or Finch running,
#   @aws/agentcore installed (npm i -g @aws/agentcore)
# Usage: AWS_ACCOUNT_ID=123456789 AWS_REGION=eu-west-1 ./scripts/deploy-agent.sh

set -e

ACCOUNT_ID=${AWS_ACCOUNT_ID:?AWS_ACCOUNT_ID required}
REGION=${AWS_REGION:-eu-west-1}
ECR_REPO="mike-agent"
IMAGE_TAG="latest"
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPO}:${IMAGE_TAG}"

# Use finch if docker is not available
CONTAINER_CLI="docker"
if ! command -v docker &>/dev/null && command -v finch &>/dev/null; then
  CONTAINER_CLI="finch"
fi

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
