# Louis — AWS Migration

Louis is an AI-powered legal document workspace. Upload documents, chat with an AI assistant, get tracked-change edits, run tabular reviews across document sets, and share projects with colleagues.

Licensed AGPL-3.0.

## Architecture

```
CloudFront → S3 (static Next.js export)

API Gateway REST API (Cognito User Pool authorizer)
└→ Lambda container (Express + serverless-http + Lambda Powertools)
└→ Supabase Postgres (application data)

AgentCore Runtime (JWT inbound authorizer — Cognito OIDC)
└→ Strands agent (10 tools, Bedrock Claude)
└→ Supabase Postgres

S3 PutObject (.docx) → Lambda container (LibreOffice DOCX→PDF)

Cognito Identity Pool (native User Pool federation)
└→ temporary IAM creds for frontend S3 uploads

LLM → Amazon Bedrock Converse API (Claude only)
```

Auth: Cognito User Pool issues the id token. API Gateway validates it via the native Cognito authorizer. AgentCore validates it via JWT inbound authorizer. S3 access uses the id token exchanged for IAM creds via the Cognito Identity Pool. A Pre-Token Generation Lambda (V2_0) injects `role: "authenticated"` into every id token so Supabase Third-Party Auth accepts Cognito users as authenticated Postgres users.

## Repo Structure

```
backend/        Express API (unchanged routes, new Lambda entrypoint)
frontend/       Next.js app (unchanged UI, Amplify Auth transport layer)
infra/          CDK app — StorageStack, AuthStack, ApiStack, ConversionStack
agent/          AgentCore agent (Strands, 10 tools, ARM64 container)
conversion/     LibreOffice Lambda container (DOCX→PDF, x86_64)
scripts/        Deploy and utility scripts
```

## Prerequisites

- AWS CLI configured for `eu-west-1`
- Node 20
- Docker (for container Lambda builds)
- CDK bootstrapped: `npx cdk bootstrap aws://ACCOUNT_ID/eu-west-1`

## First-Time Setup

### 1. Run DB migration

In the Supabase SQL editor:

```sql
ALTER TABLE chats ADD COLUMN IF NOT EXISTS agentcore_session_id TEXT;
```

### 2. Deploy CDK stacks (in order)

```bash
cd infra && npm install

npx cdk deploy StorageStack    -c stage=dev
npx cdk deploy AuthStack       -c stage=dev
npx cdk deploy ApiStack        -c stage=dev
npx cdk deploy ConversionStack -c stage=dev
```

Note the outputs — you'll need them below.

### 3. Populate the Supabase secret

```bash
aws secretsmanager put-secret-value \
  --secret-id YOUR_SUPABASE_SECRET_ARN \
  --secret-string '{"url":"https://YOUR_PROJECT.supabase.co","serviceRoleKey":"YOUR_SERVICE_ROLE_KEY"}' \
  --region eu-west-1
```

### 4. Configure Supabase Third-Party Auth (once)

In Supabase Dashboard → Authentication → Sign In / Sign Up → Third-Party Auth → Add provider → OpenID Connect:

- **Issuer URL:** `https://cognito-idp.eu-west-1.amazonaws.com/<UserPoolId>` (from AuthStack output)
- **Client ID:** leave blank

### 5. Deploy the AgentCore agent

```bash
npm install -g @aws/agentcore
cd agent && npm install && npm run build
AWS_ACCOUNT_ID=YOUR_ACCOUNT_ID AWS_REGION=eu-west-1 ../scripts/deploy-agent.sh
```

### 6. Configure frontend env vars

```bash
cp frontend/.env.local.example frontend/.env.local
# Fill in values from CDK outputs and AgentCore deploy output
```

### 7. Deploy frontend

```bash
cd frontend && npm install
FRONTEND_BUCKET=YOUR_BUCKET CF_DISTRIBUTION=YOUR_DIST_ID ../scripts/deploy-frontend.sh
```

## Redeploying Frontend

Any time you change frontend code, rebuild and redeploy — three steps handled by the script:

```bash
FRONTEND_BUCKET=YOUR_BUCKET CF_DISTRIBUTION=YOUR_DIST_ID ./scripts/deploy-frontend.sh
```

This runs `npm run build` (Next.js static export → `frontend/out/`), syncs to S3 with `--delete`, then creates a CloudFront invalidation on `/*`. Set `WAIT=1` to block until the CDN cache is fully cleared before returning.

Both values come from the `StorageStack` CDK outputs.

## CDK Stacks

| Stack | Provisions |
|---|---|
| `StorageStack` | S3 docs bucket (private, per-user prefix), S3 frontend bucket, CloudFront + OAC |
| `AuthStack` | Cognito User Pool (TOTP MFA, strong password, email verification), App Client, Pre-Token Gen Lambda, Identity Pool |
| `ApiStack` | REST API Gateway (Cognito authorizer), API Lambda (ARM64 container), Secrets Manager secret |
| `ConversionStack` | LibreOffice Lambda (x86_64 container), S3 event trigger |

All buckets: `blockPublicAccess: BLOCK_ALL`. CloudFront uses OAC. API Gateway: native Cognito User Pool authorizer on all routes.

Synth without deploying:

```bash
cd infra && npx cdk synth -c stage=dev
```

## Environment Variables

### Backend Lambda (set by CDK — do not configure manually in prod)

| Var | Description |
|---|---|
| `SUPABASE_SECRET_ARN` | Secrets Manager ARN for `{ url, serviceRoleKey }` |
| `S3_BUCKET_NAME` | Documents S3 bucket (from StorageStack output) |
| `FRONTEND_URL` | CloudFront domain for CORS |
| `POWERTOOLS_SERVICE_NAME` | `louis-api` |

### Frontend (build-time, `NEXT_PUBLIC_*`)

| Var | Description |
|---|---|
| `NEXT_PUBLIC_USER_POOL_ID` | Cognito User Pool ID (AuthStack output) |
| `NEXT_PUBLIC_USER_POOL_CLIENT_ID` | Cognito App Client ID (AuthStack output) |
| `NEXT_PUBLIC_IDENTITY_POOL_ID` | Cognito Identity Pool ID (AuthStack output) |
| `NEXT_PUBLIC_DOCS_BUCKET_NAME` | S3 docs bucket name (StorageStack output) |
| `NEXT_PUBLIC_API_URL` | API Gateway URL (ApiStack output) |
| `NEXT_PUBLIC_AGENTCORE_URL` | AgentCore invocation endpoint |

## Models

Three Claude tiers via Bedrock (eu-west-1 cross-region inference):

| UI label | Logical ID | Bedrock model |
|---|---|---|
| Claude Opus 4.7 | `claude-opus-4-7` | `eu.anthropic.claude-opus-4-7-20251101-v1:0` |
| Claude Sonnet 4.6 *(default)* | `claude-sonnet-4-6` | `eu.anthropic.claude-sonnet-4-6-20250922-v1:0` |
| Claude Haiku 4.5 | `claude-haiku-4-5` | `eu.anthropic.claude-haiku-4-5-20251001-v1:0` |

Model is selected per conversation — switching mid-conversation is supported.

## Checks

```bash
npm run build:lambda --prefix backend
cd infra && npx tsc --noEmit
cd agent && npm run build
cd conversion && npm run build
npm run build --prefix frontend
```

## License

AGPL-3.0-only. See `LICENSE`.
