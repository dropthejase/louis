import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { DocIndex } from '../lib/doc-context';

export function makeListDocumentsTool(docIndex: DocIndex) {
  return tool({
    name: 'list_documents',
    description: 'List all documents available in the current context.',
    inputSchema: z.object({}),
    callback: async (): Promise<string> => {
      const entries = Object.entries(docIndex);
      if (entries.length === 0) return 'No documents available.';
      return entries
        .map(([label, meta]) => `${label}: ${meta.filename} (v${meta.version_number ?? 1})`)
        .join('\n');
    },
  });
}
