# Louis

It's time to Litt up!

Louis is a fork of [MikeOSS](https://github.com/willchen96/mike) — an AWS-native implementation of the same AI-powered legal document workspace. 

**DEMO TO DO**

## Highlights

- **No vendor API keys** — Claude is accessed via Amazon Bedrock; model access is an IAM permission, not a stored secret
- **No long-lived credentials** — short-lived STS credentials scoped per-user; Lambda and AgentCore assume IAM roles at runtime
- **Per-user data isolation at the IAM layer** — S3 bucket policies scope each user to their own prefix via `${cognito-identity.amazonaws.com:sub}` (Identity Pool identity ID), enforced by AWS not application code
- **Serverless** — Aurora Serverless v2, Lambda, pay-per-request DynamoDB; no servers to run or patch
- **Built-in observability** — structured JSON logs, X-Ray tracing, and CloudWatch metrics on every Lambda invocation via AWS Lambda Powertools
- **Strands Agents SDK** — model-agnostic agentic framework; swap between Claude models (or any Bedrock-supported model) by changing a model ID, not rewriting agent logic
- **Bedrock cross-region inference** — automatic routing across EU regions for resilience and throughput; can be scoped to a single AWS region if needed

## Architecture

![assets/architecture.png](assets/architecture.png)

- Frontend (React + Vite) → Amazon API Gateway → AWS Lambda (Express) → Amazon Aurora Serverless v2
- Documents stored in S3; LibreOffice container Lambda handles DOCX→PDF conversion
- Amazon Bedrock AgentCore Runtime hosts two Strands SDK agents using models on Amazon Bedrock

This repo deploys resources in `eu-west-1` (Dublin).

See [ARCHITECTURE.md](ARCHITECTURE.md) for full detail.

## High-Level Repo Structure

```text
frontend/       React + Vite SPA (Amplify Auth)
infra/          CDK app — StorageStack, DatabaseStack, AuthStack, ApiStack, ConversionStack
agents/         AgentCore agents (main chat + tabular review)
conversion/     LibreOffice Lambda container (DOCX→PDF, x86_64)
scripts/        Deploy and utility scripts
```
See [ARCHITECTURE.md](ARCHITECTURE.md) for full detail.

## Prerequisites

- AWS CLI v2.34.45+ configured for `eu-west-1` with valid credentials (`aws sts get-caller-identity` should return your account ID)
- Node 22
- **Amazon Bedrock model access** — request access in the Bedrock console for the models used (Claude on Anthropic requires submitting a use case description before access is granted)
- **Finch** — container runtime required only for `ConversionStack` builds
  ```bash
  brew install --cask finch
  ```
- CDK bootstrapped:
  ```bash
  npx cdk bootstrap aws://ACCOUNT_ID/eu-west-1
  ```

## First-Time Deployment

### Configuration notes

Before deploying, review these settings in `infra/`:

- **Bedrock model IDs** — update model ID constants if you want to swap Claude versions or use a different model
- **Aurora minimum ACU** — defaults to `0` (scales to zero). Set a non-zero minimum (e.g. `0.5`) to avoid cold-start latency on the first query after idle
- **Lambda provisioned concurrency** — not configured by default; the API and agent Lambdas will cold-start after periods of inactivity. Add provisioned concurrency to `ApiStack` / agent function if you need consistent response times

**Deletion policies — review before deploying to anything real:**

All stacks currently use `RemovalPolicy.DESTROY`. This means `cdk destroy` (or an accidental stack deletion) will **permanently delete all data** with no recovery path. The specific risks:

| Resource | Stack | Current policy | Safer alternative |
|---|---|---|---|
| S3 buckets (docs, sessions, frontend, deploy) | `StorageStack` | `DESTROY` + `autoDeleteObjects: true` | `RETAIN` |
| Aurora cluster + subnet group | `DatabaseStack` | `DESTROY` | `SNAPSHOT` (preserves a final snapshot) |
| Cognito User Pool | `AuthStack` | `DESTROY` | `RETAIN` |
| CloudWatch Log Group | `ApiStack` | `DESTROY` | `RETAIN` |

Change `RemovalPolicy.DESTROY` → `RemovalPolicy.RETAIN` (or `SNAPSHOT` for Aurora) in the relevant stack files before deploying to a real environment.

### 1. Deploy CDK stacks

```bash
cd infra && npm install
npx cdk deploy StorageStack DatabaseStack AuthStack ApiStack
```

For `ConversionStack`, Finch must be running:

```bash
finch vm init       # one-time — creates the Linux VM
finch vm start
export CDK_DOCKER=finch
npx cdk deploy ConversionStack
finch vm stop
```

### 2. Initialise the database schema

```bash
./scripts/init-db.sh
```

Reads `ClusterArn`, `SecretArn`, `DatabaseName` from `DatabaseStack` outputs and applies `infra/migrations/000_one_shot_schema.sql` via the RDS Data API.

### 3. Deploy AgentCore agents

```bash
AWS_REGION=eu-west-1 ./scripts/deploy-agent.sh louisMain
AWS_REGION=eu-west-1 ./scripts/deploy-agent.sh louisTabular
```

Builds, zips, uploads to S3, and creates/updates the agent runtime. Runtime IDs stored in SSM under `/louis/agents/`. No Docker or agentcore CLI required.

### 4. Configure frontend environment

```bash
cp frontend/.env.local.example frontend/.env.local
# Fill in values from CloudFormation outputs
```

```env
VITE_AWS_REGION=eu-west-1
VITE_USER_POOL_ID=eu-west-1_XXXXXXXXX
VITE_USER_POOL_CLIENT_ID=XXXXXXXXXXXXXXXXXXXXXXXXXX
VITE_IDENTITY_POOL_ID=eu-west-1:XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX
VITE_DOCS_BUCKET_NAME=your-docs-bucket-name
VITE_API_URL=https://XXXXXXXXXX.execute-api.eu-west-1.amazonaws.com/prod

# AgentCore ARNs (used to build invocation URLs at runtime)
VITE_AGENTCORE_MAIN_ARN=arn:aws:bedrock:eu-west-1:XXXXXXXXXXXX:agent-runtime/XXXXXXXXXX
VITE_AGENTCORE_TABULAR_ARN=arn:aws:bedrock:eu-west-1:XXXXXXXXXXXX:agent-runtime/XXXXXXXXXX
```

### 5. Deploy frontend

```bash
AWS_REGION=eu-west-1 ./scripts/deploy-frontend.sh
```

Runs `vite build`, syncs the output to S3, and invalidates the CloudFront cache. Set `WAIT=1` to block until the CDN clears.

## Redeploying

| What changed | Command |
|---|---|
| CDK stack | `cd infra && npx cdk deploy <STACK>` |
| Agents | `AWS_REGION=eu-west-1 ./scripts/deploy-agent.sh louisMain` (or `louisTabular`) |
| Frontend | `AWS_REGION=eu-west-1 ./scripts/deploy-frontend.sh` |
| ConversionStack | `finch vm start && export CDK_DOCKER=finch && npx cdk deploy ConversionStack && finch vm stop` |

## Cleanup

> **Warning:** Destroying `DatabaseStack` drops the Aurora cluster permanently (unless you changed to `SNAPSHOT` removal policy). Back up any data first.

**1. Destroy AgentCore runtimes**

```bash
AWS_REGION=eu-west-1 ./scripts/destroy-agent.sh louisMain
AWS_REGION=eu-west-1 ./scripts/destroy-agent.sh louisTabular
```

**2. Empty S3 buckets** (CDK cannot delete non-empty buckets unless `autoDeleteObjects` is set — check your removal policy)

```bash
aws s3 rm s3://DOCS_BUCKET_NAME --recursive
aws s3 rm s3://SESSIONS_BUCKET_NAME --recursive
aws s3 rm s3://FRONTEND_BUCKET_NAME --recursive
```

**3. Destroy CDK stacks**

```bash
cd infra
npx cdk destroy ConversionStack ApiStack AuthStack DatabaseStack StorageStack
```

**4. Clean up remaining resources manually if needed**

- SSM parameters under `/louis/` — not managed by CDK stacks
- Any CloudWatch log groups not deleted by the stack
- Verify S3 buckets are gone in the console (deletion can fail silently if not empty)

## Ideas for Extension

**Agents & AI**
- **Agentic Memory (STM and/or LTM)** — persist user/matter context across sessions using Amazon Bedrock AgentCore Memory
- **Agentic RAG** — incorporate Bedrock Knowledge Bases; agents retrieve relevant clauses before responding rather than loading full documents into context
- **AgentCore Gateway** — fully managed MCP-compatible gateway that converts Lambda functions and APIs into agent tools with semantic discovery, unified auth, and server-side tool execution; eliminates client-side orchestration loops
- **Fine-grained tool access** - using AgentCore Policy
- **Evals & quality tracking** — enable AgentCore Observability for logging/tracing + AgentCore Evaluations to measure answer quality over time and catch regressions on model upgrades

**Platform & Scale**
- **Decoupling** — with SQS
- **Usage analytics** — with Amazon Quick

**Auth & Multi-tenancy**
- **Firm-level tenancy** — add an `organisation_id` tier; Cognito user groups + IAM permission boundaries to enforce firm isolation at the AWS level
- **SSO / SAML federation** — Cognito identity provider federation with Active Directory or Okta via SAML 2.0

**Security** — see Disclaimer below

## Disclaimer

This project was built as a learning exercise and vibe-coded with [Claude Code](https://claude.ai/code). It is not production-ready and comes with no warranties.

**Not legal advice.** Nothing in this software or its outputs constitutes legal advice. Always consult a qualified lawyer.

**Security notice.** This deployment is intentionally minimal. Depending on your threat model, you may or may not want to consider additions such as:

- VPC with private subnets and VPC endpoints (S3, Bedrock, RDS, SSM) to keep traffic off the public internet
- AWS WAF on CloudFront and API Gateway for OWASP rule sets and rate limiting
- API Gateway usage plans and per-client throttling/quotas
- Amazon Bedrock Guardrails for content filtering and prompt injection defence
- AWS Config rules and Security Hub for continuous compliance monitoring
- Amazon GuardDuty for threat detection
- Service Control Policies (SCPs) in AWS Organizations to enforce guardrails at the account level
- Tighter IAM least-privilege scoping — Lambda and agent execution roles are currently broad
- Secrets Manager rotation for database credentials
- CloudTrail and VPC Flow Logs for auditability
- Customer-managed KMS keys (CMKs) for S3, Aurora, and Secrets Manager encryption at rest
- Data retention policies such as S3 lifecycle rules, Aurora automated backup windows, and log retention periods in CloudWatch

## License

AGPL-3.0-only. See `LICENSE`.
