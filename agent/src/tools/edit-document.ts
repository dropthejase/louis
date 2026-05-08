import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { downloadFile, uploadFile, getPresignedUrl } from '../lib/storage';
import { query, execute } from '../lib/db';
import { DocStore, DocIndex } from '../lib/doc-context';
import { applyTrackedEdits, type EditInput } from '../lib/docx-tracked-changes';

const EditSchema = z.object({
  find: z.string(),
  replace: z.string(),
  context_before: z.string(),
  context_after: z.string(),
  reason: z.string().optional(),
});

export function makeEditDocumentTool(
  userId: string,
  docStore: DocStore,
  docIndex: DocIndex,
) {
  return tool({
    name: 'edit_document',
    description: 'Propose tracked-change edits to a .docx document. Returns per-edit annotations and a download URL.',
    inputSchema: z.object({
      doc_id: z.string().describe("Document slug (e.g. 'doc-0')"),
      edits: z.array(EditSchema).describe('List of precise substitutions'),
    }),
    callback: async ({ doc_id, edits }): Promise<string> => {
      const entry = docStore.get(doc_id);
      if (!entry) return `Error: document ${doc_id} not found.`;
      if (entry.file_type !== 'docx' && entry.file_type !== 'doc') {
        return `Error: edit_document only supports .docx files.`;
      }

      const meta = docIndex[doc_id];
      if (!meta) return `Error: no index entry for ${doc_id}.`;

      const buf = await downloadFile(entry.storage_path);
      const docId = meta.document_id;
      const newVersionNumber = (meta.version_number ?? 1) + 1;
      const versionSlug = `v${newVersionNumber}`;
      const newKey = `documents/${userId}/${docId}/versions/${versionSlug}.docx`;

      const editInputs: EditInput[] = edits.map(e => ({
        find: e.find,
        replace: e.replace,
        context_before: e.context_before,
        context_after: e.context_after,
        reason: e.reason,
      }));

      const { bytes: editedBuf } = await applyTrackedEdits(Buffer.from(buf), editInputs, { author: 'Mike' });

      await uploadFile(newKey, editedBuf, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

      const versionRows = await query<{ id: string }>(
        `INSERT INTO document_versions (document_id, storage_path, source, version_number, display_name)
         VALUES (:documentId, :storagePath, 'assistant_edit', :versionNumber, :displayName)
         RETURNING id`,
        [
          { name: 'documentId', value: { stringValue: docId } },
          { name: 'storagePath', value: { stringValue: newKey } },
          { name: 'versionNumber', value: { longValue: newVersionNumber } },
          { name: 'displayName', value: { stringValue: versionSlug } },
        ],
      );

      let versionId: string | undefined;
      const annotations: unknown[] = [];

      if (versionRows.length > 0) {
        versionId = versionRows[0].id;

        await execute(
          `UPDATE documents SET current_version_id = :versionId WHERE id = :documentId AND user_id = :userId`,
          [
            { name: 'versionId', value: { stringValue: versionId } },
            { name: 'documentId', value: { stringValue: docId } },
            { name: 'userId', value: { stringValue: userId } },
          ],
        );

        for (const edit of edits) {
          const editRows = await query<{ id: string }>(
            `INSERT INTO document_edits (document_id, version_id, deleted_text, inserted_text, status)
             VALUES (:documentId, :versionId, :deletedText, :insertedText, 'pending')
             RETURNING id`,
            [
              { name: 'documentId', value: { stringValue: docId } },
              { name: 'versionId', value: { stringValue: versionId } },
              { name: 'deletedText', value: { stringValue: edit.find } },
              { name: 'insertedText', value: { stringValue: edit.replace } },
            ],
          );
          if (editRows.length > 0) {
            annotations.push({
              type: 'edit_data',
              id: editRows[0].id,
              document_id: docId,
              version_id: versionId,
              deleted_text: edit.find,
              inserted_text: edit.replace,
            });
          }
        }

        docStore.set(doc_id, { ...entry, storage_path: newKey });
        meta.version_id = versionId;
        meta.version_number = newVersionNumber;
      }

      const url = await getPresignedUrl(newKey, 900, entry.filename);
      return JSON.stringify({
        doc_id,
        filename: entry.filename,
        document_id: docId,
        version_id: versionId,
        version: newVersionNumber,
        edits_applied: edits.length,
        download_url: url,
        annotations,
      });
    },
  });
}
