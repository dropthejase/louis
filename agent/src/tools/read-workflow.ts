import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { queryOne } from '../lib/db';

export function makeReadWorkflowTool(userId: string) {
  return tool({
    name: 'read_workflow',
    description: 'Load the full prompt instructions for a workflow.',
    inputSchema: z.object({
      workflow_id: z.string().describe('Workflow ID'),
    }),
    callback: async ({ workflow_id }): Promise<string> => {
      const row = await queryOne<{ title: string; prompt_md: string }>(
        `SELECT title, prompt_md FROM workflows
         WHERE id = :workflowId AND (user_id = :userId OR is_system = true)`,
        [
          { name: 'workflowId', value: { stringValue: workflow_id } },
          { name: 'userId', value: { stringValue: userId } },
        ],
      );
      if (!row) return `Error: workflow ${workflow_id} not found.`;
      return `# ${row.title}\n\n${row.prompt_md}`;
    },
  });
}
