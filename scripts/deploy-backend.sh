#!/bin/bash
# Build the backend Lambda ZIP and update the function code.
#
# Usage:
#   ./scripts/deploy-backend.sh
#
# On first deploy (cdk deploy): CDK reads backend/lambda-pkg/ to create the function.
# On subsequent deploys: this script rebuilds and pushes updated code directly via
#   aws lambda update-function-code — no CDK required.
#
# Prerequisites: AWS CLI configured, CDK ApiStack deployed.

set -euo pipefail

REGION=${AWS_REGION:-eu-west-1}
API_STACK=${API_STACK:-ApiStack}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BACKEND_DIR="${REPO_ROOT}/backend"
PKG_DIR="${BACKEND_DIR}/lambda-pkg"

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
# Read Lambda function name from CFN
# ---------------------------------------------------------------------------
cfn_output() {
  aws cloudformation describe-stacks \
    --stack-name "$1" --region "${REGION}" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" \
    --output text
}

echo "==> Reading CloudFormation outputs..."
LAMBDA_ARN=$(cfn_output "${API_STACK}" "ApiLambdaArn")
if [[ -z "${LAMBDA_ARN}" || "${LAMBDA_ARN}" == "None" ]]; then
  echo "ERROR: Could not read ApiLambdaArn from ${API_STACK}. Run cdk deploy first."
  exit 1
fi
FUNCTION_NAME=$(echo "${LAMBDA_ARN}" | awk -F: '{print $NF}')
echo "Function: ${FUNCTION_NAME}"

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
echo "==> Building backend..."
cd "${BACKEND_DIR}"
npm ci
npm run build

# ---------------------------------------------------------------------------
# Package into lambda-pkg/
# ---------------------------------------------------------------------------
echo "==> Packaging lambda-pkg/..."
rm -rf "${PKG_DIR}"
mkdir -p "${PKG_DIR}"

# Install prod-only deps for linux/arm64
npm ci --omit=dev --os linux --cpu arm64

cp -r dist "${PKG_DIR}/dist"
cp -r node_modules "${PKG_DIR}/node_modules"
cp package.json "${PKG_DIR}/package.json"

# Restore full dev deps locally
npm ci

# ---------------------------------------------------------------------------
# ZIP and deploy
# ---------------------------------------------------------------------------
ZIP_FILE="${REPO_ROOT}/backend-lambda.zip"
echo "==> Creating ZIP..."
(cd "${PKG_DIR}" && zip -qr "${ZIP_FILE}" .)

echo "==> Updating Lambda function code..."
aws lambda update-function-code \
  --function-name "${FUNCTION_NAME}" \
  --zip-file "fileb://${ZIP_FILE}" \
  --architectures arm64 \
  --region "${REGION}" \
  --output json | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    console.log('Updated:', d.FunctionName);
    console.log('CodeSize:', d.CodeSize, 'bytes');
    console.log('LastModified:', d.LastModified);
  "

rm "${ZIP_FILE}"
echo ""
echo "Done. Backend Lambda updated."
