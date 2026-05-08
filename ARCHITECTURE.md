# Louis — Architecture

## Overview

Louis is an AI-powered legal document workspace (AGPL-3.0). Users upload documents, chat with an AI assistant, get tracked-change edits, run tabular reviews across document sets, and share projects with colleagues.

The stack runs entirely on AWS: static Next.js export via CloudFront + S3, Express backend as an ARM64 Lambda container behind API Gateway, AI chat via Amazon Bedrock AgentCore Runtime running a Strands agent, DOCX→PDF conversion as an x86_64 Lambda container triggered by S3 events. Authentication is Cognito User Pool. Application data lives in Aurora Serverless v2 PostgreSQL accessed via the RDS Data API.

---

## System Architecture

```
  ┌──────────────────────────────────────────────────────────────────────────┐
  │  Browser (Amplify Auth v6)                                               │
  └──┬────────────────┬──────────────────┬──────────────────┬───────────────┘
     │ sign-up/login  │ static assets    │ Bearer id token  │ Bearer id token
     ▼                ▼                  ▼                  ▼
┌─────────────────┐  ┌──────────┐  ┌──────────────────┐  ┌─────────────────┐
│ Cognito User    │  │CloudFront│  │ API Gateway(REST) │  │ AgentCore       │
│ Pool            │  │  (OAC)   │  │ Cognito authorizer│  │ JWT authorizer  │
│                 │  └────┬─────┘  └────────┬──────────┘  └────────┬────────┘
│ Post-Confirm    │       │                 │ claims injected       │ validated
│ Lambda          │       ▼                 ▼                       ▼
│ (user_profiles) │  ┌─────────┐  ┌──────────────────┐  ┌─────────────────┐
│                 │  │  S3     │  │ Lambda (ARM64)   │  │ Strands Agent   │
└────────┬────────┘  │(frontend│  │ Express +        │  │ (ARM64)         │
         │           │ bucket) │  │ serverless-http  │  │ 10 tools        │
         │           └─────────┘  │ Powertools       │  │ Bedrock Converse│
         │ federate                └────────┬─────────┘  └────────┬────────┘
         ▼                                  │                      │
┌─────────────────┐           ┌─────────────┼──────────┐          │
│ Cognito         │           ▼             ▼          ▼          ▼
│ Identity Pool   │  ┌──────────────┐  ┌────────┐  ┌───────┐  ┌──────────┐
│                 │  │ Aurora       │  │  S3    │  │Bedrock│  │ Aurora   │
│ issues temp     │  │ Serverless   │  │ (docs  │  │Claude │  │Serverless│
│ IAM creds       │  │ v2 Postgres  │  │ bucket)│  │       │  │v2 Postgres│
└────────┬────────┘  │ (RDS Data    │  └────┬───┘  └───────┘  └──────────┘
         │           │  API)        │       │ S3 PutObject (.docx/.doc)
         ▼           └──────────────┘       ▼
   S3 docs bucket                  ┌──────────────────┐
   (per-user prefix)               │ Conversion Lambda │
                                   │ (x86_64)          │
                                   │ LibreOffice       │
                                   │ DOCX → PDF → S3  │
                                   │ Aurora update     │
                                   └──────────────────┘

  Aurora Serverless v2 is one database — shown twice only to indicate
  both the API Lambda and the Strands Agent connect to it independently
  via the RDS Data API.
```

---

## Auth Flow

Cognito id token is the single auth token. The frontend uses AWS Amplify Auth v6 (`fetchAuthSession()`) to obtain the token and passes it as `Authorization: Bearer <id_token>` to all downstream consumers.

| Consumer | Validation method | What happens |
|---|---|---|
| API Gateway REST API | Native Cognito User Pool authorizer — validates signature against Cognito JWKS; no Lambda cold start | API Gateway injects all JWT claims into `requestContext.authorizer.claims`; Express reads `claims.sub` and `claims.email` from there |
| AgentCore Runtime | JWT inbound authorizer — Cognito User Pool OIDC discovery URL | AgentCore validates the Bearer JWT before `/invocations` is called; `requestHeaderAllowlist: ["Authorization"]` passes the header through; agent decodes `sub` from the token for SQL ownership guards |
| S3 direct upload (frontend) | Cognito Identity Pool — natively federated from Cognito User Pool | Identity Pool exchanges the id token for temporary STS credentials scoped to the authenticated IAM role; frontend uses those for `PutObject`/`GetObject` directly to S3 |

---

## CDK Stacks

All stacks live in `infra/`, deployed with `npx cdk deploy <StackName>`. Cross-stack values flow via CDK `CfnOutput` exports or constructor props.

