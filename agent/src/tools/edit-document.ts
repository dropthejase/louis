import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { downloadFile, uploadFile, getPresignedUrl } from '../lib/storage';
import { SupabaseClient } from '@supabase/supabase-js';
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
  db: SupabaseClient
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

      const { data: versionRow } = await db.from('document_versions').insert({
        document_id: docId,
        storage_path: newKey,
        source: 'assistant_edit',
        version_number: newVersionNumber,
        display_name: versionSlug,
      }).select().single();

      let versionId: string | undefined;
      const annotations: unknown[] = [];

      if (versionRow) {
        versionId = versionRow.id as string;
        await db.from('documents').update({ current_version_id: versionRow.id }).eq('id', docId);
        // Record individual edits
        for (const edit of edits) {
          const { data: editRow } = await db.from('document_edits').insert({
            document_id: docId,
            version_id: versionRow.id,
            deleted_text: edit.find,
            inserted_text: edit.replace,
            status: 'pending',
          }).select().single();
          if (editRow) {
            annotations.push({
              type: 'edit_data',
              id: (editRow as { id: string }).id,
              document_id: docId,
              version_id: versionId,
              deleted_text: edit.find,
              inserted_text: edit.replace,
            });
          }
        }
        // Update docStore
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
