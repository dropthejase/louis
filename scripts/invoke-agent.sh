#!/bin/bash
# Test invoke the deployed Mike agent.
# Usage: AGENT_RUNTIME_ARN=arn:aws:... SUPABASE_JWT=eyJ... ./scripts/invoke-agent.sh

set -e

RUNTIME_ARN=${AGENT_RUNTIME_ARN:?AGENT_RUNTIME_ARN required}
JWT=${SUPABASE_JWT:?SUPABASE_JWT required}
SESSION_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
REGION=${AWS_REGION:-eu-west-1}

PAYLOAD=$(printf '{"userId":"test-user","chatId":"test-chat","prompt":"Hello, who are you?","runtimeSessionId":"%s"}' "${SESSION_ID}" | base64)

aws bedrock-agentcore invoke-agent-runtime \
  --agent-runtime-arn "${RUNTIME_ARN}" \
  --runtime-session-id "${SESSION_ID}" \
  --payload "${PAYLOAD}" \
  --region "${REGION}" \
  --cli-binary-format raw-in-base64-out \
  output.json

echo "Response:"
cat output.json
