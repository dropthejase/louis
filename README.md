# Louis — AWS

Louis is an AI-powered legal document workspace. Upload documents, chat with an AI assistant, get tracked-change edits, run tabular reviews across document sets, and share projects with colleagues.

Licensed AGPL-3.0.

## Architecture

```text
CloudFront → S3 (static Next.js export)

API Gateway REST API (Cognito User Pool authorizer)
└→ Lambda container (Express + serverless-http + Lambda Powertools)
└→ Aurora Serverless v2 PostgreSQL 16.3 (RDS Data API, VPC isolated subnets)

AgentCore Runtime (JWT inbound authorizer — Cognito OIDC)
└→ Strands agent (10 tools, Bedrock Claude)
└→ DynamoDB (per-user monthly credits tracking via after_model_call hook)

S3 PutObject (.docx/.doc) → EventBridge → Lambda container (LibreOffice DOCX→PDF)

Cognito Identity Pool (native User Pool federation)
└→ temporary IAM creds for frontend S3 uploads

LLM → Amazon Bedrock Converse API (Claude only, eu-west-1 cross-region inference)
```

Auth: Cognito User Pool issues the id token. API Gateway validates it via the native Cognito authorizer. AgentCore validates it via JWT inbound authorizer. S3 access uses the id token exchanged for temporary IAM creds via the Cognito Identity Pool.

## Repo Structure

```text
backend/        Express API (Lambda entrypoint via serverless-http)
frontend/       Next.js app (static export, Amplify Auth)
infra/          CDK app — StorageStack, DatabaseStack, AuthStack, ApiStack, ConversionStack
agents/         AgentCore agents; app/main = main chat, app/tabular = tabular review chat
conversion/     LibreOffice Lambda container (DOCX→PDF, x86_64)
scripts/        Deploy and utility scripts
```

## Prerequisites

- AWS CLI configured for `eu-west-1`
- Node 20
- **Finch** — required only for building the LibreOffice conversion Lambda container
- CDK bootstrapped: `npx cdk bootstrap aws://ACCOUNT_ID/eu-west-1`

### Installing Finch

Finch is an open-source container runtime from AWS (replaces Docker Desktop for container builds).

```bash
# macOS (Homebrew) — one-time install
brew install --cask finch
finch vm init    # creates the Linux VM (one-time, takes a few minutes)
```

Before each container build session:

```bash
finch vm start
```

After you're done building:

```bash
finch vm stop    # frees the VM resources
```

CDK uses the `CDK_DOCKER` environment variable to select the container build tool:

```bash
export CDK_DOCKER=finch
```

Add to your shell profile (`~/.zshrc` or `~/.bashrc`) so it persists. CDK calls `finch build` instead of `docker build` for container image assets.

> **Note:** Finch is only required when deploying `ConversionStack`. All other stacks (including the AgentCore agent) use zip-based packaging — no container build needed.

## First-Time Deployment

### 1. Deploy CDK stacks

```bash
cd infra && npm install

npx cdk deploy StorageStack
npx cdk deploy DatabaseStack
npx cdk deploy AuthStack
npx cdk deploy ApiStack
```

For ConversionStack, Finch must be running first:

```bash
finch vm start
export CDK_DOCKER=finch
npx cdk deploy ConversionStack
finch vm stop
```

Deploy order matters: DatabaseStack before AuthStack and ApiStack. ConversionStack last.

### 2. Initialise the database schema

```bash
# From repo root
./scripts/init-db.sh
```

Reads `ClusterArn`, `SecretArn`, `DatabaseName` from the `DatabaseStack` CloudFormation outputs and runs `backend/migrations/000_one_shot_schema.sql` via the RDS Data API. Safe to re-run (all statements are idempotent).

### 3. Deploy the AgentCore agents

```bash
# From repo root — reads all config from CFN outputs, no CLI tooling required
AWS_REGION=eu-west-1 ./scripts/deploy-agent.sh louisMain
AWS_REGION=eu-west-1 ./scripts/deploy-agent.sh louisTabular
```

Builds the agent (`tsc` + `npm ci --omit=dev`), zips `dist/` + `node_modules/`, uploads to the `AgentDeployBucket` S3 bucket, then calls `create-agent-runtime` (first run) or `update-agent-runtime` (subsequent runs). Runtime ID and ARN are stored in SSM at `/louis/agents/louisMain/runtimeId` and `/louis/agents/louisMain/runtimeArn`. No Docker or agentcore CLI required.

### 4. Configure frontend environment

```bash
cp frontend/.env.local.example frontend/.env.local
# Fill in values from CDK outputs and AgentCore deploy output
```

### 5. Deploy frontend

```bash
# From repo root
FRONTEND_BUCKET=YOUR_BUCKET CF_DISTRIBUTION=YOUR_DIST_ID ./scripts/deploy-frontend.sh
```

Runs `npm run build` (Next.js static export → `frontend/out/`), syncs to S3 with `--delete`, then creates a CloudFront invalidation on `/*`. Set `WAIT=1` to block until the CDN cache clears.

