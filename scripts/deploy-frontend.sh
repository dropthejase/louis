#!/bin/bash
# Deploy Mike frontend: build → S3 sync → CloudFront invalidation.
#
# Required env vars (or pass as arguments):
#   FRONTEND_BUCKET   — S3 bucket name for frontend (StorageStack output)
#   CF_DISTRIBUTION   — CloudFront distribution ID (StorageStack output)
#
# Optional:
#   FRONTEND_DIR      — path to frontend directory (default: frontend)
#   WAIT             — set to 1 to wait for CloudFront invalidation to complete
#
# Usage:
#   FRONTEND_BUCKET=my-bucket CF_DISTRIBUTION=ABCDEF123 ./scripts/deploy-frontend.sh

set -e

FRONTEND_BUCKET=${FRONTEND_BUCKET:?FRONTEND_BUCKET required (StorageStack output)}
CF_DISTRIBUTION=${CF_DISTRIBUTION:?CF_DISTRIBUTION required (StorageStack output)}
FRONTEND_DIR=${FRONTEND_DIR:-frontend}
REGION=${AWS_REGION:-eu-west-1}

echo "==> Building frontend..."
cd "${FRONTEND_DIR}"
npm run build
cd ..

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

if [ "${WAIT}" = "1" ]; then
  echo "==> Waiting for invalidation to complete..."
  aws cloudfront wait invalidation-completed \
    --distribution-id "${CF_DISTRIBUTION}" \
    --id "${INVALIDATION_ID}"
  echo "    Done."
else
  echo "    (set WAIT=1 to block until complete)"
fi

echo "==> Frontend deployed."
