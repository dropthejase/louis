/**
 * Skills download helper — syncs a user's skills from S3 to /tmp/<userId>/skills/
 * on first invocation per microVM session.
 *
 * The AgentCore microVM filesystem persists across turns within a session.
 * We check for the presence of the skills directory before downloading to
 * avoid redundant S3 calls on subsequent turns in the same session.
 */
import * as fs from 'fs';
import * as path from 'path';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'eu-west-1' });
const SKILLS_BUCKET = process.env.SKILLS_BUCKET_NAME!;

export function skillsLocalBase(userId: string): string {
  return path.resolve('/tmp', userId, 'skills');
}

export async function ensureSkillsDownloaded(userId: string): Promise<void> {
  const localBase = skillsLocalBase(userId);

  if (fs.existsSync(localBase) && fs.readdirSync(localBase).length > 0) {
    return;
  }

  const prefix = `${userId}/`;
  let continuationToken: string | undefined;

  do {
    const list = await s3.send(new ListObjectsV2Command({
      Bucket: SKILLS_BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));

    for (const obj of list.Contents ?? []) {
      if (!obj.Key) continue;
      // Strip the userId prefix to get the relative path within localBase
      const relativePath = obj.Key.slice(prefix.length);
      if (!relativePath) continue;

      const localPath = path.join(localBase, relativePath);
      fs.mkdirSync(path.dirname(localPath), { recursive: true });

      const get = await s3.send(new GetObjectCommand({ Bucket: SKILLS_BUCKET, Key: obj.Key }));
      const body = await get.Body?.transformToByteArray();
      if (body) fs.writeFileSync(localPath, body);
    }

    continuationToken = list.NextContinuationToken;
  } while (continuationToken);
}