| Stack | What it provisions | Key outputs |
|---|---|---|
| `StorageStack` | S3 docs bucket (private, EventBridge enabled, CORS); S3 frontend bucket; CloudFront distribution with OAC; SPA 404→200 fallback | `DocsBucketName`, `FrontendBucketName`, `DistributionDomainName`, `DistributionId` |
| `DatabaseStack` | Aurora Serverless v2 PostgreSQL 16.3 (min 0 / max 1 ACU, RDS Data API, VPC isolated subnets, auto-pause) | `ClusterArn`, `SecretArn`, `DatabaseName` |
| `AuthStack` | Cognito User Pool (TOTP-only MFA, email verification, strong password policy); App Client (SRP, no client secret); Post-Confirmation Lambda (inserts `user_profiles` row); Identity Pool (native User Pool federation); authenticated IAM role (per-user S3 prefix) | `UserPoolId`, `UserPoolClientId`, `IdentityPoolId`, `AuthenticatedRoleArn` |
| `ApiStack` | REST API Gateway (Cognito authorizer); API Lambda (ARM64 container, 1024 MB, 29 s, Bedrock + S3 + RDS Data API + Secrets Manager permissions); AgentCore execution IAM role; DynamoDB credits table (per-user monthly metering) | `ApiUrl`, `AgentCoreExecutionRoleArn`, `CreditsTableName` |
| `ConversionStack` | Conversion Lambda (x86_64 container, 2048 MB, 5 min); EventBridge rule triggering on `documents/*.docx` + `documents/*.doc` PutObject; RDS Data API + Secrets Manager permissions | `ConversionLambdaArn` |

AgentCore is deployed separately via `@aws/agentcore` CLI (`scripts/deploy-agent.sh`) — not through CDK.

---

## Database

Aurora Serverless v2 PostgreSQL 16.3, accessed exclusively via the RDS Data API (no VPC egress needed from Lambda). All queries use the `query` / `queryOne` / `execute` helpers in `backend/src/lib/db.ts` (and a copy in `agent/src/lib/db.ts`) which wrap `RDSDataClient` with `formatRecordsAs: "JSON"`.

Schema is loaded once via `scripts/init-db.sh` from `backend/migrations/000_one_shot_schema.sql`. All statements are idempotent — safe to re-run.

Key tables: `user_profiles`, `documents`, `document_versions`, `chats`, `chat_messages`, `projects`, `workflows`, `tabular_reviews`, `tabular_cells`, `tabular_review_chat_messages`.

---

## Agent Architecture

The agent is a Node 20 zip package running an Express HTTP server that implements the AgentCore invocation protocol.

### Security: userId propagation

AgentCore Runtime validates the Cognito JWT before the `/invocations` handler runs. `requestHeaderAllowlist: ["Authorization"]` passes the validated header to agent code. The agent decodes the JWT payload (no signature check — Runtime already verified it) and extracts `sub` as `userId`. The `userId` is never taken from request body or LLM output. All agent DB queries include `WHERE user_id = :userId` (or equivalent ownership JOIN) so cross-user data access is impossible even if the LLM is prompted to try.

### Strands Agent

`agent/src/agent.ts` instantiates a `@strands-agents/sdk` `Agent` with a `BedrockModel` and 10 tools:

| Tool | Purpose |
|---|---|
| `read_document` | Fetch document content from S3 |
| `find_in_document` | Semantic search within a document |
| `list_documents` | List documents in scope (user or project) |
| `fetch_documents` | Batch-fetch multiple documents |
| `generate_docx` | Create a new DOCX from agent-authored content |
| `edit_document` | Apply tracked-change edits to an existing DOCX |
| `replicate_document` | Copy a document within a project (project scope only) |
| `read_table_cells` | Read tabular review cell data (ownership via JOIN to `tabular_reviews`) |
| `list_workflows` | List available workflows (`user_id = :userId OR is_system = true`) |
| `read_workflow` | Fetch a specific workflow definition |

### Credits metering

A Strands `AfterModelCallEvent` hook in `agent/src/agent.ts` increments `credits_used` in DynamoDB (`PK=userId`, `SK=YYYY-MM`, atomic ADD) after each successful model call. The API backend checks DynamoDB before allowing a new chat invocation and returns 429 when the monthly limit is exceeded; the frontend shows a `CreditsExhaustedModal`.

### SSE Event Protocol

The agent streams over Server-Sent Events. `agent/src/index.ts` translates Strands SDK events into SSE types that drive UI elements:

