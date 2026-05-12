/**
 * `fetch_documents` tool — batch-read text content from multiple documents.
 *
 * Equivalent to calling read_document on each ID in sequence, but in a single
 * tool call to reduce round-trips. PDFs are extracted via pdfjs-dist;
 * DOCX/DOC files via mammoth. Returns a concatenated string with one labelled
 * section per document.
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

export function makeFetchDocumentsTool(docStore: DocStore) {
  return tool({
    name: 'fetch_documents',
    description: 'Fetch text content of multiple documents at once.',
    inputSchema: z.object({
      doc_ids: z.array(z.string()).describe('Array of document IDs to fetch'),
    }),
    callback: async ({ doc_ids }): Promise<string> => {
      const results: string[] = [];
      for (const doc_id of doc_ids) {
        const entry = docStore.get(doc_id);
        if (!entry) { results.push(`${doc_id}: not found`); continue; }
        try {
          const buf = await downloadFile(entry.storage_path);
          let text = '';
          if (entry.file_type === 'pdf') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const pdf = await (pdfjsLib as any).getDocument({ data: new Uint8Array(buf) }).promise;
            const pages: string[] = [];
            for (let p = 1; p <= pdf.numPages; p++) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const page = await pdf.getPage(p);
              const content = await page.getTextContent();
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              pages.push(`[Page ${p}]\n${content.items.map((i: any) => i.str).join(' ')}`);
            }
            text = pages.join('\n\n');
          } else {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const result = await (mammoth as any).extractRawText({ buffer: Buffer.from(buf) });
            text = result.value as string;
          }
          results.push(`=== ${doc_id} (${entry.filename}) ===\n${text}`);
        } catch (err) {
          logError('fetch_documents', 'Failed to fetch document', err, { doc_id, storage_path: entry.storage_path });
          results.push(`${doc_id}: error reading document`);
        }
      }
      return results.join('\n\n');
    },
  });
}
