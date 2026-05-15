/**
 * Skills routes — manage user-uploaded Strands Skills folders in S3.
 *
 * Skills are stored in the skills bucket at <userId>/<skillName>/<file>.
 * The agent downloads them to /tmp/<userId>/skills/ on first invocation.
 *
 * No bash/shell tool is provided to the agent — skills are read-only
 * knowledge injection (SKILL.md instructions + reference files).
 *
 * Routes:
 *   GET    /skills              — list user's skills (name + description from SKILL.md)
 *   POST   /skills/prepare      — get presigned PutObject URL for a single file upload
 *   DELETE /skills/:skillName   — delete all objects under <userId>/<skillName>/
 */
import { Router } from "express";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectsCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { requireAuth } from "../middleware/auth";

export const skillsRouter = Router();

function getSkillsClient(): S3Client {
  return new S3Client({ region: process.env.AWS_REGION ?? "eu-west-1" });
}

function getSkillsBucket(): string {
  const bucket = process.env.SKILLS_BUCKET_NAME;
  if (!bucket) throw new Error("SKILLS_BUCKET_NAME is not set");
  return bucket;
}

function parseSkillMd(content: string): { name: string; description: string } {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return { name: '', description: '' };
  const fm = frontmatterMatch[1];
  const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? '';
  const description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '';
  return { name, description };
}

// GET /skills — list installed skills
skillsRouter.get("/", requireAuth, async (req, res) => {
  try {
    const userId = res.locals.userId as string;
    const s3 = getSkillsClient();
    const bucket = getSkillsBucket();
    const prefix = `${userId}/`;

    const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, Delimiter: '/' }));

    const skillNames = (list.CommonPrefixes ?? [])
      .map(cp => cp.Prefix?.slice(prefix.length).replace(/\/$/, '') ?? '')
      .filter(Boolean);

    const skills = await Promise.all(skillNames.map(async (skillName) => {
      const skillMdKey = `${userId}/${skillName}/SKILL.md`;
      try {
        const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: skillMdKey }));
        const content = await obj.Body?.transformToString() ?? '';
        const { name, description } = parseSkillMd(content);
        return { skillName, name: name || skillName, description };
      } catch (err: any) {
        // NoSuchKey = SKILL.md missing — skill folder may be partially uploaded
        if (err?.name !== 'NoSuchKey') {
          console.warn(`[skills] failed to read SKILL.md for skill '${skillName}'`, err);
        }
        return { skillName, name: skillName, description: '' };
      }
    }));

    res.json({ skills });
  } catch (err) {
    console.error("[skills] GET / error:", err);
    res.status(500).json({ detail: "Failed to list skills" });
  }
});

// POST /skills/prepare — get presigned URL for a single file upload
skillsRouter.post("/prepare", requireAuth, async (req, res) => {
  try {
    const userId = res.locals.userId as string;
    const { skillName, filePath, contentType } = req.body as {
      skillName?: string;
      filePath?: string;
      contentType?: string;
    };

    if (!skillName || !filePath || !contentType) {
      res.status(400).json({ detail: "skillName, filePath, and contentType are required" });
      return;
    }

    // Sanitize: skill name and file path must not contain path traversal
    if (/\.\./.test(skillName) || /\.\./.test(filePath)) {
      res.status(400).json({ detail: "Invalid skillName or filePath" });
      return;
    }

    const key = `${userId}/${skillName}/${filePath}`;
    const s3 = getSkillsClient();
    const bucket = getSkillsBucket();

    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
      { expiresIn: 900 },
    );

    res.json({ url, key });
  } catch (err) {
    console.error("[skills] POST /prepare error:", err);
    res.status(500).json({ detail: "Failed to generate upload URL" });
  }
});

// GET /skills/:skillName/files — list all files within a skill folder
skillsRouter.get("/:skillName/files", requireAuth, async (req, res) => {
  try {
    const userId = res.locals.userId as string;
    const { skillName } = req.params;

    if (!skillName || /\.\./.test(skillName)) {
      res.status(400).json({ detail: "Invalid skillName" });
      return;
    }

    const s3 = getSkillsClient();
    const bucket = getSkillsBucket();
    const prefix = `${userId}/${skillName}/`;

    let continuationToken: string | undefined;
    const files: { path: string; size: number }[] = [];

    do {
      const list = await s3.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }));
      for (const obj of list.Contents ?? []) {
        if (!obj.Key) continue;
        const path = obj.Key.slice(prefix.length);
        if (path) files.push({ path, size: obj.Size ?? 0 });
      }
      continuationToken = list.NextContinuationToken;
    } while (continuationToken);

    res.json({ files });
  } catch (err) {
    console.error("[skills] GET /:skillName/files error:", err);
    res.status(500).json({ detail: "Failed to list skill files" });
  }
});

// GET /skills/:skillName/file?path=... — presigned GetObject URL for file preview
skillsRouter.get("/:skillName/file", requireAuth, async (req, res) => {
  try {
    const userId = res.locals.userId as string;
    const { skillName } = req.params;
    const filePath = req.query.path as string | undefined;

    if (!skillName || /\.\./.test(skillName) || !filePath || /\.\./.test(filePath)) {
      res.status(400).json({ detail: "Invalid skillName or path" });
      return;
    }

    const key = `${userId}/${skillName}/${filePath}`;
    const s3 = getSkillsClient();
    const bucket = getSkillsBucket();

    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: 300 },
    );

    res.json({ url });
  } catch (err) {
    console.error("[skills] GET /:skillName/file error:", err);
    res.status(500).json({ detail: "Failed to generate file URL" });
  }
});

// DELETE /skills/:skillName — delete entire skill folder
skillsRouter.delete("/:skillName", requireAuth, async (req, res) => {
  try {
    const userId = res.locals.userId as string;
    const { skillName } = req.params;

    if (!skillName || /\.\./.test(skillName)) {
      res.status(400).json({ detail: "Invalid skillName" });
      return;
    }

    const s3 = getSkillsClient();
    const bucket = getSkillsBucket();
    const prefix = `${userId}/${skillName}/`;

    // List all objects under the prefix
    let continuationToken: string | undefined;
    const allKeys: { Key: string }[] = [];

    do {
      const list = await s3.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }));
      for (const obj of list.Contents ?? []) {
        if (obj.Key) allKeys.push({ Key: obj.Key });
      }
      continuationToken = list.NextContinuationToken;
    } while (continuationToken);

    if (allKeys.length === 0) {
      res.status(404).json({ detail: "Skill not found" });
      return;
    }

    await s3.send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: allKeys, Quiet: true },
    }));

    res.json({ deleted: allKeys.length });
  } catch (err) {
    console.error("[skills] DELETE /:skillName error:", err);
    res.status(500).json({ detail: "Failed to delete skill" });
  }
});
