# Louis

## It's time to Litt up!

Louis is a fork of [MikeOSS](https://github.com/willchen96/mike) — an AWS-native implementation of the same AI-powered legal document workspace. 

<video src="assets/demo.mp4" controls width="100%"></video>

`00:00` Document interaction · `00:13` Redlining · `00:33` Tabular Review · `00:46` Web Search · `00:59` Web Search allowlist block · `01:07` Skills · `01:37` MCP

## Highlights

- **No vendor API keys** — Claude is accessed via Amazon Bedrock; model access is an IAM permission, not a stored secret
- **No long-lived credentials** — short-lived STS credentials scoped per-user; Lambda and AgentCore assume IAM roles at runtime
- [**Bedrock AgentCore Runtime microVM isolation**](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html) — each agent invocation runs in an isolated microVM; session state is scoped per-user and never shared across tenants
- **Serverless** — Amazon Aurora Serverless v2, AWS Lambda, pay-per-request Amazon DynamoDB; no servers to run or patch
- **Built-in observability** — structured JSON logs, AWS X-Ray tracing, and Amazon CloudWatch metrics on every Lambda invocation via AWS Lambda Powertools. AWS CloudTrail tracks API calls.
- [**Strands Agents SDK**](https://strandsagents.com/) — model-agnostic agentic framework; swap between Claude models (or any Bedrock-supported model) by changing a model ID, not rewriting agent logic
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
- **Transaction Search sampling** — defaults to `5%` (`indexingPercentage: 5` in `ApiStack`). Set to `100` for full trace coverage, `0` to disable. Higher percentages increase CloudWatch Logs ingest cost
- **MFA** — TOTP (authenticator app) is enabled as optional (`cognito.Mfa.OPTIONAL`, `otp: true`). Change to `cognito.Mfa.REQUIRED` in `AuthStack` to enforce it for all users. SMS MFA is not configured (requires SNS sandbox approval)

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
npx cdk deploy StorageStack DatabaseStack AuthStack AgentStack ApiStack
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
cp frontend/.env.example frontend/.env
# Fill in values from CloudFormation outputs
```

```env
VITE_AWS_REGION=eu-west-1
VITE_USER_POOL_ID=eu-west-1_XXXXXXXXX
VITE_USER_POOL_CLIENT_ID=XXXXXXXXXXXXXXXXXXXXXXXXXX
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
| CDK stack (general) | `cd infra && npx cdk deploy <STACK>` |
| Admin config (MCP, Chrome policy) | `cd infra && npx cdk deploy AgentStack` |
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
aws s3 rm s3://SKILLS_BUCKET_NAME --recursive
aws s3 rm s3://ADMIN_BUCKET_NAME --recursive
aws s3 rm s3://FRONTEND_BUCKET_NAME --recursive
```

**3. Delete any Secrets Manager secrets** created for MCP server auth (not managed by CDK):

```bash
aws secretsmanager list-secrets --filters Key=name,Values=louis/mcp/ --query "SecretList[*].ARN" --output text \
  | tr '\t' '\n' \
  | xargs -I{} aws secretsmanager delete-secret --secret-id {} --force-delete-without-recovery
```

**4. Destroy CDK stacks**

```bash
cd infra
npx cdk destroy ConversionStack ApiStack AgentStack AuthStack DatabaseStack StorageStack
```

**5. Clean up remaining resources manually if needed**

- SSM parameters under `/louis/` — not managed by CDK stacks
- Any CloudWatch log groups not deleted by the stack
- Verify S3 buckets are gone in the console (deletion can fail silently if not empty)

## Additional Features

### Web Search

The agent can fetch pages from a curated set of legal and regulatory websites: curia.europa.eu, eur-lex.europa.eu, www.bailii.org, www.edpb.europa.eu, www.ico.org.uk, www.fca.org.uk, find.companieshouse.gov.uk. The allowlist is configurable via `browse-allowlist.json` in the admin S3 bucket — no redeployment needed.

### Strands Skills

Users can upload [**Skills**](https://skills.md/) via the UI, which saves them into S3. The repo seeds a sample [EU AI System Classifier](https://lawve.ai/en/skills/eu-ai-act-classification-werner-plutat) Skill by Werner Plutat. You can find many more on [Lawve AI](https://lawve.ai/en).

**Limitations:** Skills are read-only. The agent cannot execute scripts — this is to reduce the risk of privilege escalation.

### MCP Servers

The AWS administrator can connect approved [Model Context Protocol](https://modelcontextprotocol.io) servers to the agent by uploading `mcp.json` to the admin S3 bucket. Users can toggle individual servers on or off in **Agent Settings** in their **Account Settings**. The repo seeds the [Lex API MCP Server](https://lex.lab.i.ai.gov.uk/).

For authenticated servers, store the API key as an AWS Secrets Manager secret under the `louis/mcp/` prefix (e.g. `louis/mcp/my-server`) and reference it in `mcp.json`:

```json
{
  "mcpServers": {
    "my-server": {
      "url": "https://example.com/mcp",
      "authSecretName": "louis/mcp/my-server"
    }
  }
}
```

The agent fetches the secret at cold start and sends it as a `Bearer` token. The key never appears in `mcp.json` or S3.

**Limitations:**

- Only static Bearer token auth is supported. OAuth 2.0 / three-legged OAuth (3LO) flows are not supported — servers requiring interactive sign-in (e.g. GitHub/Google OAuth) cannot be used without AgentCore Gateway.
- **Only HTTP (StreamableHTTP) transport is supported.**


### Observability

[**AgentCore Observability**](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-get-started.html) is turned on, allowing you to investigate traces. These are captured as X-Ray spans and indexed in CloudWatch via **Transaction Search** (5% sampling, configurable — see below).

CloudWatch Logs capture structured runtime output under `/aws/bedrock-agentcore/runtimes/`. X-Ray service maps show latency across AgentCore, Bedrock, and downstream services.

---

## Ideas for Extension

**Agents & AI**
- **Migrate agents to Python** — the Strands Agents SDK is Python-native and receives more active development, richer documentation, and broader community support than the TypeScript port. The primary consideration is rewriting the DOCX tracked-changes logic (`docxTrackedChanges.ts`), which performs raw XML surgery and has no direct `python-docx` equivalent.
- **Agentic Memory (STM and/or LTM)** — persist user/matter context across sessions using Amazon Bedrock AgentCore Memory
- **Agentic RAG** — incorporate Bedrock Knowledge Bases; agents retrieve relevant clauses before responding rather than loading full documents into context
- **AgentCore Gateway** — fully managed MCP-compatible gateway that converts Lambda functions and APIs into agent tools with semantic discovery, unified auth, and server-side tool execution; eliminates client-side orchestration loops
- **Fine-grained tool access** - using AgentCore Policy
- **Evals & quality tracking** — enable AgentCore Observability for logging/tracing + AgentCore Evaluations to measure answer quality over time and catch regressions on model upgrades

**Platform & Scale**
- **Decoupling** — with SQS
- **Usage analytics** — with Amazon Quick
- **Structured logging** — replace `console.log/error` in Lambda route files with AWS Lambda Powertools Logger for consistent JSON logs, correlation IDs, and CloudWatch Insights compatibility

**Auth & Multi-tenancy**
- **Firm-level tenancy** — add an `organisation_id` tier; Cognito user groups + IAM permission boundaries to enforce firm isolation at the AWS level
- **SSO / SAML federation** — Cognito identity provider federation with Active Directory or Okta via SAML 2.0

**Security** — see Disclaimer below

## Disclaimer

This project was built entirely in personal time, using personal AWS accounts and personal resources. It is not affiliated with, endorsed by, or connected to my employer in any way. Any views, decisions, or opinions reflected in this project are solely my own.

Nothing in this software or its outputs constitutes legal advice. The tool is designed to assist with document review and drafting, but it can and does make mistakes. Do not rely on anything it produces as a substitute for advice from a qualified lawyer.

This personal project was built as a learning exercise and vibe-coded with [Claude Code](https://claude.ai/code). It is not production-ready. Before deploying to any real environment, ensure you conduct appropriate security testing, review all permissions and data handling practices, and satisfy yourself that the software meets your technical requirements.

## Security Notice

This deployment is intentionally minimal. Depending on your threat model, you may or may not want to consider additions such as:

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
