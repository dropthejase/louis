# Mike — AWS Migration Notes

## What This Project Is

Mike is an AI-powered legal document workspace. Users upload documents (PDF, DOCX), chat with an AI assistant about them, get tracked-change edits, run structured "tabular reviews" across document sets, and share projects with colleagues via email. Licensed AGPL-3.0.

## Original Stack (main branch)

- **Frontend:** Next.js 16 (React 19, Tailwind, 100% client-side components) deployed to Cloudflare Workers via OpenNext
- **Backend:** Express (TypeScript) on Railway (Nixpacks, includes LibreOffice)
- **Database:** Supabase Postgres (400+ queries via `@supabase/supabase-js`)
- **Auth:** Supabase Auth (email/password, JWT issued by Supabase)
- **Storage:** Cloudflare R2 (S3-compatible, accessed via `@aws-sdk/client-s3`)
- **LLM:** Anthropic Claude + Google Gemini via direct API keys
- **Email:** Resend in package.json but unused in code

Key facts about the original code:
- Frontend is 100% `"use client"` — no SSR, no API routes, no middleware. Can be statically exported.
- Backend validates auth by calling `supabase.auth.getUser(token)` on every request (network round-trip, not local JWT verification)
- Sharing is email-based: `shared_with` JSON arrays on projects/workflows/reviews
- The AI chat agent is a hand-rolled tool orchestration system (`chatTools.ts`, ~119KB) with tools: `read_document`, `find_in_document`, `generate_docx`, `edit_document`, `list_documents`, `fetch_documents`, `replicate_document`, `read_table_cells`, `list_workflows`, `read_workflow`
- All file access goes through the Express backend (user never touches R2 directly)
- LibreOffice called **only during document upload** (DOCX→PDF conversion in route handlers), not during chat

## Target Architecture

```
CloudFront → S3 (static Next.js export)

S3 (document storage, per-user IAM prefix enforced via Cognito Identity Pool)

API Gateway REST API (Lambda authorizer validates Supabase JWT via JWKS)
└→ Lambda container (Express wrapped with serverless-http, Lambda Powertools)
└→ Supabase Postgres (unchanged — no query rewrite)

AgentCore Runtime (JWT inbound authorizer → Supabase OIDC discovery URL)
└→ Supabase Postgres

S3 PutObject event → Lambda container (LibreOffice DOCX→PDF conversion)

Cognito Identity Pool (OIDC-federated from Supabase JWT → vends IAM creds for S3)

LLM calls → Amazon Bedrock Converse API (Claude models only, no Gemini)
```

## What Stays, What Changes

### Stays unchanged
- Supabase Auth (JWT source for everything — login, signup, email flows)
- Supabase Postgres (all queries, RLS, schema — zero rewrite)
- Document versioning / tracked changes / DOCX manipulation logic (`docxTrackedChanges.ts`)
- Tool implementations in `chatTools.ts`
- Email-based sharing model (`shared_with` JSON arrays)
- All frontend UI components (swap transport/auth layer only)
- LLM abstraction interface (`streamChatWithTools`, `completeText`) — internal only

### Replaced
- Railway → Lambda (API) + AgentCore (chat streaming)
- Cloudflare R2 → S3 (same `@aws-sdk/client-s3`, different endpoint/credentials)
- Cloudflare Workers → CloudFront + S3 static export
- Direct Anthropic/Google API keys → Bedrock Converse API (Claude only)
- Supabase auth middleware (network round-trip per request) → Lambda authorizer (JWKS local validation, cached)

## Auth Flow

Supabase JWT is the single auth token across all consumers:

| Consumer | Validation method |
|----------|------------------|
| API Gateway REST API | Lambda authorizer — validates against Supabase JWKS URL, extracts `sub`/`email` into request context |
| AgentCore Runtime | JWT inbound authorizer — Supabase OIDC discovery URL (`https://<project>.supabase.co/auth/v1`) |
| S3 direct access (frontend uploads) | Cognito Identity Pool — OIDC-federated from Supabase JWT → temporary IAM creds |

