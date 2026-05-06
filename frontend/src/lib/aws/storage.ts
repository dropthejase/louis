import { Amplify } from "aws-amplify";
import { uploadData, getUrl, remove } from "aws-amplify/storage";
import type { AwsCredentialIdentity } from "@smithy/types";
import { AWS_REGION, DOCS_BUCKET_NAME } from "./config";

let amplifyConfigured = false;

/**
 * Configure Amplify Storage once per app lifecycle.
 * Call this from AwsContext after credentials are first obtained.
 *
 * `getCredentials` is called by Amplify on every S3 operation —
 * it should return the current (cached + auto-refreshed) IAM credentials.
 */
export function configureAmplifyStorage(
  getCredentials: () => Promise<AwsCredentialIdentity>,
): void {
  if (amplifyConfigured) return;
  amplifyConfigured = true;

  // In Amplify v6, custom credentials are provided via Auth.credentialsProvider
  // in the LibraryOptions (second argument to Amplify.configure).
  Amplify.configure(
    {
      Storage: {
        S3: {
          bucket: DOCS_BUCKET_NAME,
          region: AWS_REGION,
        },
      },
    },
    {
      Auth: {
        credentialsProvider: {
          getCredentialsAndIdentityId: async () => ({
            credentials: await getCredentials(),
          }),
          clearCredentialsAndIdentityId: () => {},
        },
      },
    },
  );
}

/**
 * Upload a File directly to S3 under the given key.
 * Progress callback receives a value 0–100.
 */
export async function uploadFileToS3(
  key: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<void> {
  await uploadData({
    key,
    data: file,
    options: {
      contentType: file.type,
      onProgress: ({ transferredBytes, totalBytes }) => {
        if (onProgress && totalBytes) {
          onProgress(Math.round((transferredBytes / totalBytes) * 100));
        }
      },
    },
  }).result;
}

/**
 * Get a short-lived presigned URL for downloading a file from S3.
 * Expires in 15 minutes.
 */
export async function getS3PresignedUrl(key: string): Promise<string> {
  const { url } = await getUrl({ key, options: { expiresIn: 900 } });
  return url.toString();
}

/**
 * Delete a file from S3 by key.
 */
export async function removeFromS3(key: string): Promise<void> {
  await remove({ key });
}
