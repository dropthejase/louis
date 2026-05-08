import type { PostConfirmationTriggerEvent } from 'aws-lambda';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { createClient } from '@supabase/supabase-js';

const sm = new SecretsManagerClient({});

async function getSupabaseClient() {
  const { SecretString } = await sm.send(
    new GetSecretValueCommand({ SecretId: process.env.SUPABASE_SECRET_ARN! }),
  );
  const { url, serviceRoleKey } = JSON.parse(SecretString!);
  return createClient(url, serviceRoleKey, { auth: { persistSession: false } });
}

export const handler = async (
  event: PostConfirmationTriggerEvent,
): Promise<PostConfirmationTriggerEvent> => {
  // Only run on email confirmation, not on admin-created users
  if (event.triggerSource !== 'PostConfirmation_ConfirmSignUp') return event;

  const userId = event.userName; // Cognito sub
  const db = await getSupabaseClient();

  await db.from('user_profiles').upsert(
    { user_id: userId, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' },
  );

  return event;
};
