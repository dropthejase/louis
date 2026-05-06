import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { SupabaseClient } from '@supabase/supabase-js';

export function makeReadTableCellsTool(db: SupabaseClient) {
  return tool({
    name: 'read_table_cells',
    description: 'Read cells from a tabular review.',
    inputSchema: z.object({
      review_id: z.string().describe('Tabular review ID'),
      column_index: z.number().int().optional().describe('Filter to specific column index'),
    }),
    callback: async ({ review_id, column_index }): Promise<string> => {
      let query = db.from('tabular_cells').select('column_index, content, citations, document_id').eq('review_id', review_id);
      if (column_index !== undefined) query = query.eq('column_index', column_index);
      const { data, error } = await query;
      if (error) return `Error: ${error.message}`;
      if (!data || data.length === 0) return 'No cells found.';
      return JSON.stringify(data);
    },
  });
}
