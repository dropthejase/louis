import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'eu-west-1' });
const BUCKET = process.env.DOCS_BUCKET_NAME!;

export async function downloadFile(key: string): Promise<ArrayBuffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const bytes = await res.Body!.transformToByteArray();
  return bytes.buffer as ArrayBuffer;
}

export async function uploadFile(key: string, body: Buffer | Uint8Array, contentType: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }));
}

export async function deleteFile(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

export async function getPresignedUrl(key: string, expiresIn = 900, downloadFilename?: string): Promise<string> {
  const cmd = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ...(downloadFilename && {
      ResponseContentDisposition: `attachment; filename="${encodeURIComponent(downloadFilename)}"`,
    }),
  });
  return getSignedUrl(s3, cmd, { expiresIn });
}
