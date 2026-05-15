/**
 * Workflow routes — user-defined assistant and tabular workflow templates.
 *
 * Workflows come in two types: `assistant` (a system-prompt extension applied
 * to a chat turn) and `tabular` (a columns_config preset for tabular reviews).
 * Sharing is per-workflow via the `workflow_shares` table. System workflows
 * (is_system = true) are read-only and visible to all users; they cannot be
 * modified or deleted via this API.
 */
import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { query, queryOne, execute } from "../lib/db";
import type { SqlParameter } from "@aws-sdk/client-rds-data";

export const workflowsRouter = Router();

type WorkflowRecord = {
  id: string;
  user_id: string | null;
  is_system: boolean;
  type?: string;
  title?: string;
  prompt_md?: string | null;
  columns_config?: unknown;
  practice?: string | null;
  created_at?: string;
  [key: string]: unknown;
};

type WorkflowAccess =
  | {
      workflow: WorkflowRecord;
      allowEdit: boolean;
      isOwner: boolean;
    }
  | null;

function withWorkflowAccess<T extends Record<string, unknown>>(
  workflow: T,
  access: { allowEdit: boolean; isOwner: boolean; sharedByName?: string | null },
) {
  return {
    ...workflow,
    columns_config: typeof workflow.columns_config === 'string'
      ? JSON.parse(workflow.columns_config)
      : (workflow.columns_config ?? null),
    allow_edit: access.allowEdit,
    is_owner: access.isOwner,
    shared_by_name: access.sharedByName ?? null,
  };
}

async function resolveWorkflowAccess(
  workflowId: string,
  userId: string,
  userEmail: string | null | undefined,
): Promise<WorkflowAccess> {
  const workflow = await queryOne<WorkflowRecord>(
    `SELECT * FROM workflows WHERE id = :id`,
    [{ name: "id", value: { stringValue: workflowId } }],
  );
  if (!workflow) return null;
  if (workflow.user_id === userId) {
    return { workflow, allowEdit: true, isOwner: true };
  }

  const normalizedUserEmail = (userEmail ?? "").trim().toLowerCase();
  if (!normalizedUserEmail) return null;

  const share = await queryOne<{ allow_edit: boolean }>(
    `SELECT allow_edit FROM workflow_shares
     WHERE workflow_id = :workflowId AND shared_with_email = :email`,
    [
      { name: "workflowId", value: { stringValue: workflowId } },
      { name: "email", value: { stringValue: normalizedUserEmail } },
    ],
  );
  if (!share) return null;

  return { workflow, allowEdit: !!share.allow_edit, isOwner: false };
}

// GET /workflows
workflowsRouter.get("/", requireAuth, async (req, res) => {
  try {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;
  const { type } = req.query as { type?: string };

  // Own workflows
  const ownParams: SqlParameter[] = [
    { name: "userId", value: { stringValue: userId } },
  ];
  let ownSql = `SELECT * FROM workflows
                WHERE user_id = :userId AND is_system = false`;
  if (type) {
    ownSql += ` AND type = :type`;
    ownParams.push({ name: "type", value: { stringValue: type } });
  }
  ownSql += ` ORDER BY created_at DESC`;
  const own = await query<WorkflowRecord>(ownSql, ownParams);

  // Shared workflows (where the current user's email appears in workflow_shares)
  const normalizedUserEmail = userEmail.trim().toLowerCase();
  const shares = await query<{
    workflow_id: string;
    shared_by_user_id: string;
    allow_edit: boolean;
  }>(
    `SELECT workflow_id, shared_by_user_id, allow_edit
     FROM workflow_shares
     WHERE shared_with_email = :email`,
    [{ name: "email", value: { stringValue: normalizedUserEmail } }],
  );

  let sharedWorkflows: Record<string, unknown>[] = [];
  if (shares.length > 0) {
    const sharedIds = shares.map((s) => s.workflow_id);
    const placeholders = sharedIds.map((_, i) => `:wid${i}::uuid`).join(", ");
    const params: SqlParameter[] = sharedIds.map((id, i) => ({
      name: `wid${i}`,
      value: { stringValue: id },
    }));
    let sharedSql = `SELECT * FROM workflows WHERE id IN (${placeholders})`;
    if (type) {
      sharedSql += ` AND type = :type`;
      params.push({ name: "type", value: { stringValue: type } });
    }
    const wfs = await query<WorkflowRecord>(sharedSql, params);

    if (wfs.length > 0) {
      // Fetch sharer profiles for display name
      const sharerIds = [...new Set(shares.map((s) => s.shared_by_user_id).filter(Boolean))];
      let profiles: { user_id: string; email: string | null; display_name: string | null }[] = [];
      if (sharerIds.length > 0) {
        const profPlaceholders = sharerIds.map((_, i) => `:sid${i}`).join(", ");
        profiles = await query<{ user_id: string; email: string | null; display_name: string | null }>(
          `SELECT user_id, email, display_name FROM user_profiles
           WHERE user_id IN (${profPlaceholders})`,
          sharerIds.map((id, i) => ({ name: `sid${i}`, value: { stringValue: id } })),
        );
      }

      sharedWorkflows = wfs.map((wf) => {
        const share = shares.find((s) => s.workflow_id === wf.id);
        const sharerId = share?.shared_by_user_id;
        const profile = profiles.find((p) => p.user_id === sharerId);
        const shared_by_name = profile?.display_name ?? profile?.email ?? null;
        return withWorkflowAccess(wf, {
          allowEdit: !!share?.allow_edit,
          isOwner: false,
          sharedByName: shared_by_name,
        });
      });
    }
  }

  const ownWithFlag = own.map((wf) =>
    withWorkflowAccess(wf, { allowEdit: true, isOwner: true }),
  );
  res.json([...ownWithFlag, ...sharedWorkflows]);
  } catch (err) {
    console.error("[workflows] GET / error:", err);
    res.status(500).json({ detail: "Internal server error" });
  }
});

