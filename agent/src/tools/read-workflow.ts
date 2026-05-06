import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { SupabaseClient } from '@supabase/supabase-js';

export function makeReadWorkflowTool(db: SupabaseClient) {
  return tool({
    name: 'read_workflow',
    description: 'Load the full prompt instructions for a workflow.',
    inputSchema: z.object({
      workflow_id: z.string().describe('Workflow ID'),
    }),
    callback: async ({ workflow_id }): Promise<string> => {
      const { data, error } = await db
        .from('workflows')
        .select('title, prompt_md')
        .eq('id', workflow_id)
        .single();
      if (error || !data) return `Error: workflow ${workflow_id} not found.`;
      return `# ${(data as { title: string; prompt_md: string }).title}\n\n${(data as { title: string; prompt_md: string }).prompt_md}`;
    },
  });
}
