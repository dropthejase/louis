import { S3Event } from 'aws-lambda';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { Logger } from '@aws-lambda-powertools/logger';
import { docxToPdf, convertedPdfKey } from './convert';
import { query, execute } from './lib/db';

const logger = new Logger({ serviceName: 'mike-conversion' });

const s3 = new S3Client({});

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

  // 4. Find document_versions rows by storage_path
  const versions = await query<{ id: string; document_id: string }>(
    'SELECT id, document_id FROM document_versions WHERE storage_path = :sourceKey',
    [{ name: 'sourceKey', value: { stringValue: sourceKey } }],
  );

  if (versions.length === 0) {
    logger.warn('No document_versions row found for source key', { sourceKey });
    return;
  }

  // 5. Update pdf_storage_path for each version
  for (const version of versions) {
    await execute(
      'UPDATE document_versions SET pdf_storage_path = :pdfKey WHERE id = :versionId',
      [
        { name: 'pdfKey', value: { stringValue: pdfKey } },
        { name: 'versionId', value: { stringValue: version.id } },
      ],
    );
  }
  logger.info('document_versions updated', { versionIds: versions.map(v => v.id), pdfKey });

  // 6. Update documents status for each version's document
  for (const version of versions) {
    await execute(
      "UPDATE documents SET status = 'ready' WHERE id = :docId AND current_version_id = :versionId",
      [
        { name: 'docId', value: { stringValue: version.document_id } },
        { name: 'versionId', value: { stringValue: version.id } },
      ],
    );
  }
  logger.info('documents status set to ready', { docIds: versions.map(v => v.document_id) });
}
