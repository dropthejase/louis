import { S3Event } from 'aws-lambda';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Logger } from '@aws-lambda-powertools/logger';
import { docxToPdf, convertedPdfKey } from './convert';

const logger = new Logger({ serviceName: 'mike-conversion' });

const s3 = new S3Client({});
const secretsManager = new SecretsManagerClient({});

// Cached across warm invocations
let supabase: SupabaseClient | null = null;

async function getSupabase(): Promise<SupabaseClient> {
  if (supabase) return supabase;

  const secretArn = process.env.SUPABASE_SECRET_ARN!;
  const result = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: secretArn })
  );
  const { url, serviceRoleKey } = JSON.parse(result.SecretString!);
  supabase = createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  });
  return supabase;
}

export const handler = async (event: S3Event): Promise<void> => {
  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const sourceKey = decodeURIComponent(
      record.s3.object.key.replace(/\+/g, ' ')
    );
    logger.info('Processing conversion', { bucket, sourceKey });
    try {
      await convertDocument(bucket, sourceKey);
    } catch (err) {
      logger.error('Conversion failed', { bucket, sourceKey, err });
      // Do not rethrow — let remaining records process.
      // Failed conversion leaves pdf_storage_path null; UI shows docx viewer fallback.
    }
  }
};

async function convertDocument(bucket: string, sourceKey: string): Promise<void> {
  // 1. Download source DOCX from S3
  const getResult = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: sourceKey })
  );
  if (!getResult.Body) throw new Error(`Empty body for key: ${sourceKey}`);
  const docxBuffer = Buffer.from(await getResult.Body.transformToByteArray());

  // 2. Convert to PDF
  const pdfBuffer = await docxToPdf(docxBuffer);

  // 3. Derive PDF key and upload
  const pdfKey = convertedPdfKey(sourceKey);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: pdfKey,
      Body: pdfBuffer,
      ContentType: 'application/pdf',
    })
  );
  logger.info('PDF uploaded', { pdfKey });

  // 4. Update document_versions: set pdf_storage_path where storage_path = sourceKey
  const db = await getSupabase();
  const { data: versions, error: fetchErr } = await db
    .from('document_versions')
    .select('id, document_id')
    .eq('storage_path', sourceKey);

  if (fetchErr) throw new Error(`DB fetch failed: ${fetchErr.message}`);
  if (!versions || versions.length === 0) {
    logger.warn('No document_versions row found for source key', { sourceKey });
    return;
  }

  const versionIds = versions.map((v: { id: string }) => v.id);

  const { error: updateVersionErr } = await db
    .from('document_versions')
    .update({ pdf_storage_path: pdfKey })
    .in('id', versionIds);

  if (updateVersionErr) {
    throw new Error(`document_versions update failed: ${updateVersionErr.message}`);
  }
  logger.info('document_versions updated', { versionIds, pdfKey });

  // 5. Update documents: set status = 'ready' where current_version_id is one of ours
  const docIds = [...new Set(versions.map((v: { document_id: string }) => v.document_id))];

  const { error: updateDocErr } = await db
    .from('documents')
    .update({ status: 'ready' })
    .in('current_version_id', versionIds)
    .in('id', docIds);

  if (updateDocErr) {
    throw new Error(`documents status update failed: ${updateDocErr.message}`);
  }
  logger.info('documents status set to ready', { docIds });
}
