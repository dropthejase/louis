/**
 * `read_workflow` tool — load the full prompt instructions for a workflow.
 *
 * Returns the workflow title and prompt_md so the agent can follow the
 * workflow's instructions for the current turn. Access is limited to the
 * user's own workflows and system workflows (is_system = true).
 */
import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import { queryOne } from '../lib/db';
import { logError } from '../lib/logger';

export function makeReadWorkflowTool(userId: string) {
  return tool({
    name: 'read_workflow',
    description: 'Load the full prompt instructions for a workflow.',
    inputSchema: z.object({
      workflow_id: z.string().describe('Workflow ID'),
    }),
    callback: async ({ workflow_id }): Promise<string> => {
      try {
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
      } catch (err) {
        logError('read_workflow', 'Failed to read workflow', err, { workflow_id });
        return `Error: failed to read workflow ${workflow_id}: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  });
}