| SSE `type` | Emitted when | UI element |
|---|---|---|
| `content_delta` | Text token from Bedrock | Streamed text in chat bubble |
| `tool_call_start` | `beforeToolCallEvent` | "Working…" badge |
| `doc_read_start` / `doc_read` | read_document before/after | "Reading \<filename\>" spinner |
| `doc_find_start` / `doc_find` | find_in_document before/after | "Searching \<filename\>" spinner |
| `doc_created_start` / `doc_created` | generate_docx before/after | Download link card |
| `doc_edited_start` / `doc_edited` | edit_document before/after | Tracked-change download card |
| `doc_replicate_start` / `doc_replicated` | replicate_document before/after | Copies summary card |
| `content_done` | Turn complete | Citation-loading indicator |
| `citations` | Citation extraction done | Inline citation superscripts |
| `error` | Unhandled exception | Error in chat bubble |
| `[DONE]` | Stream closed | Stream reader exits |

---

## Chat Session Flow

### New chat

1. `POST /chat/create` → `chats` row in Aurora; `chatId` returned.
2. Frontend generates `runtimeSessionId = crypto.randomUUID()`.
3. User message posted to AgentCore URL with `{ prompt, chatId, runtimeSessionId, model }` and `Authorization: Bearer <jwt>`.
4. Agent streams SSE back.
5. On `[DONE]`, agent handler updates `chats.agentcore_session_id = runtimeSessionId` in Aurora.
6. On first turn, `POST /:chatId/generate-title` sets chat title.

### Subsequent turns

Same `runtimeSessionId` is sent on every POST, giving the agent access to accumulated context in AgentCore's session layer.

### Page reload

`GET /chat/:chatId/session-id` fetches `chats.agentcore_session_id` → stored in `runtimeSessionIdRef` for turn continuity.

---

## Storage Layout

### Docs bucket

```
documents/<cognito-identity-sub>/<document-id>/<filename>.<ext>
documents/<cognito-identity-sub>/<document-id>/<filename>.pdf   ← Conversion Lambda output
generated/<cognito-identity-sub>/<document-id>/<filename>.docx  ← generate_docx tool output
```

The Cognito Identity Pool authenticated IAM role restricts direct S3 access to `documents/${cognito-identity.amazonaws.com:sub}/*` and `generated/${cognito-identity.amazonaws.com:sub}/*`. The API Lambda execution role has full bucket read/write for presigned URLs and shared-project access.

---

## Data Flow: Document Upload

```
1. Browser → POST /projects/:id/documents (multipart, Bearer JWT)
           → API Gateway → Cognito authorizer → API Lambda
2. API Lambda writes to S3:
   s3.PutObject("documents/<sub>/<doc-id>/<filename>.docx")
   Inserts document + document_versions rows in Aurora.
3. S3 PutObject → EventBridge → Conversion Lambda
   (filter: prefix "documents/", suffix ".docx" or ".doc")
4. Conversion Lambda:
   a. Downloads .docx from S3
   b. Runs LibreOffice headless: DOCX → PDF
   c. Uploads .pdf to S3
   d. Updates document_versions.pdf_storage_path + documents.status = 'ready' in Aurora
5. Frontend fetches presigned GET URL via API Lambda for DOCX or PDF.
```

---

## Security

- All S3 buckets: `blockPublicAccess: BLOCK_ALL`.
- CloudFront uses OAC (SigV4-signed origin requests). Direct S3 URLs for the frontend bucket are blocked.
- Docs bucket: per-user S3 prefix enforced at IAM level via Cognito Identity Pool policy variable `${cognito-identity.amazonaws.com:sub}`.
- API Gateway: native Cognito authorizer on all methods, result cached 300 s.
- AgentCore: JWT inbound authorizer validates Cognito OIDC token before routing to agent.
- Agent SQL ownership: all queries guard with `WHERE user_id = :userId` (or ownership JOIN). `userId` always from server-decoded JWT, never from LLM output.
- Aurora: VPC isolated subnets, accessed via RDS Data API only (no direct TCP).
- CORS: API Gateway `allowOrigins` restricted to CloudFront domain (placeholder `*` during initial deploy, update post-deploy).
- No Lambda function URLs. API Lambda invoked only by API Gateway. Conversion Lambda invoked only by EventBridge S3 rule.
- Bedrock permissions on API Lambda role scoped to exact three model ARNs.

---

## Models

All LLM calls use Bedrock Converse API, eu-west-1 cross-region inference. Model selected per conversation.

| UI label | Bedrock model ID |
|---|---|
| Claude Opus 4.7 | `eu.anthropic.claude-opus-4-7-20251101-v1:0` |
| Claude Sonnet 4.6 (default) | `eu.anthropic.claude-sonnet-4-6-20250922-v1:0` |
| Claude Haiku 4.5 | `eu.anthropic.claude-haiku-4-5-20251001-v1:0` |

---

## Local Development

No local dev server. The backend is Lambda-only. All development targets deployed AWS resources in `eu-west-1`. Frontend env vars point to live CDK stack outputs.
