// backend/src/lib/secrets.ts
//
// Fetches Supabase credentials from AWS Secrets Manager on cold start.
// The secret is expected to be a JSON string:
//   { "url": "https://xxx.supabase.co", "serviceRoleKey": "eyJ..." }
//
// Required env vars:
//   SUPABASE_SECRET_ARN — full ARN of the Secrets Manager secret
//
// Fallback (local dev): reads SUPABASE_URL + SUPABASE_SECRET_KEY from env directly.

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

type SupabaseSecrets = {
  url: string;
  serviceRoleKey: string;
};

let cached: SupabaseSecrets | null = null;

const smClient = new SecretsManagerClient({});

export async function loadSupabaseSecrets(): Promise<void> {
  // Already loaded — skip.
  if (cached) return;

  const arn = process.env.SUPABASE_SECRET_ARN;

  if (!arn) {
    // Local dev: fall through to env vars already set by dotenv.
    cached = {
      url: process.env.SUPABASE_URL ?? "",
      serviceRoleKey: process.env.SUPABASE_SECRET_KEY ?? "",
    };
    return;
  }

  const response = await smClient.send(
    new GetSecretValueCommand({ SecretId: arn }),
  );

  if (!response.SecretString) {
    throw new Error(`Secrets Manager secret ${arn} has no SecretString`);
  }

  const parsed = JSON.parse(response.SecretString) as SupabaseSecrets;

  // Inject into process.env so existing createClient() calls in supabase.ts
  // pick them up without any changes to that file.
  process.env.SUPABASE_URL = parsed.url;
  process.env.SUPABASE_SECRET_KEY = parsed.serviceRoleKey;

  cached = parsed;
}

/** Returns cached secrets — only valid after loadSupabaseSecrets() has been awaited. */
export function getSupabaseSecrets(): SupabaseSecrets {
  if (!cached) throw new Error("loadSupabaseSecrets() has not been called yet");
  return cached;
}