Frontend calls `supabase.auth.getSession()` once. That JWT is used as Bearer token for API Gateway (Token authorizer) and AgentCore (JWT inbound authorizer). It is also exchanged for temporary IAM creds via Cognito Identity Pool for direct S3 access (Amplify Storage uploads).

## Design Decisions

| Decision | Why |
|----------|-----|
| **Supabase Auth stays** | No reason to replace — it works, handles email flows, JWKS endpoint available for validation |
| **Supabase Postgres stays** | Replacing with Aurora = massive query rewrite with zero user-facing benefit |
| **Lambda authorizer** (not Cognito User Pool Authorizer) | REST API authorizers validate Cognito-issued tokens; Supabase issues its own JWTs — Lambda authorizer validates against Supabase JWKS directly |
| **Cognito Identity Pool only** (no User Pool) | Identity Pool federates from any OIDC provider (Supabase); vends IAM creds for S3 — no User Pool needed |
| **REST API** (not HTTP API) | WAF support, usage plans, resource policies for future use |
| **AgentCore for chat** | Managed streaming runtime, session management, ARM64 container — replaces SSE over Express |
| **AgentCore CLI** (`@aws/agentcore`) for agent deploy | AgentCore has its own CDK-based deploy toolchain; using CLI + npm scripts avoids double-CDK conflict, allows fast iteration |
| **Bedrock only** (drop Gemini) | No external API keys; IAM-controlled; single bill; Gemini not on Bedrock |
| **Static frontend export** | App is 100% client-side; no SSR needed |
| **Per-user S3 prefix** | IAM-enforced via Identity Pool role + `${cognito-identity.amazonaws.com:sub}` policy variable |
| **Conversion Lambda container** | LibreOffice ~300MB exceeds Lambda zip limit; container has no size limit; triggered by S3 PutObject |
| **serverless-http wrap** | Minimal code change — existing Express routes work unchanged |
| **Lambda Powertools** | Structured logging, tracing, middleware — best practice for Lambda TypeScript |
| **CDK auto-naming** | No explicit resource names — CDK generates unique names per stack/stage |

## Repo Structure (target)

```
mike-on-aws/
  backend/          # Express app (unchanged routes, new lambda.ts entrypoint)
  frontend/         # Next.js app (unchanged UI, new AWS auth/storage/api wiring)
  infra/            # CDK app (TypeScript) — all AWS infrastructure except AgentCore
  agent/            # AgentCore agent code + agentcore.json + Dockerfile
  conversion/       # LibreOffice Lambda container code + Dockerfile
  scripts/          # npm scripts for build, deploy, invoke
```

## CDK Stacks (`infra/`)

Four stacks, single CDK app, deployed independently per layer:

1. **StorageStack** — S3 documents bucket (per-user prefix policy), S3 frontend bucket, CloudFront with OAC
2. **AuthStack** — Cognito Identity Pool (OIDC provider: Supabase), Lambda authorizer function
3. **ApiStack** — REST API Gateway (Lambda authorizer), API Lambda container (serverless-http + Powertools)
4. **ConversionStack** — S3 PutObject trigger, Lambda container (LibreOffice)

AgentCore deployed separately via `agentcore deploy` CLI / npm script.

No explicit resource names anywhere. All cross-stack values via CDK exports.

## Backend Changes

| File | Change |
|------|--------|
| `src/app.ts` | Extract Express app (shared between local dev and Lambda handler) |
| `src/index.ts` | Import from `app.ts`, just `app.listen()` for local dev |
| `src/lambda.ts` | `serverless-http(app)` export for API Gateway + Powertools middleware |
| `src/middleware/auth.ts` | In Lambda: read user from API Gateway request context (set by Lambda authorizer). Local dev: Supabase fallback |
| `src/lib/storage.ts` | S3 via IAM role (prod), R2 env vars fallback (local dev) |
| `src/lib/llm/bedrock.ts` | New — Bedrock Converse API client (streaming + non-streaming) |
| `src/lib/llm/index.ts` | Route all calls through Bedrock; remove Gemini path |
| `src/lib/llm/models.ts` | Map existing model tiers to Bedrock model IDs |

## Agent Changes (`agent/`)

