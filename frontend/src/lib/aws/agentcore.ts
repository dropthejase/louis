// AgentCore streaming — minimal module.
// The main streamChat / streamProjectChat functions live in mikeApi.ts and use
// Bearer JWT directly to AGENTCORE_URL (AgentCore's JWT inbound authorizer
// validates the Supabase token). This file re-exports config for convenience.

export { AGENTCORE_URL } from "./config";
