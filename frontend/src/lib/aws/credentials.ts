import {
  CognitoIdentityClient,
  GetIdCommand,
  GetCredentialsForIdentityCommand,
} from "@aws-sdk/client-cognito-identity";
import type { AwsCredentialIdentity } from "@smithy/types";
import { AWS_REGION, IDENTITY_POOL_ID, SUPABASE_LOGINS_KEY } from "./config";

// Cached credentials — shared across callers in the same browser session.
let cached: { credentials: AwsCredentialIdentity; jwt: string } | null = null;

/**
 * Exchange a Supabase JWT for temporary IAM credentials via Cognito Identity Pool.
 * Results are cached until 5 minutes before the credentials expire.
 * Pass `forceRefresh: true` to bypass the cache (e.g. after a new login).
 */
export async function getIdentityPoolCredentials(
  supabaseJwt: string,
  forceRefresh = false,
): Promise<AwsCredentialIdentity> {
  const now = new Date();

  if (
    !forceRefresh &&
    cached &&
    cached.jwt === supabaseJwt &&
    cached.credentials.expiration &&
    cached.credentials.expiration.getTime() - now.getTime() > 5 * 60 * 1000
  ) {
    return cached.credentials;
  }

  const client = new CognitoIdentityClient({ region: AWS_REGION });

  const { IdentityId } = await client.send(
    new GetIdCommand({
      IdentityPoolId: IDENTITY_POOL_ID,
      Logins: { [SUPABASE_LOGINS_KEY]: supabaseJwt },
    }),
  );

  if (!IdentityId) throw new Error("Cognito GetId returned no IdentityId");

  const { Credentials } = await client.send(
    new GetCredentialsForIdentityCommand({
      IdentityId,
      Logins: { [SUPABASE_LOGINS_KEY]: supabaseJwt },
    }),
  );

  if (
    !Credentials?.AccessKeyId ||
    !Credentials.SecretKey ||
    !Credentials.SessionToken
  ) {
    throw new Error("Cognito returned incomplete credentials");
  }

  const credentials: AwsCredentialIdentity = {
    accessKeyId: Credentials.AccessKeyId,
    secretAccessKey: Credentials.SecretKey,
    sessionToken: Credentials.SessionToken,
    expiration: Credentials.Expiration,
  };

  cached = { credentials, jwt: supabaseJwt };
  return credentials;
}

/** Clear the credential cache (call on sign-out). */
export function clearCredentialCache(): void {
  cached = null;
}
