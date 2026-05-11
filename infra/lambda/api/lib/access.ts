/**
 * Ownership and sharing access-control helpers used by all route handlers.
 *
 * Access is derived from two sources: direct ownership (user_id column) and
 * project membership (shared_with JSONB array stores lowercase email addresses).
 * Every DB query in this module includes an ownership guard so callers never
 * need to add their own WHERE user_id = :userId checks on top.
 */
import { query, queryOne } from "./db";

export type ProjectAccess =
  | {
      ok: true;
      isOwner: boolean;
      project: { id: string; user_id: string; shared_with: string[] | null };
    }
  | { ok: false };

/**
 * Determine whether a user can access a project.
 *
 * @returns `{ ok: true, isOwner: true }` if userId owns the project.
 * @returns `{ ok: true, isOwner: false }` if userEmail appears in shared_with.
 * @returns `{ ok: false }` if neither condition holds or the project doesn't exist.
 */
export async function checkProjectAccess(
  projectId: string,
  userId: string,
  userEmail: string | null | undefined,
): Promise<ProjectAccess> {
  const project = await queryOne<{
    id: string;
    user_id: string;
    shared_with: string[] | null;
  }>(
    `SELECT id, user_id, shared_with FROM projects WHERE id = :projectId`,
    [{ name: "projectId", value: { stringValue: projectId } }],
  );
  if (!project) return { ok: false };
  if (project.user_id === userId) return { ok: true, isOwner: true, project };
  const sharedWith = Array.isArray(project.shared_with) ? project.shared_with : [];
  const email = (userEmail ?? "").toLowerCase();
  if (email && sharedWith.some((e) => (e ?? "").toLowerCase() === email)) {
    return { ok: true, isOwner: false, project };
  }
  return { ok: false };
}

/**
 * Verify that a user can access a document: either they own it directly,
 * or the document belongs to a project they have access to.
 *
 * @param doc Minimal document row with user_id and project_id.
 */
export async function ensureDocAccess(
  doc: { user_id: string; project_id: string | null },
  userId: string,
  userEmail: string | null | undefined,
): Promise<{ ok: true; isOwner: boolean } | { ok: false }> {
  if (doc.user_id === userId) return { ok: true, isOwner: true };
  if (!doc.project_id) return { ok: false };
  const access = await checkProjectAccess(doc.project_id, userId, userEmail);
  if (access.ok) return { ok: true, isOwner: false };
  return { ok: false };
}

/**
 * Verify that a user can access a tabular review: either they own it,
 * their email is in the review's own shared_with list, or the review
 * belongs to a project they have access to.
 *
 * @param review Minimal review row with user_id, project_id, and optional shared_with.
 */
export async function ensureReviewAccess(
  review: {
    user_id: string;
    project_id: string | null;
    shared_with?: string[] | null;
  },
  userId: string,
  userEmail: string | null | undefined,
): Promise<{ ok: true; isOwner: boolean } | { ok: false }> {
  if (review.user_id === userId) return { ok: true, isOwner: true };
  const email = (userEmail ?? "").toLowerCase();
  if (email && Array.isArray(review.shared_with)) {
    if (review.shared_with.some((e) => (e ?? "").toLowerCase() === email)) {
      return { ok: true, isOwner: false };
    }
  }
  if (!review.project_id) return { ok: false };
  const access = await checkProjectAccess(review.project_id, userId, userEmail);
  if (access.ok) return { ok: true, isOwner: false };
  return { ok: false };
}

/**
 * Return all project IDs a user can see: their own projects plus every project
 * where their email appears in shared_with.
 */
export async function listAccessibleProjectIds(
  userId: string,
  userEmail: string | null | undefined,
): Promise<string[]> {
  const ownRows = await query<{ id: string }>(
    `SELECT id FROM projects WHERE user_id = :userId`,
    [{ name: "userId", value: { stringValue: userId } }],
  );
  const ids = new Set<string>(ownRows.map((r) => r.id));

  if (userEmail) {
    const sharedRows = await query<{ id: string }>(
      `SELECT id FROM projects
       WHERE user_id != :userId
         AND shared_with @> :email::jsonb`,
      [
        { name: "userId", value: { stringValue: userId } },
        { name: "email", value: { stringValue: JSON.stringify([userEmail]) } },
      ],
    );
    for (const r of sharedRows) ids.add(r.id);
  }
  return [...ids];
}
