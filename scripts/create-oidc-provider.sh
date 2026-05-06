#!/bin/bash
# Run once per AWS account to register Supabase as an OIDC provider in IAM.
# Usage: SUPABASE_URL=https://xxxx.supabase.co ./scripts/create-oidc-provider.sh

set -e

if [ -z "$SUPABASE_URL" ]; then
  echo "Error: SUPABASE_URL env var required"
  exit 1
fi

JWKS_URI="${SUPABASE_URL}/auth/v1/.well-known/jwks.json"
ISSUER_URL="${SUPABASE_URL}/auth/v1"

echo "Creating IAM OIDC provider for $ISSUER_URL"

aws iam create-open-id-connect-provider \
  --url "$ISSUER_URL" \
  --client-id-list "mike-on-aws" \
  --thumbprint-list "0000000000000000000000000000000000000000"

echo "Done. OIDC provider created."
echo "ARN: arn:aws:iam::$(aws sts get-caller-identity --query Account --output text):oidc-provider/${ISSUER_URL#https://}"
