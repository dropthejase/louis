import type { PreTokenGenerationV2TriggerEvent } from 'aws-lambda';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { createClient } from '@supabase/supabase-js';

// Cognito does not have a native PostDelete trigger.
// This Lambda is invoked via EventBridge rule on CloudTrail event
// cognito-idp:DeleteUser / AdminDeleteUser.
// Event shape: { detail: { requestParameters: { username: string } } }

const sm = new SecretsManagerClient({});

async function getSupabaseClient() {
  const { SecretString } = await sm.send(
    new GetSecretValueCommand({ SecretId: process.env.SUPABASE_SECRET_ARN! }),
  );
  const { url, serviceRoleKey } = JSON.parse(SecretString!);
  return createClient(url, serviceRoleKey, { auth: { persistSession: false } });
}

export const handler = async (event: any): Promise<void> => {
  const userId: string | undefined =
    event?.detail?.requestParameters?.username ??
    event?.detail?.requestParameters?.Username;

  if (!userId) {
    console.error('[post-deletion] no userId in event', JSON.stringify(event));
    return;
  }

  const db = await getSupabaseClient();
  const { error } = await db.from('user_profiles').delete().eq('user_id', userId);
  if (error) console.error('[post-deletion] delete error', error);
};
