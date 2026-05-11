/**
 * Conversion Lambda handler — DOCX→PDF conversion triggered by S3 EventBridge.
 *
 * Listens for `Object Created` events on .docx, .doc, and .pdf files under the
 * `documents/` prefix of the docs bucket (configured in ConversionStack).
 * EventBridge sends a single event per object, not an S3Event Records array.
 *
 * For .docx/.doc: converts to PDF via LibreOffice, uploads to `converted-pdfs/`,
 * and updates document_versions.pdf_storage_path.
 * For .pdf: the file is already a PDF — just record its own key as pdf_storage_path.
 *
 * Runs on x86_64 (LibreOffice is not available for ARM64 in the Lambda
 * container image). Errors are logged — a failed conversion leaves
 * pdf_storage_path null and the UI falls back to the DOCX viewer.
 */
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { Logger } from '@aws-lambda-powertools/logger';
import { docxToPdf, convertedPdfKey } from './convert';
import { query, execute } from './lib/db';

// EventBridge S3 "Object Created" event detail shape.
interface EventBridgeS3Event {
  detail: {
    bucket: { name: string };
    object: { key: string };
  };
}

const logger = new Logger({ serviceName: 'mike-conversion' });

const s3 = new S3Client({});

export const handler = async (event: EventBridgeS3Event): Promise<void> => {
  const bucket = event.detail.bucket.name;
  // EventBridge URL-encodes the key with + for spaces; decode it.
  const sourceKey = decodeURIComponent(event.detail.object.key.replace(/\+/g, ' '));

  logger.info('Processing conversion', { bucket, sourceKey });
  try {
    await convertDocument(bucket, sourceKey);
  } catch (err) {
    logger.error('Conversion failed', { bucket, sourceKey, err });
    // Do not rethrow — failed conversion leaves pdf_storage_path null; UI shows docx viewer fallback.
  }
};

async function convertDocument(bucket: string, sourceKey: string): Promise<void> {
  const isPdf = sourceKey.toLowerCase().endsWith('.pdf');

  let pdfKey: string;

  if (isPdf) {
    // PDF uploaded directly — use it as-is; derive the canonical key for DB.
    pdfKey = convertedPdfKey(sourceKey);
    // Copy into the converted-pdfs/ prefix so the URL pattern is consistent.
    const getResult = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: sourceKey })
    );
    if (!getResult.Body) throw new Error(`Empty body for key: ${sourceKey}`);
    const pdfBuffer = Buffer.from(await getResult.Body.transformToByteArray());
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: pdfKey,
        Body: pdfBuffer,
        ContentType: 'application/pdf',
      })
    );
    logger.info('PDF passthrough uploaded', { pdfKey });
  } else {
    // 1. Download source DOCX from S3
    const getResult = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: sourceKey })
    );
    if (!getResult.Body) throw new Error(`Empty body for key: ${sourceKey}`);
    const docxBuffer = Buffer.from(await getResult.Body.transformToByteArray());

    // 2. Convert to PDF
    const pdfBuffer = await docxToPdf(docxBuffer);

    // 3. Derive PDF key and upload
    pdfKey = convertedPdfKey(sourceKey);
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: pdfKey,
        Body: pdfBuffer,
        ContentType: 'application/pdf',
      })
    );
    logger.info('PDF uploaded', { pdfKey });
  }

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
