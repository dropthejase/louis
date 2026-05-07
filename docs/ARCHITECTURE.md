# Louis — Architecture

## Overview

Louis is an AI-powered legal document workspace (AGPL-3.0) that lets users upload documents, chat with an AI assistant, get tracked-change edits, run tabular reviews across document sets, and share projects with colleagues. This repo is a migration of the original stack (Railway + Cloudflare Workers/R2 + direct Anthropic/Gemini API keys) onto AWS: the frontend is a static Next.js export served via CloudFront + S3, the Express backend runs as an ARM64 Lambda container behind API Gateway, AI chat is handled by an Amazon Bedrock AgentCore runtime running a Strands agent, DOCX-to-PDF conversion is an x86_64 Lambda container triggered by S3 events, and all LLM calls route through Amazon Bedrock. Authentication is handled entirely by Amazon Cognito User Pool (replacing Supabase Auth). Supabase Postgres remains for application data.

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Browser                                                                    │
└──────┬──────────────────────┬──────────────────────┬───────────────────────┘
       │ HTTPS (static assets) │ HTTPS + Bearer JWT   │ HTTPS + Bearer JWT
       ▼                       ▼                       ▼
┌─────────────┐   ┌───────────────────────┐   ┌─────────────────────────┐
│ CloudFront  │   │   API Gateway (REST)   │   │  AgentCore Runtime      │
│ (OAC)       │   │   Cognito authorizer    │   │  JWT inbound authorizer │
└──────┬──────┘   └──────────┬────────────┘   └──────────┬──────────────┘
       │                     │ validated JWT               │ validated JWT
       ▼                     ▼                             ▼
┌─────────────┐   ┌───────────────────────┐   ┌─────────────────────────┐
│  S3         │   │  Lambda (ARM64)        │   │  Strands Agent (ARM64)  │
│ (frontend   │   │  Express +             │   │  10 tools               │
│  bucket)    │   │  serverless-http +     │   │  Bedrock Converse API   │
└─────────────┘   │  Lambda Powertools     │   └──────────┬──────────────┘
                  └──────────┬────────────┘              │
                             │                            │
              ┌──────────────┼───────────────┐           │
              ▼              ▼               ▼            ▼
       ┌──────────┐  ┌────────────┐  ┌───────────┐  ┌──────────────┐
       │ Supabase │  │  S3 (docs  │  │  Bedrock  │  │  Supabase    │
       │ Postgres │  │  bucket)   │  │  Claude   │  │  Postgres    │
       └──────────┘  └─────┬──────┘  └───────────┘  └──────────────┘
                           │ S3 PutObject event
                           ▼
                  ┌────────────────────┐
                  │ Conversion Lambda  │
                  │ (x86_64)           │
                  │ LibreOffice        │
                  │ DOCX → PDF → S3   │
                  └────────────────────┘

  Browser direct S3 upload path:
  Browser → Cognito Identity Pool (exchange Cognito id token → IAM creds)
          → S3 docs bucket (per-user prefix, IAM-enforced)
          → S3 PutObject event → Conversion Lambda
