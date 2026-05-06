#!/usr/bin/env bash
# deploy-frontend.sh — Build Next.js static export and deploy to S3/CloudFront.
#
# Usage:
#   STAGE=dev ./scripts/deploy-frontend.sh
#   STAGE=prod ./scripts/deploy-frontend.sh
#
# Prerequisites:
#   - AWS CLI configured with credentials that have S3 + CloudFront write access
#   - FRONTEND_BUCKET_NAME and CLOUDFRONT_DISTRIBUTION_ID set as env vars
#     (or exported from CDK stack outputs before running this script)

set -euo pipefail

STAGE="${STAGE:-dev}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

: "${FRONTEND_BUCKET_NAME:?Set FRONTEND_BUCKET_NAME from StorageStack CDK output}"
: "${CLOUDFRONT_DISTRIBUTION_ID:?Set CLOUDFRONT_DISTRIBUTION_ID from StorageStack CDK output}"

echo "==> Building static export (stage=$STAGE)..."
cd "$ROOT_DIR"
npm run build

echo "==> Syncing to s3://$FRONTEND_BUCKET_NAME ..."
aws s3 sync out/ "s3://$FRONTEND_BUCKET_NAME" \
  --delete \
  --cache-control "public, max-age=31536000, immutable" \
  --exclude "*.html" \
  --exclude "*.json"

# HTML and JSON files should not be cached aggressively
aws s3 sync out/ "s3://$FRONTEND_BUCKET_NAME" \
  --delete \
  --cache-control "public, max-age=0, must-revalidate" \
  --include "*.html" \
  --include "*.json"

echo "==> Invalidating CloudFront distribution $CLOUDFRONT_DISTRIBUTION_ID ..."
aws cloudfront create-invalidation \
  --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" \
  --paths "/*"

echo "==> Frontend deployed successfully."
