/**
 * `read_document` tool — extract full text content from a document.
 *
 * PDFs are extracted via pdfjs-dist with per-page `[Page N]` markers so the
 * agent can correctly attribute citations. DOCX/DOC files are extracted via
 * mammoth. The agent must call this before summarising or citing document content.
 */
import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { downloadFile } from '../lib/storage';
import { DocStore } from '../lib/doc-context';
import { logError } from '../lib/logger';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.mjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mammoth = require('mammoth');

export function makeReadDocumentTool(docStore: DocStore) {
  return tool({
    name: 'read_document',
    description: 'Read the full text content of a document. Always call this before answering questions about, summarising, or citing from a document.',
    inputSchema: z.object({
      doc_id: z.string().describe("The document ID to read (e.g. 'doc-0', 'doc-1')"),
    }),
    callback: async ({ doc_id }): Promise<string> => {
      const entry = docStore.get(doc_id);
      if (!entry) return `Error: document ${doc_id} not found.`;

      try {
        const buf = await downloadFile(entry.storage_path);

        if (entry.file_type === 'pdf') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const pdf = await (pdfjsLib as any).getDocument({ data: new Uint8Array(buf) }).promise;
          const pages: string[] = [];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          for (let p = 1; p <= pdf.numPages; p++) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const page = await pdf.getPage(p);
            const content = await page.getTextContent();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            pages.push(`[Page ${p}]\n${content.items.map((i: any) => i.str).join(' ')}`);
          }
          return pages.join('\n\n');
        }

        if (entry.file_type === 'docx' || entry.file_type === 'doc') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result = await (mammoth as any).extractRawText({ buffer: Buffer.from(buf) });
          return result.value as string;
        }

        return `Error: unsupported file type ${entry.file_type}`;
      } catch (err) {
        logError('read_document', 'Failed to read document', err, { doc_id, storage_path: entry.storage_path });
        return `Error: failed to read document ${doc_id}.`;
      }
    },
  });
}