// POST /workflows
workflowsRouter.post("/", requireAuth, async (req, res) => {
  try {
    const userId = res.locals.userId as string;
    const { title, type, prompt_md, columns_config, practice } = req.body as {
      title: string;
      type: string;
      prompt_md?: string;
      columns_config?: unknown;
      practice?: string | null;
    };
    if (!title?.trim())
      return void res.status(400).json({ detail: "title is required" });
    if (!["assistant", "tabular"].includes(type))
      return void res
        .status(400)
        .json({ detail: "type must be 'assistant' or 'tabular'" });

    const data = await queryOne<WorkflowRecord>(
      `INSERT INTO workflows
         (user_id, title, type, prompt_md, columns_config, practice, is_system)
       VALUES
         (:userId, :title, :type, :promptMd, :columnsConfig::jsonb, :practice, false)
       RETURNING *`,
      [
        { name: "userId", value: { stringValue: userId } },
        { name: "title", value: { stringValue: title.trim() } },
        { name: "type", value: { stringValue: type } },
        {
          name: "promptMd",
          value: prompt_md != null ? { stringValue: prompt_md } : { isNull: true },
        },
        {
          name: "columnsConfig",
          value: columns_config != null
            ? { stringValue: JSON.stringify(columns_config) }
            : { isNull: true },
        },
        {
          name: "practice",
          value: practice != null ? { stringValue: practice } : { isNull: true },
        },
      ],
    );
    if (!data) return void res.status(500).json({ detail: "Failed to create workflow" });
    res.status(201).json(data);
  } catch (err) {
    console.error("[workflows] POST / error:", err);
    res.status(500).json({ detail: "Internal server error" });
  }
});

