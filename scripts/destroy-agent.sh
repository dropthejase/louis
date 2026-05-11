#!/bin/bash
# Delete a Louis AgentCore Runtime and clean up SSM parameters.
#
# Usage:
#   AWS_REGION=eu-west-1 ./scripts/destroy-agent.sh louisMain
#   AWS_REGION=eu-west-1 ./scripts/destroy-agent.sh louisTabular
#
# Prerequisites: AWS CLI configured, agent previously deployed via deploy-agent.sh.

set -euo pipefail

AGENT_NAME=${1:-}
REGION=${AWS_REGION:-eu-west-1}

if [[ -z "${AGENT_NAME}" ]]; then
  echo "Usage: $0 <agentName>"
  echo "  Valid: louisMain, louisTabular"
  exit 1
fi

case "${AGENT_NAME}" in
  louisMain|louisTabular) ;;
  *) echo "ERROR: Unknown agent '${AGENT_NAME}'. Valid: louisMain, louisTabular" && exit 1 ;;
esac

SSM_ID_PARAM="/louis/agents/${AGENT_NAME}/runtimeId"
SSM_ARN_PARAM="/louis/agents/${AGENT_NAME}/runtimeArn"

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
if ! command -v aws &>/dev/null; then
  echo "ERROR: aws CLI not found" && exit 1
fi
if ! aws sts get-caller-identity --query Account --output text &>/dev/null; then
  echo "ERROR: No valid AWS credentials." && exit 1
fi

# ---------------------------------------------------------------------------
# Fetch runtime ID from SSM
# ---------------------------------------------------------------------------
RUNTIME_ID=$(aws ssm get-parameter \
  --name "${SSM_ID_PARAM}" --region "${REGION}" \
  --query "Parameter.Value" --output text 2>/dev/null || echo "")

if [[ -z "${RUNTIME_ID}" || "${RUNTIME_ID}" == "None" ]]; then
  echo "No runtime ID found in SSM at ${SSM_ID_PARAM}. Nothing to delete."
  exit 0
fi

echo "Agent:      ${AGENT_NAME}"
echo "Runtime ID: ${RUNTIME_ID}"
echo ""
read -r -p "Delete AgentCore Runtime '${AGENT_NAME}' (${RUNTIME_ID})? [y/N] " CONFIRM
if [[ "${CONFIRM}" != "y" && "${CONFIRM}" != "Y" ]]; then
  echo "Aborted."
  exit 0
fi

# ---------------------------------------------------------------------------
# Delete runtime
# ---------------------------------------------------------------------------
echo "==> Deleting AgentCore Runtime '${RUNTIME_ID}'..."
aws bedrock-agentcore-control delete-agent-runtime \
  --agent-runtime-id "${RUNTIME_ID}" \
  --region "${REGION}"

# ---------------------------------------------------------------------------
# Clean up SSM parameters
# ---------------------------------------------------------------------------
echo "==> Removing SSM parameters..."
aws ssm delete-parameter --name "${SSM_ID_PARAM}" --region "${REGION}" 2>/dev/null && \
  echo "Deleted ${SSM_ID_PARAM}" || echo "SSM param ${SSM_ID_PARAM} not found (already gone)"

aws ssm delete-parameter --name "${SSM_ARN_PARAM}" --region "${REGION}" 2>/dev/null && \
  echo "Deleted ${SSM_ARN_PARAM}" || echo "SSM param ${SSM_ARN_PARAM} not found (already gone)"

echo ""
echo "Done. Agent '${AGENT_NAME}' destroyed."
