/**
 * `replicate_document` tool — copy an existing project document as a new document.
 *
 * Verifies that the source document is owned by userId before copying bytes.
 * The copy gets its own document row, version row (source='upload'), and
 * docStore/docIndex entry so it can be edited immediately in the same turn.
 * Only available when a projectId is present (see createAgent in agent.ts).
 */
import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { downloadFile, uploadFile } from '../lib/storage';
import { query, execute } from '../lib/db';
import { DocStore, DocIndex } from '../lib/doc-context';
import { logError } from '../lib/logger';

export function makeReplicateDocumentTool(
  userId: string,
  projectId: string,
  docStore: DocStore,
  docIndex: DocIndex,
) {
  return tool({
    name: 'replicate_document',
    description: 'Copy a document within the current project.',
    inputSchema: z.object({
      doc_id: z.string().describe('Source document ID to copy'),
      new_filename: z.string().optional().describe('Filename for the copy'),
    }),
    callback: async ({ doc_id, new_filename }): Promise<string> => {
      const entry = docStore.get(doc_id);
      if (!entry) return `Error: document ${doc_id} not found.`;

      const meta = docIndex[doc_id];
      if (!meta) return `Error: no index entry for ${doc_id}.`;

      try {
      // Ownership check on source document
      const owned = await query<{ id: string }>(
        `SELECT id FROM documents WHERE id = :documentId AND user_id = :userId`,
        [
          { name: 'documentId', value: { stringValue: meta.document_id } },
          { name: 'userId', value: { stringValue: userId } },
        ],
      );
      if (owned.length === 0) return `Error: document ${doc_id} not found or access denied.`;

      const buf = await downloadFile(entry.storage_path);
      const newDocId = crypto.randomUUID();
      const filename = new_filename ?? `Copy of ${entry.filename}`;
      const ext = entry.filename.split('.').pop() ?? 'docx';
      const newKey = `documents/${userId}/${newDocId}/source.${ext}`;
      const contentType = entry.file_type === 'pdf'
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

      await uploadFile(newKey, Buffer.from(buf), contentType);

      // Insert document first (version row has FK to documents.id)
      await execute(
        `INSERT INTO documents (id, user_id, project_id, filename, file_type, size_bytes, status)
         VALUES (:id, :userId, :projectId::uuid, :filename, :fileType, :sizeBytes, 'ready')`,
        [
          { name: 'id', value: { stringValue: newDocId } },
          { name: 'userId', value: { stringValue: userId } },
          { name: 'projectId', value: { stringValue: projectId } },
          { name: 'filename', value: { stringValue: filename } },
          { name: 'fileType', value: { stringValue: entry.file_type } },
          { name: 'sizeBytes', value: { longValue: buf.byteLength } },
        ],
      );

      const versionRows = await query<{ id: string }>(
        `INSERT INTO document_versions (document_id, storage_path, source, version_number, display_name)
         VALUES (:documentId, :storagePath, 'upload', 1, :displayName)
         RETURNING id`,
        [
          { name: 'documentId', value: { stringValue: newDocId } },
          { name: 'storagePath', value: { stringValue: newKey } },
          { name: 'displayName', value: { stringValue: filename } },
        ],
      );

      const versionId = versionRows.length > 0 ? versionRows[0].id : null;

      if (versionId) {
        await execute(
          `UPDATE documents SET current_version_id = :versionId WHERE id = :id`,
          [
            { name: 'versionId', value: { stringValue: versionId } },
            { name: 'id', value: { stringValue: newDocId } },
          ],
        );
      }

      const label = `doc-${Object.keys(docIndex).length}`;
      docStore.set(label, { storage_path: newKey, file_type: entry.file_type, filename, document_id: newDocId, version_id: versionId ?? '' });
      docIndex[label] = { document_id: newDocId, filename, version_number: 1 };

      return JSON.stringify({
        new_doc_id: label,
        filename,
        count: 1,
        copies: [{ document_id: newDocId, version_id: versionId ?? '', new_filename: filename }],
      });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logError('replicate_document', 'Failed to replicate document', err, { doc_id });
        return `Error: failed to replicate document ${doc_id}: ${msg}`;
      }
    },
  });
}