async function handleWorkflowUpdate(
  req: import("express").Request,
  res: import("express").Response,
) {
  try {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { workflowId } = req.params;

  const access = await resolveWorkflowAccess(workflowId, userId, userEmail);
  if (!access || access.workflow.is_system || !access.allowEdit) {
    return void res
      .status(404)
      .json({ detail: "Workflow not found or not editable" });
  }

  const sets: string[] = [];
  const params: SqlParameter[] = [
    { name: "id", value: { stringValue: workflowId } },
  ];
  if (req.body.title != null) {
    sets.push(`title = :title`);
    params.push({ name: "title", value: { stringValue: String(req.body.title) } });
  }
  if (req.body.prompt_md != null) {
    sets.push(`prompt_md = :promptMd`);
    params.push({
      name: "promptMd",
      value: { stringValue: String(req.body.prompt_md) },
    });
  }
  if (req.body.columns_config != null) {
    sets.push(`columns_config = :columnsConfig::jsonb`);
    params.push({
      name: "columnsConfig",
      value: { stringValue: JSON.stringify(req.body.columns_config) },
    });
  }
  if ("practice" in req.body) {
    sets.push(`practice = :practice`);
    params.push({
      name: "practice",
      value:
        req.body.practice != null
          ? { stringValue: String(req.body.practice) }
          : { isNull: true },
    });
  }
  if (sets.length === 0) {
    // Nothing to update — return the existing record with access flags.
    return void res.json(
      withWorkflowAccess(access.workflow, {
        allowEdit: access.allowEdit,
        isOwner: access.isOwner,
      }),
    );
  }

  const data = await queryOne<WorkflowRecord>(
    `UPDATE workflows SET ${sets.join(", ")}
     WHERE id = :id AND is_system = false
     RETURNING *`,
    params,
  );
  if (!data)
    return void res
      .status(404)
      .json({ detail: "Workflow not found or not editable" });
  res.json(
    withWorkflowAccess(data, {
      allowEdit: access.allowEdit,
      isOwner: access.isOwner,
    }),
  );
  } catch (err) {
    console.error("[workflows] PUT/PATCH /:workflowId error:", err);
    res.status(500).json({ detail: "Internal server error" });
  }
}

// PUT /workflows/:workflowId
workflowsRouter.put("/:workflowId", requireAuth, handleWorkflowUpdate);

// PATCH /workflows/:workflowId
workflowsRouter.patch("/:workflowId", requireAuth, handleWorkflowUpdate);

// DELETE /workflows/:workflowId
workflowsRouter.delete("/:workflowId", requireAuth, async (req, res) => {
  try {
    const userId = res.locals.userId as string;
    const { workflowId } = req.params;
    await execute(
      `DELETE FROM workflows
       WHERE id = :id AND user_id = :userId AND is_system = false`,
      [
        { name: "id", value: { stringValue: workflowId } },
        { name: "userId", value: { stringValue: userId } },
      ],
    );
    res.status(204).send();
  } catch (err) {
    console.error("[workflows] DELETE /:workflowId error:", err);
    res.status(500).json({ detail: "Internal server error" });
  }
});

// GET /workflows/hidden
workflowsRouter.get("/hidden", requireAuth, async (req, res) => {
  try {
    const userId = res.locals.userId as string;
    const data = await query<{ workflow_id: string }>(
      `SELECT workflow_id FROM hidden_workflows WHERE user_id = :userId`,
      [{ name: "userId", value: { stringValue: userId } }],
    );
    res.json(data.map((r) => r.workflow_id));
  } catch (err) {
    console.error("[workflows] GET /hidden error:", err);
    res.status(500).json({ detail: "Internal server error" });
  }
});

// POST /workflows/hidden
workflowsRouter.post("/hidden", requireAuth, async (req, res) => {
  try {
    const userId = res.locals.userId as string;
    const { workflow_id } = req.body as { workflow_id: string };
    if (!workflow_id?.trim())
      return void res.status(400).json({ detail: "workflow_id is required" });
    await execute(
      `INSERT INTO hidden_workflows (user_id, workflow_id)
       VALUES (:userId, :workflowId)
       ON CONFLICT (user_id, workflow_id) DO NOTHING`,
      [
        { name: "userId", value: { stringValue: userId } },
        { name: "workflowId", value: { stringValue: workflow_id } },
      ],
    );
    res.status(204).send();
  } catch (err) {
    console.error("[workflows] POST /hidden error:", err);
    res.status(500).json({ detail: "Internal server error" });
  }
});

// DELETE /workflows/hidden/:workflowId
workflowsRouter.delete("/hidden/:workflowId", requireAuth, async (req, res) => {
  try {
    const userId = res.locals.userId as string;
    const { workflowId } = req.params;
    await execute(
      `DELETE FROM hidden_workflows
       WHERE user_id = :userId AND workflow_id = :workflowId`,
      [
        { name: "userId", value: { stringValue: userId } },
        { name: "workflowId", value: { stringValue: workflowId } },
      ],
    );
    res.status(204).send();
  } catch (err) {
    console.error("[workflows] DELETE /hidden/:workflowId error:", err);
    res.status(500).json({ detail: "Internal server error" });
  }
});

