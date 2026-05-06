import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { downloadFile, uploadFile } from '../lib/storage';
import { SupabaseClient } from '@supabase/supabase-js';
import { DocStore, DocIndex } from '../lib/doc-context';

export function makeReplicateDocumentTool(
  userId: string,
  docStore: DocStore,
  docIndex: DocIndex,
  db: SupabaseClient
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

      const buf = await downloadFile(entry.storage_path);
      const newDocId = crypto.randomUUID();
      const filename = new_filename ?? `Copy of ${entry.filename}`;
      const ext = entry.filename.split('.').pop() ?? 'docx';
      const newKey = `documents/${userId}/${newDocId}/source.${ext}`;

      await uploadFile(newKey, Buffer.from(buf), `application/vnd.openxmlformats-officedocument.wordprocessingml.document`);

      const { data: versionRow } = await db.from('document_versions').insert({
        document_id: newDocId,
        storage_path: newKey,
        source: 'replicated',
        version_number: 1,
        display_name: 'v1',
      }).select().single();

      await db.from('documents').insert({
        id: newDocId,
        user_id: userId,
        filename,
        file_type: entry.file_type,
        size_bytes: buf.byteLength,
        status: 'ready',
        current_version_id: versionRow ? (versionRow as { id: string }).id : null,
      });

      const label = `doc-${Object.keys(docIndex).length}`;
      docStore.set(label, { storage_path: newKey, file_type: entry.file_type, filename });
      docIndex[label] = { document_id: newDocId, filename, version_number: 1 };

      return JSON.stringify({ new_doc_id: label, filename });
    },
  });
}