Both values come from `StorageStack` CDK outputs.

## Redeploying

**Backend / API changes:**

```bash
export CDK_DOCKER=finch
cd infra && npx cdk deploy ApiStack
```

**Agent changes:**

```bash
AWS_REGION=eu-west-1 ./scripts/deploy-agent.sh louisMain
AWS_REGION=eu-west-1 ./scripts/deploy-agent.sh louisTabular
```

**Frontend changes:**

```bash
FRONTEND_BUCKET=YOUR_BUCKET CF_DISTRIBUTION=YOUR_DIST_ID ./scripts/deploy-frontend.sh
```

**Conversion Lambda changes** (requires Finch):

```bash
export CDK_DOCKER=finch
cd infra && npx cdk deploy ConversionStack
```

## CDK Stacks

| Stack | Provisions |
| --- | --- |
| `StorageStack` | S3 docs bucket (private, EventBridge enabled), S3 sessions + frontend + agent deploy buckets, CloudFront + OAC |
| `DatabaseStack` | Aurora Serverless v2 PostgreSQL 16.3 (min 0 / max 1 ACU, RDS Data API, VPC isolated subnets, auto-pause) |
| `AuthStack` | Cognito User Pool (TOTP MFA, email verification), App Client, Post-Confirmation Lambda (creates user_profiles row), Identity Pool, authenticated IAM role |
| `ApiStack` | REST API Gateway (Cognito authorizer), API Lambda (ARM64 container), AgentCore execution IAM role, DynamoDB credits table |
| `ConversionStack` | LibreOffice Lambda (x86_64 container), EventBridge rule triggering on `.docx`/`.doc` uploads to `documents/` prefix |

All buckets: `blockPublicAccess: BLOCK_ALL`. CloudFront uses OAC (no public S3 access). Aurora: `DESTROY` removal policy — fully cleaned up on `cdk destroy`.

Synth without deploying:

```bash
export CDK_DOCKER=finch
cd infra && npx tsc --noEmit && npx cdk synth
```

## Credits / Usage Metering

Per-user monthly credit tracking via DynamoDB:

- **Table:** `PK=userId`, `SK=YYYY-MM`, `credits_used` (atomic `UpdateItem ADD`)
- **Increment:** Strands `after_model_call` hook runs after each successful AgentCore model invocation
- **Enforcement:** agent returns `error` SSE event when limit exceeded; frontend wires to `CreditsExhaustedModal`
- **IAM:** AgentCore execution role has `dynamodb:GetItem` + `dynamodb:UpdateItem` on credits table only

## Environment Variables

### Backend Lambda (set by CDK — do not configure manually)

| Var | Description |
| --- | --- |
| `DB_CLUSTER_ARN` | Aurora cluster ARN (DatabaseStack output) |
| `DB_SECRET_ARN` | RDS-managed credentials secret ARN (DatabaseStack output) |
| `DB_NAME` | Database name (`mike`) |
| `DOCS_BUCKET_NAME` | Documents S3 bucket name (StorageStack output) |
| `SESSIONS_BUCKET_NAME` | Sessions S3 bucket name (StorageStack output) |
| `USER_POOL_ID` | Cognito User Pool ID (AuthStack output) |
| `FRONTEND_URL` | CloudFront domain for CORS (StorageStack output) |

### Frontend (build-time, `NEXT_PUBLIC_*`)

| Var | Description |
| --- | --- |
| `NEXT_PUBLIC_USER_POOL_ID` | Cognito User Pool ID (AuthStack output) |
| `NEXT_PUBLIC_USER_POOL_CLIENT_ID` | Cognito App Client ID (AuthStack output) |
| `NEXT_PUBLIC_IDENTITY_POOL_ID` | Cognito Identity Pool ID (AuthStack output) |
| `NEXT_PUBLIC_DOCS_BUCKET_NAME` | S3 docs bucket name (StorageStack output) |
| `NEXT_PUBLIC_API_URL` | API Gateway invoke URL (ApiStack output) |
| `NEXT_PUBLIC_AGENTCORE_URL` | AgentCore invocation endpoint for main chat (agentcore deploy output) |
| `NEXT_PUBLIC_AGENTCORE_TABULAR_URL` | AgentCore invocation endpoint for tabular review chat (agentcore deploy output) |

## Models

Three Claude tiers via Bedrock (eu-west-1 cross-region inference):

| UI label | Bedrock model ID |
| --- | --- |
| Claude Opus 4.7 | `eu.anthropic.claude-opus-4-7-20251101-v1:0` |
| Claude Sonnet 4.6 *(default)* | `eu.anthropic.claude-sonnet-4-6-20250922-v1:0` |
| Claude Haiku 4.5 | `eu.anthropic.claude-haiku-4-5-20251001-v1:0` |

## Build Checks

```bash
# Backend
cd backend && npx tsc --noEmit

# Infra
cd infra && npx tsc --noEmit

# Agents
cd agents/app/main && npm run build
cd agents/app/tabular && npm run build

# Frontend
cd frontend && npm run build
```

## License

AGPL-3.0-only. See `LICENSE`.
