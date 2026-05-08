import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { query } from '../lib/db';
import type { SqlParameter } from '@aws-sdk/client-rds-data';

export function makeListWorkflowsTool(userId: string) {
  return tool({
    name: 'list_workflows',
    description: 'List available workflow templates.',
    inputSchema: z.object({
      type: z.enum(['assistant', 'tabular']).optional().describe('Filter by workflow type'),
    }),
    callback: async ({ type }): Promise<string> => {
      let sql = `SELECT id, title, type, practice FROM workflows
        WHERE (user_id = :userId OR is_system = true)`;
      const params: SqlParameter[] = [
        { name: 'userId', value: { stringValue: userId } },
      ];
      if (type) {
        sql += ` AND type = :type`;
        params.push({ name: 'type', value: { stringValue: type } });
      }
      sql += ` ORDER BY title ASC`;

      const data = await query<{ id: string; title: string; type: string; practice: string }>(sql, params);
      if (data.length === 0) return 'No workflows found.';
      return data.map(w => `[Workflow: ${w.title} (id: ${w.id})] type=${w.type}`).join('\n');
    },
  });
}