| File | Purpose |
|------|---------|
| `entrypoint.ts` | AgentCore HTTP protocol handler — `/invocations` POST, SSE stream, `/ping` GET |
| `Dockerfile` | Node 20 ARM64, no LibreOffice |
| `agentcore/agentcore.json` | AgentCore config (HTTP protocol, PUBLIC network, Bedrock model provider) |

Agent entrypoint wraps existing `chatTools.ts` logic — no rewrite of tool implementations.

## Frontend Changes

| File | Change |
|------|--------|
| `src/lib/aws/config.ts` | Cognito Identity Pool ID, S3 bucket, API Gateway URL, AgentCore endpoint — from env vars |
| `src/lib/aws/auth.ts` | Exchange Supabase JWT for Identity Pool IAM creds via `@aws-sdk/credential-providers` |
| `src/lib/aws/api.ts` | SigV4-signed fetch helper (used for S3 presign operations if needed) |
| `src/lib/aws/storage.ts` | Direct S3 upload/download/presign using IAM creds |
| `src/app/lib/mikeApi.ts` | `apiRequest` sends Bearer JWT to API Gateway; uploads send Bearer JWT to Lambda; chat streams via Bearer JWT to AgentCore; S3 uploads via Amplify Storage (IAM creds from Identity Pool) |
| `next.config.ts` | `output: 'export'`, `images: { unoptimized: true }` |
| `.env.local.example` | AWS env vars (Identity Pool ID, S3 bucket, API URL, AgentCore URL) |

Auth context and login/signup pages **unchanged** — Supabase Auth stays.

## Security

- S3 buckets: `blockPublicAccess: BLOCK_ALL`
- Frontend bucket: only accessible via CloudFront OAC
- Documents bucket: per-user prefix enforced via Identity Pool IAM role condition on `cognito-identity.amazonaws.com:sub`
- API Gateway: Lambda authorizer on all methods; authorizer result cached (reduces Supabase JWKS calls)
- AgentCore: JWT inbound authorizer (Supabase OIDC discovery URL)
- CORS: API Gateway restricted to CloudFront domain
- Lambda: no function URLs — only invoked by API Gateway or S3 events
- Conversion Lambda: only triggered by S3, no API exposure
- Secrets Manager: DB credentials and any API keys — IAM-scoped to Lambda execution roles only
- No public resources except CloudFront

## Migration Order

1. `infra/` CDK app scaffold + StorageStack (S3 + CloudFront)
2. AuthStack (Identity Pool + Lambda authorizer)
3. ApiStack (API Gateway + Lambda container skeleton — health check only)
4. Backend: extract `app.ts`, add `lambda.ts` with serverless-http + Powertools
5. Backend: `auth.ts` middleware — prod path reads from API Gateway context
6. Backend: `storage.ts` — S3 via IAM role, R2 fallback
7. Backend: `llm/bedrock.ts` + update `llm/index.ts` and `models.ts`
8. Deploy API Lambda — smoke test routes
9. ConversionStack (LibreOffice Lambda container)
10. `agent/` — AgentCore entrypoint wrapping chatTools, Dockerfile, agentcore.json
11. Deploy AgentCore via CLI — test streaming
12. Frontend: `lib/aws/` wiring (auth, api, storage)
13. Update `mikeApi.ts` — SigV4 for API calls, S3 SDK for uploads, AgentCore for chat
14. `next.config.ts` static export
15. Deploy frontend to S3/CloudFront
16. End-to-end test

## Sharing Model (unchanged)

- Projects, workflows, tabular reviews have `shared_with: string[]` (email list in JSONB)
- Backend checks `shared_with` contains requesting user's email on each access
- S3 file isolation maintained: Lambda checks `shared_with`, returns presigned URL for shared files — user never accesses another user's prefix directly

## Future (post-migration)

- Sharing: invite-accept flow (invitations table, consent before access granted)
- Sharing: org-scoped with `org_id` on all tables
- Multi-tenancy: RLS-enforced org isolation at DB level
- Refactor `chatTools.ts` to Strands Agents (tool decorators, built-in orchestration)
- Bedrock Guardrails for content filtering
- WAF on CloudFront for rate limiting
