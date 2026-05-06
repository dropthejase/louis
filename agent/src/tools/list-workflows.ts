import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { SupabaseClient } from '@supabase/supabase-js';

export function makeListWorkflowsTool(
  userId: string,
  db: SupabaseClient
) {
  return tool({
    name: 'list_workflows',
    description: 'List available workflow templates.',
    inputSchema: z.object({
      type: z.enum(['assistant', 'tabular']).optional().describe('Filter by workflow type'),
    }),
    callback: async ({ type }): Promise<string> => {
      let query = db
        .from('workflows')
        .select('id, title, type, practice')
        .or(`user_id.eq.${userId},is_system.eq.true`);
      if (type) query = query.eq('type', type);
      const { data, error } = await query.order('title');
      if (error) return `Error: ${error.message}`;
      if (!data || data.length === 0) return 'No workflows found.';
      return data.map((w: { title: string; id: string; type: string }) => `[Workflow: ${w.title} (id: ${w.id})] type=${w.type}`).join('\n');
    },
  });
}
