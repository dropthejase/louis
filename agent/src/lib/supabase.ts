import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseCredentials } from './secrets';

let client: SupabaseClient | null = null;

export async function getSupabaseClient(): Promise<SupabaseClient> {
  if (client) return client;
  const { url, serviceRoleKey } = await getSupabaseCredentials();
  client = createClient(url, serviceRoleKey);
  return client;
}
