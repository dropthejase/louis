import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

let cached: { url: string; serviceRoleKey: string } | null = null;

export async function getSupabaseCredentials(): Promise<{ url: string; serviceRoleKey: string }> {
  if (cached) return cached;

  const arn = process.env.SUPABASE_SECRET_ARN;
  if (!arn) {
    // Local dev fallback
    return {
      url: process.env.SUPABASE_URL!,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
    };
  }

  const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'eu-west-1' });
  const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  cached = JSON.parse(SecretString!) as { url: string; serviceRoleKey: string };
  return cached;
}
