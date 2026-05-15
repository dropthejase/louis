/**
 * `read_table_cells` tool — read extracted cell data from a tabular review.
 *
 * Enforces that the review belongs to the userId injected at factory time.
 * Returns cells as a JSON string so the agent can read and compare column
 * summaries without accessing raw document bytes.
 */
import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { query } from '../lib/db';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { logError } from '../lib/logger';

export function makeReadTableCellsTool(userId: string) {
  return tool({
    name: 'read_table_cells',
    description: 'Read cells from a tabular review.',
    inputSchema: z.object({
      review_id: z.string().describe('Tabular review ID'),
      column_index: z.number().int().optional().describe('Filter to specific column index'),
    }),
    callback: async ({ review_id, column_index }): Promise<string> => {
      try {
        let sql = `SELECT tc.column_index, tc.content, tc.citations, tc.document_id
          FROM tabular_cells tc
          JOIN tabular_reviews tr ON tr.id = tc.review_id
          WHERE tc.review_id = :reviewId AND tr.user_id = :userId`;
        const params: SqlParameter[] = [
          { name: 'reviewId', value: { stringValue: review_id } },
          { name: 'userId', value: { stringValue: userId } },
        ];
        if (column_index !== undefined) {
          sql += ` AND tc.column_index = :columnIndex`;
          params.push({ name: 'columnIndex', value: { longValue: column_index } });
        }

        const data = await query(sql, params);
        if (data.length === 0) return 'No cells found.';
        return JSON.stringify(data);
      } catch (err) {
        logError('read_table_cells', 'Failed to read table cells', err, { review_id, column_index });
        return `Error: failed to read table cells for review ${review_id}.`;
      }
    },
  });
}
