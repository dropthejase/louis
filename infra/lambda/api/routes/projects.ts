/**
 * Project routes — CRUD for projects, project documents, folders, and
 * the shared-document pipeline.
 *
 * Projects are the primary grouping mechanism; documents and chats can
 * belong to a project. Access is either by ownership (user_id) or by email
 * in shared_with.
 */
import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { query, queryOne, execute } from "../lib/db";
import {
  attachActiveVersionPaths,
  attachLatestVersionNumbers,
} from "../lib/documentVersions";
import { downloadFile, uploadFile, storageKey, getPutSignedUrl } from "../lib/storage";
import { convertedPdfKey } from "../lib/convert";
import { checkProjectAccess } from "../lib/access";

export const projectsRouter = Router();
const ALLOWED_TYPES = new Set(["pdf", "docx", "doc"]);

interface ProjectRow {
  id: string;
  user_id: string;
  name: string;
  cm_number: string | null;
  visibility: string;
  shared_with: string[] | null;
  created_at: string;
  updated_at: string;
}

interface DocumentRow {
  id: string;
  project_id: string | null;
  user_id: string;
  filename: string;
  file_type: string | null;
  size_bytes: number;
  page_count: number | null;
  structure_tree: unknown;
  status: string;
  folder_id: string | null;
  current_version_id: string | null;
  created_at: string;
  updated_at: string;
  [k: string]: unknown;
}

interface FolderRow {
  id: string;
  project_id: string;
  user_id: string;
  name: string;
  parent_folder_id: string | null;
  created_at: string;
  updated_at: string;
}

