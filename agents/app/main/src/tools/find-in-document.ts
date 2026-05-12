/**
 * `find_in_document` tool — case-insensitive, whitespace-tolerant substring search.
 *
 * Extracts the document text (via pdfjs or mammoth), normalises whitespace,
 * and returns up to `max_results` matches with surrounding context characters.
 * Useful when the agent needs to pinpoint a specific clause before editing.
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

function normalizeText(t: string): string {
  return t.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function makeFindInDocumentTool(docStore: DocStore) {
  return tool({
    name: 'find_in_document',
    description: 'Search for specific strings inside a document. Returns matches with surrounding context.',
    inputSchema: z.object({
      doc_id: z.string().describe("Document ID to search (e.g. 'doc-0')"),
      query: z.string().describe('String to search for (case-insensitive, whitespace-tolerant)'),
      max_results: z.number().int().optional().describe('Max matches to return (default 20)'),
      context_chars: z.number().int().optional().describe('Context chars each side (default 80)'),
    }),
    callback: async ({ doc_id, query, max_results = 20, context_chars = 80 }): Promise<string> => {
      const entry = docStore.get(doc_id);
      if (!entry) return `Error: document ${doc_id} not found.`;

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
          pages.push(content.items.map((i: any) => i.str).join(' '));
        }
        text = pages.join('\n\n');
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await (mammoth as any).extractRawText({ buffer: Buffer.from(buf) });
        text = result.value as string;
      }

      const normText = normalizeText(text);
      const normQuery = normalizeText(query);
      const results: string[] = [];
      let searchFrom = 0;

      while (results.length < max_results) {
        const idx = normText.indexOf(normQuery, searchFrom);
        if (idx === -1) break;
        const start = Math.max(0, idx - context_chars);
        const end = Math.min(text.length, idx + normQuery.length + context_chars);
        results.push(`...${text.slice(start, end)}...`);
        searchFrom = idx + 1;
      }

      if (results.length === 0) return `No matches found for "${query}" in ${doc_id}.`;
      return results.join('\n---\n');
      } catch (err) {
        logError('find_in_document', 'Failed to search document', err, { doc_id, query });
        return `Error: failed to search document ${doc_id}.`;
      }
    },
  });
}