// GET /workflows/:workflowId
workflowsRouter.get("/:workflowId", requireAuth, async (req, res) => {
  try {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { workflowId } = req.params;
    const access = await resolveWorkflowAccess(workflowId, userId, userEmail);
    if (!access)
      return void res.status(404).json({ detail: "Workflow not found" });
    res.json(
      withWorkflowAccess(access.workflow, {
        allowEdit: access.allowEdit,
        isOwner: access.isOwner,
      }),
    );
  } catch (err) {
    console.error("[workflows] GET /:workflowId error:", err);
    res.status(500).json({ detail: "Internal server error" });
  }
});

// GET /workflows/:workflowId/shares
workflowsRouter.get("/:workflowId/shares", requireAuth, async (req, res) => {
  try {
    const userId = res.locals.userId as string;
    const { workflowId } = req.params;

    const wf = await queryOne<{ id: string }>(
      `SELECT id FROM workflows
       WHERE id = :id AND user_id = :userId AND is_system = false`,
      [
        { name: "id", value: { stringValue: workflowId } },
        { name: "userId", value: { stringValue: userId } },
      ],
    );
    if (!wf) return void res.status(404).json({ detail: "Workflow not found or not editable" });

    const shares = await query(
      `SELECT id, shared_with_email, allow_edit, created_at
       FROM workflow_shares
       WHERE workflow_id = :workflowId
       ORDER BY created_at ASC`,
      [{ name: "workflowId", value: { stringValue: workflowId } }],
    );

    res.json(shares);
  } catch (err) {
    console.error("[workflows] GET /:workflowId/shares error:", err);
    res.status(500).json({ detail: "Internal server error" });
  }
});

// DELETE /workflows/:workflowId/shares/:shareId
workflowsRouter.delete("/:workflowId/shares/:shareId", requireAuth, async (req, res) => {
  try {
    const userId = res.locals.userId as string;
    const { workflowId, shareId } = req.params;

    const wf = await queryOne<{ id: string }>(
      `SELECT id FROM workflows WHERE id = :id AND user_id = :userId`,
      [
        { name: "id", value: { stringValue: workflowId } },
        { name: "userId", value: { stringValue: userId } },
      ],
    );
    if (!wf) return void res.status(404).json({ detail: "Workflow not found" });

    await execute(
      `DELETE FROM workflow_shares
       WHERE id = :shareId AND workflow_id = :workflowId`,
      [
        { name: "shareId", value: { stringValue: shareId } },
        { name: "workflowId", value: { stringValue: workflowId } },
      ],
    );
    res.status(204).send();
  } catch (err) {
    console.error("[workflows] DELETE /:workflowId/shares/:shareId error:", err);
    res.status(500).json({ detail: "Internal server error" });
  }
});

// POST /workflows/:workflowId/share
workflowsRouter.post("/:workflowId/share", requireAuth, async (req, res) => {
  try {
    const userId = res.locals.userId as string;
    const { workflowId } = req.params;
    const { emails, allow_edit } = req.body as { emails: string[]; allow_edit: boolean };

    if (!emails?.length) return void res.status(400).json({ detail: "emails is required" });

    // Verify ownership
    const wf = await queryOne<{ id: string }>(
      `SELECT id FROM workflows
       WHERE id = :id AND user_id = :userId AND is_system = false`,
      [
        { name: "id", value: { stringValue: workflowId } },
        { name: "userId", value: { stringValue: userId } },
      ],
    );
    if (!wf) return void res.status(404).json({ detail: "Workflow not found or not editable" });

    // Upsert on (workflow_id, shared_with_email) so re-sharing to the same
    // person updates the existing row instead of stacking duplicates.
    for (const rawEmail of emails) {
      if (typeof rawEmail !== "string") continue;
      const email = rawEmail.trim().toLowerCase();
      if (!email) continue;
      await execute(
        `INSERT INTO workflow_shares
           (workflow_id, shared_by_user_id, shared_with_email, allow_edit)
         VALUES (:workflowId, :sharedBy, :email, :allowEdit)
         ON CONFLICT (workflow_id, shared_with_email)
         DO UPDATE SET allow_edit = EXCLUDED.allow_edit`,
        [
          { name: "workflowId", value: { stringValue: workflowId } },
          { name: "sharedBy", value: { stringValue: userId } },
          { name: "email", value: { stringValue: email } },
          { name: "allowEdit", value: { booleanValue: allow_edit ?? false } },
        ],
      );
    }

    res.status(204).send();
  } catch (err) {
    console.error("[workflows] POST /:workflowId/share error:", err);
    res.status(500).json({ detail: "Internal server error" });
  }
});
