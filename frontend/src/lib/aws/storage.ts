import { uploadData, getUrl, remove } from 'aws-amplify/storage';

// Amplify is configured once at startup in App.tsx with Storage + Auth (Identity Pool).
// No per-call configuration needed here.

/**
 * Upload a File directly to S3 at the exact given path (no public/ prefix).
 * Uses `path` parameter so Amplify writes to the exact S3 key.
 * Progress callback receives a value 0–100.
 */
export async function uploadFileToS3(
  s3Path: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<void> {
  await uploadData({
    path: s3Path,
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

export async function getS3PresignedUrl(s3Path: string): Promise<string> {
  const { url } = await getUrl({ path: s3Path, options: { expiresIn: 900 } });
  return url.toString();
}

export async function removeFromS3(s3Path: string): Promise<void> {
  await remove({ path: s3Path });
}
