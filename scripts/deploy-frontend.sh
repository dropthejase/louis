#!/bin/bash
# Deploy Mike frontend: build → S3 sync → CloudFront invalidation.
#
# Usage:
#   AWS_REGION=eu-west-1 ./scripts/deploy-frontend.sh
#
# Optional:
#   WAIT=1   — block until CloudFront invalidation completes
#
# Prerequisites: AWS CLI configured, StorageStack deployed.

set -euo pipefail

REGION=${AWS_REGION:-eu-west-1}
STORAGE_STACK=${STORAGE_STACK:-StorageStack}
FRONTEND_DIR=${FRONTEND_DIR:-frontend}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
if ! command -v aws &>/dev/null; then
  echo "ERROR: aws CLI not found" && exit 1
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

FRONTEND_BUCKET=$(cfn_output "${STORAGE_STACK}" "FrontendBucketName")
CF_DISTRIBUTION=$(cfn_output "${STORAGE_STACK}" "DistributionId")

for var in FRONTEND_BUCKET CF_DISTRIBUTION; do
  val="${!var}"
  if [[ -z "${val}" || "${val}" == "None" ]]; then
    echo "ERROR: Could not read ${var} from ${STORAGE_STACK}. Deploy CDK stacks first."
    exit 1
  fi
done

echo "Bucket:       ${FRONTEND_BUCKET}"
echo "Distribution: ${CF_DISTRIBUTION}"

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
echo "==> Building frontend..."
cd "${FRONTEND_DIR}"
npm ci
npm run build
cd ..

# ---------------------------------------------------------------------------
# Deploy
# ---------------------------------------------------------------------------
echo "==> Syncing to S3 (bucket: ${FRONTEND_BUCKET})..."
aws s3 sync "${FRONTEND_DIR}/out/" "s3://${FRONTEND_BUCKET}" \
  --delete \
  --region "${REGION}"

echo "==> Creating CloudFront invalidation (distribution: ${CF_DISTRIBUTION})..."
INVALIDATION_ID=$(aws cloudfront create-invalidation \
  --distribution-id "${CF_DISTRIBUTION}" \
  --paths "/*" \
  --query 'Invalidation.Id' \
  --output text)

echo "    Invalidation ID: ${INVALIDATION_ID}"

if [ "${WAIT:-}" = "1" ]; then
  echo "==> Waiting for invalidation to complete..."
  aws cloudfront wait invalidation-completed \
    --distribution-id "${CF_DISTRIBUTION}" \
    --id "${INVALIDATION_ID}"
  echo "    Done."
else
  echo "    (set WAIT=1 to block until complete)"
fi

echo ""
echo "Done. Frontend deployed."