// GET /projects
projectsRouter.get("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;

  const ownProjects = await query<ProjectRow>(
    `SELECT * FROM projects WHERE user_id = :userId ORDER BY created_at DESC`,
    [{ name: "userId", value: { stringValue: userId } }],
  );

  const sharedProjects = userEmail
    ? await query<ProjectRow>(
        `SELECT * FROM projects
         WHERE shared_with @> :email::jsonb
           AND user_id != :userId
         ORDER BY created_at DESC`,
        [
          { name: "email", value: { stringValue: JSON.stringify([userEmail]) } },
          { name: "userId", value: { stringValue: userId } },
        ],
      )
    : [];

  const projects = [...ownProjects, ...sharedProjects].sort(
    (a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  const result = await Promise.all(
    projects.map(async (p) => {
      const [docs, chats, reviews] = await Promise.all([
        queryOne<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM documents WHERE project_id = :projectId`,
          [{ name: "projectId", value: { stringValue: p.id } }],
        ),
        queryOne<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM chats WHERE project_id = :projectId`,
          [{ name: "projectId", value: { stringValue: p.id } }],
        ),
        queryOne<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM tabular_reviews WHERE project_id = :projectId`,
          [{ name: "projectId", value: { stringValue: p.id } }],
        ),
      ]);
      return {
        ...p,
        is_owner: p.user_id === userId,
        document_count: docs?.count ?? 0,
        chat_count: chats?.count ?? 0,
        review_count: reviews?.count ?? 0,
      };
    }),
  );
  res.json(result);
});

// POST /projects
projectsRouter.post("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { name, cm_number, shared_with } = req.body as {
    name: string;
    cm_number?: string;
    shared_with?: string[];
  };
  if (!name?.trim())
    return void res.status(400).json({ detail: "name is required" });

  const data = await queryOne<ProjectRow>(
    `INSERT INTO projects (user_id, name, cm_number, shared_with)
     VALUES (:userId, :name, :cmNumber, :sharedWith::jsonb)
     RETURNING *`,
    [
      { name: "userId", value: { stringValue: userId } },
      { name: "name", value: { stringValue: name.trim() } },
      {
        name: "cmNumber",
        value: cm_number != null ? { stringValue: cm_number } : { isNull: true },
      },
      {
        name: "sharedWith",
        value: {
          stringValue: JSON.stringify(
            (shared_with ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean),
          ),
        },
      },
    ],
  );
  if (!data)
    return void res.status(500).json({ detail: "Failed to create project" });
  res.status(201).json({ ...data, documents: [] });
});

// GET /projects/:projectId
projectsRouter.get("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;

  const project = await queryOne<ProjectRow>(
    `SELECT * FROM projects WHERE id = :projectId`,
    [{ name: "projectId", value: { stringValue: projectId } }],
  );
  if (!project)
    return void res.status(404).json({ detail: "Project not found" });

  const canAccess =
    project.user_id === userId ||
    (userEmail &&
      Array.isArray(project.shared_with) &&
      project.shared_with.includes(userEmail));
  if (!canAccess)
    return void res.status(404).json({ detail: "Project not found" });

  const [docs, folderData] = await Promise.all([
    query<DocumentRow>(
      `SELECT * FROM documents WHERE project_id = :projectId ORDER BY created_at ASC`,
      [{ name: "projectId", value: { stringValue: projectId } }],
    ),
    query<FolderRow>(
      `SELECT * FROM project_subfolders WHERE project_id = :projectId ORDER BY created_at ASC`,
      [{ name: "projectId", value: { stringValue: projectId } }],
    ),
  ]);
  await attachLatestVersionNumbers(docs);
  await attachActiveVersionPaths(docs);
  res.json({
    ...project,
    is_owner: project.user_id === userId,
    documents: docs,
    folders: folderData,
  });
});

// GET /projects/:projectId/people
// Resolve the owner + every shared member to {email, display_name}. Used
// by the People modal so the UI can show display names where available
// and tag the current user as "You".
//
// With Cognito as the IdP, we don't have a cheap "list all auth users" call.
// Owners come from user_profiles (display_name available); shared members
// are addressed by email only and return display_name: null.
projectsRouter.get("/:projectId/people", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;

  const project = await queryOne<{
    id: string;
    user_id: string;
    shared_with: string[] | null;
  }>(
    `SELECT id, user_id, shared_with FROM projects WHERE id = :projectId`,
    [{ name: "projectId", value: { stringValue: projectId } }],
  );
  if (!project)
    return void res.status(404).json({ detail: "Project not found" });

  const isOwner = project.user_id === userId;
  const sharedWith = (Array.isArray(project.shared_with)
    ? project.shared_with
    : []
  ).map((e) => e.toLowerCase());
  const isShared =
    !!userEmail && sharedWith.includes(userEmail.toLowerCase());
  if (!isOwner && !isShared)
    return void res.status(404).json({ detail: "Project not found" });

  const ownerProfile = await queryOne<{
    email: string | null;
    display_name: string | null;
  }>(
    `SELECT email, display_name FROM user_profiles WHERE user_id = :userId`,
    [{ name: "userId", value: { stringValue: project.user_id } }],
  );

  const owner = {
    user_id: project.user_id,
    email: isOwner ? (userEmail ?? null) : (ownerProfile?.email ?? null),
    display_name: ownerProfile?.display_name ?? null,
  };

  // Lookup display_names for shared members by email
  let memberProfiles: { email: string | null; display_name: string | null }[] = [];
  if (sharedWith.length > 0) {
    const placeholders = sharedWith.map((_, i) => `:e${i}`).join(", ");
    const params = sharedWith.map((e, i) => ({ name: `e${i}`, value: { stringValue: e } }));
    memberProfiles = await query<{ email: string | null; display_name: string | null }>(
      `SELECT email, display_name FROM user_profiles WHERE email IN (${placeholders})`,
      params,
    );
  }

  const members = sharedWith.map((email) => {
    const profile = memberProfiles.find((p) => p.email?.toLowerCase() === email.toLowerCase());
    return { email, display_name: profile?.display_name ?? null };
  });

  res.json({ owner, members });
});

// PATCH /projects/:projectId
projectsRouter.patch("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { projectId } = req.params;

  const sets: string[] = [];
  const params: import("@aws-sdk/client-rds-data").SqlParameter[] = [
    { name: "projectId", value: { stringValue: projectId } },
    { name: "userId", value: { stringValue: userId } },
  ];

  if (req.body.name != null) {
    sets.push(`name = :name`);
    params.push({ name: "name", value: { stringValue: String(req.body.name) } });
  }
  if (req.body.cm_number != null) {
    sets.push(`cm_number = :cmNumber`);
    params.push({
      name: "cmNumber",
      value: { stringValue: String(req.body.cm_number) },
    });
  }
  if (Array.isArray(req.body.shared_with)) {
    // Normalise: lowercase + dedupe + drop empties.
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const raw of req.body.shared_with) {
      if (typeof raw !== "string") continue;
      const e = raw.trim().toLowerCase();
      if (!e || seen.has(e)) continue;
      seen.add(e);
      cleaned.push(e);
    }
    sets.push(`shared_with = :sharedWith::jsonb`);
    params.push({
      name: "sharedWith",
      value: { stringValue: JSON.stringify(cleaned) },
    });
  }
  sets.push(`updated_at = NOW()`);

  const data = await queryOne<ProjectRow>(
    `UPDATE projects SET ${sets.join(", ")}
     WHERE id = :projectId AND user_id = :userId
     RETURNING *`,
    params,
  );
  if (!data)
    return void res.status(404).json({ detail: "Project not found" });

  const [docs, folderData] = await Promise.all([
    query<DocumentRow>(
      `SELECT * FROM documents WHERE project_id = :projectId ORDER BY created_at ASC`,
      [{ name: "projectId", value: { stringValue: projectId } }],
    ),
    query<FolderRow>(
      `SELECT * FROM project_subfolders WHERE project_id = :projectId ORDER BY created_at ASC`,
      [{ name: "projectId", value: { stringValue: projectId } }],
    ),
  ]);
  await attachActiveVersionPaths(docs);
  res.json({ ...data, documents: docs, folders: folderData });
});

// DELETE /projects/:projectId
projectsRouter.delete("/:projectId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { projectId } = req.params;
  await execute(
    `DELETE FROM projects WHERE id = :projectId AND user_id = :userId`,
    [
      { name: "projectId", value: { stringValue: projectId } },
      { name: "userId", value: { stringValue: userId } },
    ],
  );
  res.status(204).send();
});

// GET /projects/:projectId/documents
projectsRouter.get("/:projectId/documents", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;

  const access = await checkProjectAccess(projectId, userId, userEmail);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  const docs = await query<DocumentRow>(
    `SELECT * FROM documents WHERE project_id = :projectId ORDER BY created_at ASC`,
    [{ name: "projectId", value: { stringValue: projectId } }],
  );
  await attachActiveVersionPaths(docs);
  res.json(docs);
});

// POST /projects/:projectId/documents/:documentId — assign or copy existing doc into project
projectsRouter.post(
  "/:projectId/documents/:documentId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId, documentId } = req.params;

    const access = await checkProjectAccess(projectId, userId, userEmail);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    // Adding-by-id pulls a doc into the project — only the doc's owner
    // is allowed to do that, so other people's standalone docs can't be
    // siphoned into a project the requester happens to share.
    const doc = await queryOne<DocumentRow>(
      `SELECT * FROM documents WHERE id = :id AND user_id = :userId`,
      [
        { name: "id", value: { stringValue: documentId } },
        { name: "userId", value: { stringValue: userId } },
      ],
    );
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });

    // Already in this project — idempotent
    if (doc.project_id === projectId) return void res.json(doc);

    if (doc.project_id === null) {
      // Standalone → assign project_id
      const updated = await queryOne<DocumentRow>(
        `UPDATE documents SET project_id = :projectId, updated_at = NOW()
         WHERE id = :id RETURNING *`,
        [
          { name: "projectId", value: { stringValue: projectId } },
          { name: "id", value: { stringValue: documentId } },
        ],
      );
      if (!updated)
        return void res.status(500).json({ detail: "Failed to update document" });
      return void res.json(updated);
    } else {
      // Belongs to another project → duplicate record AND copy the
      // underlying storage objects so each project's copy is fully
      // independent (edits/version bumps on one don't leak into the
      // other).
      const copy = await queryOne<DocumentRow>(
        `INSERT INTO documents
           (project_id, user_id, filename, file_type, size_bytes, page_count, structure_tree, status)
         VALUES
           (:projectId::uuid, :userId, :filename, :fileType, :sizeBytes, :pageCount, :structureTree::jsonb, :status)
         RETURNING *`,
        [
          { name: "projectId", value: { stringValue: projectId } },
          { name: "userId", value: { stringValue: userId } },
          { name: "filename", value: { stringValue: doc.filename } },
          {
            name: "fileType",
            value: doc.file_type != null ? { stringValue: doc.file_type } : { isNull: true },
          },
          { name: "sizeBytes", value: { longValue: doc.size_bytes } },
          {
            name: "pageCount",
            value: doc.page_count != null ? { longValue: doc.page_count } : { isNull: true },
          },
          {
            name: "structureTree",
            value:
              doc.structure_tree != null
                ? { stringValue: JSON.stringify(doc.structure_tree) }
                : { isNull: true },
          },
          { name: "status", value: { stringValue: doc.status } },
        ],
      );
      if (!copy)
        return void res.status(500).json({ detail: "Failed to copy document" });

      let copyVersionRowId: string | null = null;
      if (doc.current_version_id) {
        const srcV = await queryOne<{
          storage_path: string;
          pdf_storage_path: string | null;
          version_number: number | null;
          display_name: string | null;
          source: string | null;
        }>(
          `SELECT storage_path, pdf_storage_path, version_number, display_name, source
           FROM document_versions WHERE id = :versionId`,
          [{ name: "versionId", value: { stringValue: doc.current_version_id } }],
        );
        if (srcV?.storage_path) {
          const srcBytes = await downloadFile(srcV.storage_path);
          if (!srcBytes) {
            return void res
              .status(500)
              .json({ detail: "Failed to read source document bytes" });
          }
          const newKey = storageKey(userId, copy.id, doc.filename);
          const contentType =
            doc.file_type === "pdf"
              ? "application/pdf"
              : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
          await uploadFile(newKey, srcBytes, contentType);

          // PDFs share one object for source + display rendition. DOCX
          // store the converted PDF at a separate `converted-pdfs/` key —
          // copy that too if it exists so the copy renders without going
          // back through libreoffice.
          let newPdfPath: string | null = null;
          if (srcV.pdf_storage_path) {
            if (srcV.pdf_storage_path === srcV.storage_path) {
              newPdfPath = newKey;
            } else {
              const pdfBytes = await downloadFile(srcV.pdf_storage_path);
              if (pdfBytes) {
                const newPdfKey = convertedPdfKey(userId, copy.id);
                await uploadFile(newPdfKey, pdfBytes, "application/pdf");
                newPdfPath = newPdfKey;
              }
            }
          }

          const newV = await queryOne<{ id: string }>(
            `INSERT INTO document_versions
               (document_id, storage_path, pdf_storage_path, source, version_number, display_name)
             VALUES
               (:documentId, :storagePath, :pdfStoragePath, :source, :versionNumber, :displayName)
             RETURNING id`,
            [
              { name: "documentId", value: { stringValue: copy.id } },
              { name: "storagePath", value: { stringValue: newKey } },
              {
                name: "pdfStoragePath",
                value: newPdfPath != null ? { stringValue: newPdfPath } : { isNull: true },
              },
              { name: "source", value: { stringValue: srcV.source ?? "upload" } },
              { name: "versionNumber", value: { longValue: srcV.version_number ?? 1 } },
              {
                name: "displayName",
                value: { stringValue: srcV.display_name ?? doc.filename },
              },
            ],
          );
          copyVersionRowId = newV?.id ?? null;
          if (copyVersionRowId) {
            await execute(
              `UPDATE documents SET current_version_id = :versionId WHERE id = :id`,
              [
                { name: "versionId", value: { stringValue: copyVersionRowId } },
                { name: "id", value: { stringValue: copy.id } },
              ],
            );
          }
        }
      }
      return void res.status(201).json(copy);
    }
  },
);

// POST /projects/:projectId/documents/prepare
projectsRouter.post("/:projectId/documents/prepare", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const { filename, size_bytes } = req.body as { filename?: string; size_bytes?: number };

  const access = await checkProjectAccess(projectId, userId, userEmail);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  if (!filename?.trim())
    return void res.status(400).json({ detail: "filename is required" });

  const suffix = filename.includes(".")
    ? filename.split(".").pop()!.toLowerCase()
    : "";
  if (!ALLOWED_TYPES.has(suffix))
    return void res.status(400).json({
      detail: `Unsupported file type: ${suffix}. Allowed: pdf, docx, doc`,
    });

  const doc = await queryOne<{ id: string; filename: string }>(
    `INSERT INTO documents (project_id, user_id, filename, file_type, size_bytes, status)
     VALUES (:projectId::uuid, :userId, :filename, :fileType, :sizeBytes, 'processing')
     RETURNING id, filename`,
    [
      { name: "projectId", value: { stringValue: projectId } },
      { name: "userId", value: { stringValue: userId } },
      { name: "filename", value: { stringValue: filename.trim() } },
      { name: "fileType", value: { stringValue: suffix } },
      { name: "sizeBytes", value: { longValue: size_bytes ?? 0 } },
    ],
  );
  if (!doc)
    return void res.status(500).json({ detail: "Failed to create document record" });

  const uploadKey = storageKey(userId, doc.id, filename.trim());
  const uploadUrl = await getPutSignedUrl(uploadKey, suffix === "pdf" ? "application/pdf" : "application/octet-stream");
  res.status(201).json({ docId: doc.id, uploadKey, uploadUrl });
});

// POST /projects/:projectId/documents/:documentId/register
projectsRouter.post("/:projectId/documents/:documentId/register", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId, documentId } = req.params;
  const { upload_key } = req.body as { upload_key?: string };

  if (!upload_key?.trim())
    return void res.status(400).json({ detail: "upload_key is required" });

  const access = await checkProjectAccess(projectId, userId, userEmail);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  const doc = await queryOne<{
    id: string;
    filename: string;
    file_type: string | null;
    size_bytes: number;
    status: string;
  }>(
    `SELECT id, filename, file_type, size_bytes, status
     FROM documents
     WHERE id = :id AND user_id = :userId AND project_id = :projectId`,
    [
      { name: "id", value: { stringValue: documentId } },
      { name: "userId", value: { stringValue: userId } },
      { name: "projectId", value: { stringValue: projectId } },
    ],
  );
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });
  if (doc.status !== "processing")
    return void res.status(409).json({ detail: "Document already registered" });

  const suffix = doc.file_type ?? "";
  // PDF is its own rendition. DOCX/DOC: Conversion Lambda sets pdf_storage_path via EventBridge.
  const pdfStoragePath = suffix === "pdf" ? upload_key.trim() : null;

  const versionRow = await queryOne<{ id: string }>(
    `INSERT INTO document_versions
       (document_id, storage_path, pdf_storage_path, source, version_number, display_name)
     VALUES
       (:documentId, :storagePath, :pdfStoragePath, 'upload', 1, :displayName)
     RETURNING id`,
    [
      { name: "documentId", value: { stringValue: documentId } },
      { name: "storagePath", value: { stringValue: upload_key.trim() } },
      {
        name: "pdfStoragePath",
        value: pdfStoragePath != null
          ? { stringValue: pdfStoragePath }
          : { isNull: true },
      },
      { name: "displayName", value: { stringValue: doc.filename } },
    ],
  );
  if (!versionRow)
    return void res.status(500).json({ detail: "Failed to create version record" });

  await execute(
    `UPDATE documents
     SET current_version_id = :versionId, status = 'ready', updated_at = NOW()
     WHERE id = :id`,
    [
      { name: "versionId", value: { stringValue: versionRow.id } },
      { name: "id", value: { stringValue: documentId } },
    ],
  );

  const updated = await queryOne<DocumentRow>(
    `SELECT * FROM documents WHERE id = :id`,
    [{ name: "id", value: { stringValue: documentId } }],
  );
  res.status(201).json({
    ...updated,
    storage_path: upload_key.trim(),
    pdf_storage_path: pdfStoragePath,
  });
});

// GET /projects/:projectId/chats — every assistant chat under this project
// (any author with project access). Used by the project page's chat tab so
// it doesn't have to filter the global GET /chat list — and so collaborators
// see each other's chats inside the project even though those don't appear
// in the global list.
projectsRouter.get("/:projectId/chats", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;

  const access = await checkProjectAccess(projectId, userId, userEmail);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  const chats = await query(
    `SELECT * FROM chats WHERE project_id = :projectId ORDER BY created_at DESC`,
    [{ name: "projectId", value: { stringValue: projectId } }],
  );
  res.json(chats);
});

// ── Folder routes ─────────────────────────────────────────────────────────────

// POST /projects/:projectId/folders
projectsRouter.post("/:projectId/folders", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { projectId } = req.params;
  const { name, parent_folder_id } = req.body as {
    name: string;
    parent_folder_id?: string | null;
  };
  if (!name?.trim())
    return void res.status(400).json({ detail: "name is required" });

  const access = await checkProjectAccess(projectId, userId, userEmail);
  if (!access.ok)
    return void res.status(404).json({ detail: "Project not found" });

  // Verify parent folder belongs to this project
  if (parent_folder_id) {
    const parent = await queryOne<{ id: string }>(
      `SELECT id FROM project_subfolders
       WHERE id = :id AND project_id = :projectId`,
      [
        { name: "id", value: { stringValue: parent_folder_id } },
        { name: "projectId", value: { stringValue: projectId } },
      ],
    );
    if (!parent)
      return void res.status(404).json({ detail: "Parent folder not found" });
  }

  const data = await queryOne<FolderRow>(
    `INSERT INTO project_subfolders (project_id, user_id, name, parent_folder_id)
     VALUES (:projectId::uuid, :userId, :name, :parentFolderId)
     RETURNING *`,
    [
      { name: "projectId", value: { stringValue: projectId } },
      { name: "userId", value: { stringValue: userId } },
      { name: "name", value: { stringValue: name.trim() } },
      {
        name: "parentFolderId",
        value: parent_folder_id != null
          ? { stringValue: parent_folder_id }
          : { isNull: true },
      },
    ],
  );
  if (!data)
    return void res.status(500).json({ detail: "Failed to create folder" });
  res.status(201).json(data);
});

// PATCH /projects/:projectId/folders/:folderId
projectsRouter.patch(
  "/:projectId/folders/:folderId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId, folderId } = req.params;
    const body = req.body as {
      name?: string;
      parent_folder_id?: string | null;
    };

    const access = await checkProjectAccess(projectId, userId, userEmail);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    const sets: string[] = [`updated_at = NOW()`];
    const params: import("@aws-sdk/client-rds-data").SqlParameter[] = [
      { name: "folderId", value: { stringValue: folderId } },
      { name: "projectId", value: { stringValue: projectId } },
    ];

    if (body.name != null) {
      sets.push(`name = :name`);
      params.push({ name: "name", value: { stringValue: body.name.trim() } });
    }
    if ("parent_folder_id" in body) {
      // Cycle check: walk up the tree from the proposed parent to ensure
      // folderId is not an ancestor.
      if (body.parent_folder_id) {
        let cur: string | null = body.parent_folder_id;
        while (cur) {
          if (cur === folderId)
            return void res.status(400).json({
              detail: "Cannot move a folder into itself or a descendant",
            });
          const parentRow: { parent_folder_id: string | null } | null =
            await queryOne<{ parent_folder_id: string | null }>(
              `SELECT parent_folder_id FROM project_subfolders WHERE id = :id`,
              [{ name: "id", value: { stringValue: cur } }],
            );
          cur = parentRow?.parent_folder_id ?? null;
        }
      }
      sets.push(`parent_folder_id = :parentFolderId`);
      params.push({
        name: "parentFolderId",
        value: body.parent_folder_id != null
          ? { stringValue: body.parent_folder_id }
          : { isNull: true },
      });
    }

    const data = await queryOne<FolderRow>(
      `UPDATE project_subfolders SET ${sets.join(", ")}
       WHERE id = :folderId AND project_id = :projectId
       RETURNING *`,
      params,
    );
    if (!data)
      return void res.status(404).json({ detail: "Folder not found" });
    res.json(data);
  },
);

// DELETE /projects/:projectId/folders/:folderId
projectsRouter.delete(
  "/:projectId/folders/:folderId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId, folderId } = req.params;

    const access = await checkProjectAccess(projectId, userId, userEmail);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    // Move direct documents to root before cascade-deleting subfolders
    await execute(
      `UPDATE documents SET folder_id = NULL WHERE folder_id = :folderId`,
      [{ name: "folderId", value: { stringValue: folderId } }],
    );

    await execute(
      `DELETE FROM project_subfolders
       WHERE id = :folderId AND project_id = :projectId`,
      [
        { name: "folderId", value: { stringValue: folderId } },
        { name: "projectId", value: { stringValue: projectId } },
      ],
    );
    res.status(204).send();
  },
);

// PATCH /projects/:projectId/documents/:documentId/folder — move doc to a folder
projectsRouter.patch(
  "/:projectId/documents/:documentId/folder",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId, documentId } = req.params;
    const { folder_id } = req.body as { folder_id: string | null };

    const access = await checkProjectAccess(projectId, userId, userEmail);
    if (!access.ok)
      return void res.status(404).json({ detail: "Project not found" });

    const data = await queryOne<DocumentRow>(
      `UPDATE documents SET folder_id = :folderId, updated_at = NOW()
       WHERE id = :documentId AND project_id = :projectId
       RETURNING *`,
      [
        {
          name: "folderId",
          value: folder_id != null ? { stringValue: folder_id } : { isNull: true },
        },
        { name: "documentId", value: { stringValue: documentId } },
        { name: "projectId", value: { stringValue: projectId } },
      ],
    );
    if (!data)
      return void res.status(404).json({ detail: "Document not found" });
    res.json(data);
  },
);

