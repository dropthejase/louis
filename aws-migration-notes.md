# Mike — AWS Migration Notes

## Current Architecture (feature/aws-migration)

```
CloudFront → S3 (static Next.js export)

API Gateway REST API (Cognito User Pool authorizer)
└→ Lambda container (Express + serverless-http + Lambda Powertools)
└→ Aurora Serverless v2 PostgreSQL 16.3 (RDS Data API, VPC isolated subnets)

AgentCore Runtime (JWT inbound authorizer — Cognito OIDC)
└→ Strands agent (10 tools, Bedrock Claude)
└→ DynamoDB (per-user monthly credits — planned, not yet implemented)

S3 PutObject (.docx/.doc) → EventBridge → Lambda container (LibreOffice DOCX→PDF)

Cognito Identity Pool (native User Pool federation)
└→ temporary IAM creds for frontend S3 uploads

LLM → Amazon Bedrock Converse API (Claude only, eu-west-1 cross-region inference)
```

## Agent Identity / Auth Design

AgentCore Runtime validates the inbound Cognito JWT. The `Authorization` header is passed
through to agent code via `requestHeaderAllowlist: ["Authorization"]` in `agentcore.json`.
Agent code decodes the JWT (no sig validation — Runtime already validated it), extracts `sub`
as `userId`, and passes it to all tools. Tools use it in `WHERE user_id = :userId` SQL clauses.

The JWT is never passed as a parameter by the LLM — it is always read from the verified
request header at the HTTP layer before any agent/tool code runs.

## Future: AgentCore Gateway

Current approach has the agent calling Aurora directly via RDS Data API (same `db.ts` wrapper
as the backend Lambda). This is pragmatic but couples the agent to the DB layer.

Future improvement: introduce AgentCore Gateway as an intermediary.

```
AgentCore Runtime (Strands agent)
  → AgentCore Gateway (inbound: Cognito JWT, outbound: IAM to Lambda)
    → Agent Tools Lambda (separate from API Lambda, scoped permissions)
      → Aurora
```

This would give clean separation — agent has zero DB code, all CRUD goes through a
purpose-built Lambda target. Identity propagation via AgentCore Identity OBO token exchange
(blocked today: Cognito doesn't implement RFC 8693 token exchange natively; would need a
custom token exchange endpoint or migration to an IdP that supports it).

## Pending Work

### Agent Supabase → Aurora migration
- `agent/src/lib/db.ts` — new RDS Data API wrapper (copy from backend)
- `agent/src/lib/doc-context.ts` — migrate buildDocContext / buildProjectDocContext
- `agent/src/tools/` — migrate 6 tools with DB calls
- `agent/src/index.ts` — migrate agentcore_session_id update
- `agent/agentcore/agentcore.json` — add JWT authorizer + requestHeaderAllowlist
- Remove `@supabase/supabase-js` from agent/
- Delete `agent/src/lib/supabase.ts`

### Conversion Lambda Supabase → Aurora migration
- `conversion/src/index.ts` — migrate document_versions + documents DB updates
- Remove `@supabase/supabase-js` from conversion/

### Per-User Credits Tracking (planned, not implemented)
- DynamoDB table in CDK (ApiStack): PK=`userId`, SK=`YYYY-MM`, `credits_used`
- Strands `after_model_call` hook in agent increments `credits_used`
- Backend returns 429 before chat when limit exceeded
- Frontend `CreditsExhaustedModal` wired to 429
- AgentCore execution role: `dynamodb:GetItem` + `dynamodb:UpdateItem`
