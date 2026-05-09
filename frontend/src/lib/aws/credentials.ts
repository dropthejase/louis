import {
  CognitoIdentityClient,
  GetIdCommand,
  GetCredentialsForIdentityCommand,
} from "@aws-sdk/client-cognito-identity";
import type { AwsCredentialIdentity } from "@smithy/types";
import { AWS_REGION, IDENTITY_POOL_ID, COGNITO_LOGINS_KEY } from "./config";

// Cached credentials — shared across callers in the same browser session.
let cached: { credentials: AwsCredentialIdentity; jwt: string } | null = null;

/**
 * Exchange a Cognito id token for temporary IAM credentials via the
 * Identity Pool. Cached until 5 min before expiry.
 */
export async function getIdentityPoolCredentials(
  cognitoIdToken: string,
  forceRefresh = false,
): Promise<AwsCredentialIdentity> {
  const now = new Date();

  if (
    !forceRefresh &&
    cached &&
    cached.jwt === cognitoIdToken &&
    cached.credentials.expiration &&
    cached.credentials.expiration.getTime() - now.getTime() > 5 * 60 * 1000
  ) {
    return cached.credentials;
  }

  const client = new CognitoIdentityClient({ region: AWS_REGION });

  const { IdentityId } = await client.send(
    new GetIdCommand({
      IdentityPoolId: IDENTITY_POOL_ID,
      Logins: { [COGNITO_LOGINS_KEY]: cognitoIdToken },
    }),
  );

  if (!IdentityId) throw new Error("Cognito GetId returned no IdentityId");

  const { Credentials } = await client.send(
    new GetCredentialsForIdentityCommand({
      IdentityId,
      Logins: { [COGNITO_LOGINS_KEY]: cognitoIdToken },
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

  cached = { credentials, jwt: cognitoIdToken };
  return credentials;
}

/** Clear the credential cache (call on sign-out). */
export function clearCredentialCache(): void {
  cached = null;
}