```

---

## Auth Flow

Cognito id token is the single auth token. The frontend uses AWS Amplify Auth v6 (`fetchAuthSession()`) to obtain the token and passes it as `Authorization: Bearer <id_token>` to all downstream consumers.

| Consumer | Validation method | What happens |
|---|---|---|
| API Gateway REST API | Native Cognito User Pool authorizer — validates signature against Cognito JWKS; no Lambda cold start | API Gateway injects all JWT claims into `requestContext.authorizer.claims`; Express reads `claims.sub` and `claims.email` from there |
| AgentCore Runtime | JWT inbound authorizer — Cognito User Pool OIDC discovery URL | AgentCore validates the Bearer JWT before the `/invocations` handler is called; agent handler re-extracts `sub` from the token for per-user data scoping |
| S3 direct upload (frontend) | Cognito Identity Pool — natively federated from Cognito User Pool via `cognitoIdentityProviders` | Identity Pool exchanges the id token for temporary STS credentials scoped to the authenticated IAM role; frontend uses those credentials for `PutObject`/`GetObject` calls directly to S3 |

A Pre-Token Generation Lambda (V2_0) runs on every token issue and injects `role: "authenticated"` into the id token. Supabase Third-Party Auth trusts this claim to treat Cognito users as authenticated Supabase Postgres users.

---

## CDK Stacks

All stacks live in `infra/`, deployed with `npx cdk deploy <StackName> -c stage=<stage>`. Resource names are CDK-generated (no explicit names). Cross-stack values flow via CDK `CfnOutput` exports or are passed as constructor props.

| Stack | What it provisions | Key outputs |
|---|---|---|
| `StorageStack` | S3 docs bucket (private, S3-managed encryption, CORS for direct upload); S3 frontend bucket (private); CloudFront distribution with OAC pointing at frontend bucket; SPA 404→200 fallback | `DocsBucketName`, `FrontendBucketName`, `DistributionDomainName`, `DistributionId` |
| `AuthStack` | Cognito User Pool (`louis-<stage>`, TOTP-only MFA, strong password policy, required givenName/familyName/email, email verification); App Client (SRP auth, no client secret); Pre-Token Gen V2_0 Lambda (injects `role: "authenticated"`); Cognito Identity Pool (native User Pool federation, no unauthenticated access); IAM authenticated role with per-user S3 prefix policy | `UserPoolId`, `UserPoolClientId`, `IdentityPoolId`, `AuthenticatedRoleArn` |
| `ApiStack` | Secrets Manager secret for Supabase URL + service role key; API Lambda (ARM64 Docker container, 1024 MB, 29 s timeout, X-Ray active tracing, Bedrock invoke permissions for 3 model ARNs, S3 read/write, Secrets Manager read); REST API Gateway with native Cognito User Pool authorizer on all routes (`{proxy+}` + root), CORS headers, per-stage logging | `ApiUrl`, `ApiLambdaArn`, `SupabaseSecretArn` |
| `ConversionStack` | Conversion Lambda (x86_64 Docker container, 2048 MB, 5 min timeout); S3 event notification on `documents/*.docx` and `documents/*.doc` PutObject → Lambda; S3 read/write + Secrets Manager read for the Lambda role | `ConversionLambdaArn` |

AgentCore is deployed separately via the `@aws/agentcore` CLI (`scripts/deploy-agent.sh`) using `agentcore/agentcore.json` — not through CDK.

---

## Agent Architecture

The agent is a Node 20 ARM64 Docker container running an Express HTTP server that implements the AgentCore invocation protocol.

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
| `replicate_document` | Copy a document within a project |
| `read_table_cells` | Read tabular review cell data from Supabase |
| `list_workflows` | List available workflows from Supabase |
| `read_workflow` | Fetch a specific workflow definition |

`replicate_document` is only registered when a `projectId` is provided.

### SSE Event Protocol

The agent streams over Server-Sent Events. The invocation handler in `agent/src/index.ts` translates Strands SDK events into the following SSE event types, which drive specific UI elements in the frontend:

| SSE `type` | Emitted when | UI element driven |
|---|---|---|
| `content_delta` | Text token arrives from Bedrock | Streamed text in chat bubble (drip-rendered at 8 chars/tick) |
| `tool_call_start` | `beforeToolCallEvent` fires | Transient "Working…" placeholder badge |
| `doc_read_start` | `read_document` about to execute | "Reading \<filename\>" spinner badge |
| `doc_read` | `read_document` completed | Badge resolved (spinner removed) |
| `doc_find_start` | `find_in_document` about to execute | "Searching \<filename\>" spinner badge |
| `doc_find` | `find_in_document` completed | Badge resolved with match count |
| `doc_created_start` | `generate_docx` about to execute | "Creating \<title\>" spinner badge |
| `doc_created` | `generate_docx` completed | Download link card in chat |
| `doc_edited_start` | `edit_document` about to execute | "Editing \<filename\>" spinner badge |
| `doc_edited` | `edit_document` completed | Tracked-change download card with annotation list |
| `doc_replicate_start` | `replicate_document` about to execute | "Replicating \<filename\>" spinner badge |
| `doc_replicated` | `replicate_document` completed | Copies summary card |
| `content_done` | Agent turn complete | Triggers citation-loading indicator |
| `citations` | Citation extraction done | Inline citation superscripts in chat text |
| `error` | Unhandled exception | Error message in chat bubble |
| `[DONE]` | Stream fully closed | Stream reader exits |

---

## Chat Session Flow

### New chat

1. User types first message. `useAssistantChat.handleNewChat` calls `saveChat` (API Gateway `POST /chat/create`) to create a `chats` row in Supabase, receiving a `chatId`.
2. Frontend generates `runtimeSessionId = crypto.randomUUID()` and stores it in `runtimeSessionIdRef`.
3. `handleChat` persists the user message to `chat_messages` via Supabase client, then calls `streamChat` (POST to AgentCore URL) with `{ prompt, chatId, runtimeSessionId, model, ... }` and `Authorization: Bearer <jwt>`.
4. Agent streams SSE events back. Frontend consumes them, updating React state incrementally.
5. On `[DONE]`, `useAssistantChat` writes the completed assistant message to `chat_messages` via Supabase client.
6. Agent handler, after streaming completes, calls `db.from('chats').update({ agentcore_session_id: runtimeSessionId }).eq('id', chatId)` — storing the session ID so future turns can resume the same AgentCore session.
7. On the first turn, `generateTitle` is called to set a chat title.

### Subsequent turns

1. `runtimeSessionIdRef.current` already holds the session ID loaded from `chats.agentcore_session_id` (see page-load step below).
2. `handleChat` sends the same `runtimeSessionId` to AgentCore on every subsequent `POST /invocations`, giving the agent access to the accumulated conversation context managed by AgentCore's session layer.

### Page reload (loading an existing chat)

1. `useAssistantChat` `useEffect` fires on `initialChatId`.
2. `GET /chat/:chatId/session-id` backend API call fetches `chats.agentcore_session_id` → stored in `runtimeSessionIdRef.current` for turn continuity.
3. If no `initialMessages` were provided (navigating directly to `/assistant/chat/:id`), `GET /chat/:chatId/messages` fetches the AgentCore session snapshot from S3 and hydrates local React state.

---

## Storage Layout

### Docs bucket (`DOCS_BUCKET_NAME`)

```
documents/<cognito-identity-sub>/<document-id>/<filename>.<ext>
documents/<cognito-identity-sub>/<document-id>/<filename>.pdf   ← PDF created by Conversion Lambda
generated/<cognito-identity-sub>/<document-id>/<filename>.docx  ← DOCX created by generate_docx tool
```

The IAM policy on the Cognito Identity Pool authenticated role restricts users to `documents/${cognito-identity.amazonaws.com:sub}/*` and `generated/${cognito-identity.amazonaws.com:sub}/*` only. The API Lambda uses its execution role (full bucket read/write) to serve presigned URLs and access documents on behalf of shared users.

### Frontend bucket

```
/                    ← Next.js static export (index.html, _next/static/*, ...)
```

---

## Data Flow: Document Upload

```
1. Browser → POST /projects/:id/documents (multipart, Bearer JWT)
            → API Gateway → Cognito authorizer → API Lambda
2. API Lambda receives file bytes, writes to S3:
   s3.PutObject("documents/<sub>/<doc-id>/<filename>.docx")
   Inserts document row in Supabase Postgres.
3. S3 PutObject event notification → Conversion Lambda triggered
   (filter: prefix "documents/", suffix ".docx" or ".doc")
4. Conversion Lambda:
   a. Downloads .docx from S3 to /tmp
   b. Runs LibreOffice headless: soffice --headless --convert-to pdf
   c. Uploads .pdf to same S3 prefix
   d. Updates document row in Supabase Postgres with pdf_key
5. Frontend subsequently fetches presigned GET URL via API Lambda
   for either the original DOCX or the generated PDF.
```

Conversion Lambda timeout is 5 minutes (LibreOffice can be slow on large documents). Memory: 2048 MB. Architecture: x86_64 (LibreOffice dependency). The Lambda is not API-exposed — only reachable via S3 event notification.

---

## Security

- All S3 buckets use `blockPublicAccess: BLOCK_ALL`. No bucket policies grant public read.
- Frontend bucket is accessible only via CloudFront using OAC (SigV4-signed origin requests). Direct S3 URLs for the frontend bucket are blocked.
- Docs bucket: per-user S3 prefix enforced at the IAM level via the Cognito Identity Pool authenticated role using the `${cognito-identity.amazonaws.com:sub}` policy variable. Users cannot access each other's prefixes directly.
- API Gateway: native Cognito User Pool authorizer is required on all methods. No Lambda cold start; authorizer result cached for 300 seconds.
- AgentCore: JWT inbound authorizer validates the Supabase OIDC token before routing to the agent container.
- CORS: API Gateway `allowOrigins` is configured for restriction to the CloudFront domain post-deploy (placeholder `*` during initial deploy).
- No Lambda function URLs exist. API Lambda is invoked only by API Gateway. Conversion Lambda is invoked only by S3 event notification.
- Supabase credentials (`url` + `serviceRoleKey`) are stored in Secrets Manager, not in environment variables. The API Lambda and Conversion Lambda read them at cold start via `secretsmanager:GetSecretValue`, granted by their execution roles. No other resource has access.
- Bedrock permissions on the API Lambda role are scoped to the exact three foundation model ARNs in use.

---

## Models

All LLM calls use the Amazon Bedrock Converse API with eu-west-1 cross-region inference profiles. Model is selected per conversation; switching mid-conversation is supported.

| UI label | Logical ID | Bedrock cross-region inference profile ID |
|---|---|---|
| Claude Opus 4.7 | `claude-opus-4-7` | `eu.anthropic.claude-opus-4-7-20251101-v1:0` |
| Claude Sonnet 4.6 (default) | `claude-sonnet-4-6` | `eu.anthropic.claude-sonnet-4-6-20250922-v1:0` |
| Claude Haiku 4.5 | `claude-haiku-4-5` | `eu.anthropic.claude-haiku-4-5-20251001-v1:0` |

The agent resolves the logical ID to the Bedrock model ID in `agent/src/agent.ts`. Unrecognised model IDs fall back to Sonnet 4.6. Google Gemini is dropped entirely — no external LLM API keys exist in the AWS deployment.

---

## What Stays on Supabase

| Concern | Owner | Notes |
|---|---|---|
| Postgres database | Supabase | All application tables (`chats`, `chat_messages`, `documents`, `projects`, `workflows`, `tabular_reviews`, etc.), RLS policies, and schema — zero query rewrite |
| Row-level security | Supabase | RLS remains the last-mile data isolation layer for Postgres queries made by the API Lambda (using the service role key) |
| Third-Party Auth trust | Supabase | Supabase is configured to trust Cognito User Pool as a Third-Party Auth OIDC provider. The Pre-Token Gen Lambda injects `role: "authenticated"` into id tokens so Supabase accepts them as authenticated sessions |

What moved to AWS: compute (Lambda, AgentCore), storage (S3 replaces Cloudflare R2), CDN (CloudFront replaces Cloudflare Workers), LLM (Bedrock replaces direct Anthropic/Gemini keys), **auth (Cognito User Pool replaces Supabase Auth entirely — login, signup, TOTP MFA, JWT issuance, JWKS endpoint, OIDC discovery)**.

## Supabase Third-Party Auth Setup (manual)

After deploying AuthStack, configure Supabase to trust Cognito JWTs:

1. Supabase Dashboard → Authentication → Sign In / Sign Up → Third-Party Auth → Add provider → OpenID Connect
2. **Issuer URL:** `https://cognito-idp.<region>.amazonaws.com/<UserPoolId>`
3. **Client ID:** leave blank (id tokens only, not access tokens)
4. Enable the provider and save

Supabase will auto-discover the JWKS from Cognito's OIDC discovery endpoint. No further config needed — the `role: "authenticated"` claim injected by the Pre-Token Gen Lambda satisfies Supabase's RLS auth.role() checks.

---

## Local Development

Local development against a local server has been removed. The backend is Lambda-only — there is no `npm run dev` server path for the AWS deployment. All development and testing is done against deployed AWS resources (StorageStack, AuthStack, ApiStack, AgentCore) in `eu-west-1`. Frontend env vars point to live CDK stack outputs. There is no local emulation of API Gateway, AgentCore, or Bedrock.
