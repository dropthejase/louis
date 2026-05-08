# Louis — AWS

Louis is an AI-powered legal document workspace. Upload documents, chat with an AI assistant, get tracked-change edits, run tabular reviews across document sets, and share projects with colleagues.

Licensed AGPL-3.0.

## Architecture

```
CloudFront → S3 (static Next.js export)

API Gateway REST API (Cognito User Pool authorizer)
└→ Lambda container (Express + serverless-http + Lambda Powertools)
└→ Aurora Serverless v2 PostgreSQL (RDS Data API — no VPC)

AgentCore Runtime (JWT inbound authorizer — Cognito OIDC)
└→ Strands agent (10 tools, Bedrock Claude)

S3 PutObject (.docx) → Lambda container (LibreOffice DOCX→PDF)

Cognito Identity Pool (native User Pool federation)
└→ temporary IAM creds for frontend S3 uploads

LLM → Amazon Bedrock Converse API (Claude only, eu-west-1)
```

Auth: Cognito User Pool issues the id token. API Gateway validates it via the native Cognito authorizer. AgentCore validates it via JWT inbound authorizer. S3 access uses the id token exchanged for IAM creds via the Cognito Identity Pool.

## Repo Structure

```
backend/        Express API (Lambda entrypoint via serverless-http)
frontend/       Next.js app (static export, Amplify Auth)
infra/          CDK app — StorageStack, AuthStack, DatabaseStack, ApiStack, ConversionStack
agent/          AgentCore agent (Strands, 10 tools, ARM64 container)
conversion/     LibreOffice Lambda container (DOCX→PDF, x86_64)
scripts/        Deploy and utility scripts
```

## Prerequisites

- AWS CLI configured for `eu-west-1`
- Node 20
- **Finch** (container builds — Docker Desktop not required)
- CDK bootstrapped: `npx cdk bootstrap aws://ACCOUNT_ID/eu-west-1`

### Installing Finch

Finch is an open-source container runtime from AWS. It replaces Docker Desktop for building Lambda container images.

```bash
# macOS (Homebrew)
brew install --cask finch

# Start the Finch VM
finch vm init
finch vm start
```

CDK uses the `CDK_DOCKER` environment variable to select the container build tool:

```bash
export CDK_DOCKER=finch
```

Add this to your shell profile (`~/.zshrc` or `~/.bashrc`) so it persists across sessions. CDK will call `finch build` instead of `docker build` for all container image assets.

## First-Time Setup

### 1. Deploy CDK stacks (in order)

```bash
export CDK_DOCKER=finch
cd infra && npm install

npx cdk deploy StorageStack    -c stage=dev
npx cdk deploy DatabaseStack  -c stage=dev
npx cdk deploy AuthStack       -c stage=dev
npx cdk deploy ApiStack        -c stage=dev
npx cdk deploy ConversionStack -c stage=dev
```

Note the outputs — you'll need them in later steps.

### 2. Initialise the database schema

```bash
./scripts/init-db.sh DatabaseStack
```

This runs `backend/migrations/000_one_shot_schema.sql` against the Aurora cluster via the RDS Data API. Safe to re-run (all statements are idempotent).

### 3. Deploy the AgentCore agent

```bash
npm install -g @aws/agentcore
cd agent && npm install && npm run build
AWS_ACCOUNT_ID=YOUR_ACCOUNT_ID AWS_REGION=eu-west-1 ../scripts/deploy-agent.sh
```

### 4. Configure frontend env vars

```bash
cp frontend/.env.local.example frontend/.env.local
# Fill in values from CDK outputs and AgentCore deploy output
```

### 5. Deploy frontend

```bash
cd frontend && npm install
FRONTEND_BUCKET=YOUR_BUCKET CF_DISTRIBUTION=YOUR_DIST_ID ../scripts/deploy-frontend.sh
```

## Redeploying Frontend

```bash
FRONTEND_BUCKET=YOUR_BUCKET CF_DISTRIBUTION=YOUR_DIST_ID ./scripts/deploy-frontend.sh
```

Runs `npm run build` (Next.js static export → `frontend/out/`), syncs to S3 with `--delete`, then creates a CloudFront invalidation on `/*`. Set `WAIT=1` to block until CDN cache clears.

Both values come from `StorageStack` CDK outputs.

## CDK Stacks

| Stack | Provisions |
|---|---|
| `StorageStack` | S3 docs bucket (private, per-user prefix), S3 frontend bucket, CloudFront + OAC |
| `DatabaseStack` | Aurora Serverless v2 PostgreSQL 16.3 (min 0 / max 1 ACU, Data API, auto-pause) |
| `AuthStack` | Cognito User Pool (TOTP MFA, strong password, email verification), App Client, Pre-Token Gen Lambda, Identity Pool |
| `ApiStack` | REST API Gateway (Cognito authorizer), API Lambda (ARM64 container) |
| `ConversionStack` | LibreOffice Lambda (x86_64 container), S3 event trigger |

All buckets: `blockPublicAccess: BLOCK_ALL`. CloudFront uses OAC. API Gateway: native Cognito User Pool authorizer on all routes. Aurora: DESTROY removal policy — fully cleaned up on `cdk destroy`.

Synth without deploying:

```bash
export CDK_DOCKER=finch
cd infra && npx cdk synth -c stage=dev
```

## Environment Variables

### Backend Lambda (set by CDK — do not configure manually)

| Var | Description |
|---|---|
| `DB_CLUSTER_ARN` | Aurora cluster ARN (DatabaseStack output) |
| `DB_SECRET_ARN` | RDS-managed credentials secret ARN (DatabaseStack output) |
| `DB_NAME` | Database name (`louis`) |
| `DOCS_BUCKET_NAME` | Documents S3 bucket (StorageStack output) |
| `SESSIONS_BUCKET_NAME` | Sessions S3 bucket (StorageStack output) |
| `USER_POOL_ID` | Cognito User Pool ID (AuthStack output) |
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
