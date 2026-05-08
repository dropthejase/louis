# AWS Migration Notes

Migration from Railway + Cloudflare Workers/R2 + direct Anthropic/Gemini API keys to AWS is complete on the `feature/aws-migration` branch.

See `docs/ARCHITECTURE.md` for the current architecture.

## What moved to AWS

| Concern | Before | After |
|---|---|---|
| Compute | Railway (Express) | Lambda ARM64 container (Express + serverless-http) |
| Storage | Cloudflare R2 | S3 |
| CDN | Cloudflare Workers | CloudFront + OAC |
| LLM | Direct Anthropic + Gemini API keys | Amazon Bedrock (Claude only) |
| Auth | Supabase Auth | Cognito User Pool (Amplify Auth v6) |
| Database | Supabase Postgres | Aurora Serverless v2 PostgreSQL (RDS Data API) |
| AI chat | Hand-rolled Bedrock loop in Lambda | AgentCore Runtime + Strands agent |
| DOCX→PDF | Not present | Conversion Lambda (x86_64, LibreOffice) |

## Agent identity / auth design

AgentCore Runtime validates the inbound Cognito JWT. `requestHeaderAllowlist: ["Authorization"]` in `agentcore.json` passes the header to agent code. Agent decodes the JWT (no sig check — Runtime already validated it), extracts `sub` as `userId`, and passes it to all tools. Tools use `WHERE user_id = :userId` SQL guards. The LLM never touches `userId`.

## Future: AgentCore Gateway

Current approach has the agent calling Aurora directly via RDS Data API. Future improvement:

```
AgentCore Runtime (Strands agent)
  → AgentCore Gateway (inbound: Cognito JWT, outbound: IAM to Lambda)
    → Agent Tools Lambda (scoped permissions)
      → Aurora
```

Blocked today: Cognito doesn't implement RFC 8693 token exchange (OBO), so identity propagation through Gateway requires a custom token exchange endpoint or migration to an IdP that supports it.
