/**
 * Standalone-document routes — upload, display, version management, and
 * tracked-change accept/reject for documents not attached to a project.
 *
 * Documents without a project_id are "standalone" documents owned directly
 * by a user. Storage paths live on document_versions rows; this router always
 * goes through loadActiveVersion to resolve the right bytes. Accept/reject
 * mutates the existing version's bytes in place rather than creating a new
 * version row, keeping the versions table lean.
 */
import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { query, queryOne, execute } from "../lib/db";
import {
  buildContentDisposition,
  downloadFile,
  deleteFile,
  getSignedUrl,
  getPutSignedUrl,
  versionStorageKey,
  uploadFile,
  storageKey,
} from "../lib/storage";
import {
  extractTrackedChangeIds,
  resolveTrackedChange,
} from "../lib/docxTrackedChanges";
import {
  attachActiveVersionPaths,
  attachLatestVersionNumbers,
  loadActiveVersion,
} from "../lib/documentVersions";
import { ensureDocAccess } from "../lib/access";
import { singleFileUpload } from "../lib/upload";

export const documentsRouter = Router();

const ALLOWED_TYPES = new Set(["pdf", "docx", "doc"]);

// Build a permalink to /download for a stored object. Frontend hits this
// route to fetch bytes; query params encode the storage path + display name.
function buildDownloadUrl(storagePath: string, filename: string): string {
  const path = encodeURIComponent(storagePath);
  const name = encodeURIComponent(filename);
  return `/download?path=${path}&filename=${name}`;
}

interface DocumentRow {
  id: string;
  project_id: string | null;
  user_id: string;
  filename: string;
  file_type: string | null;
  current_version_id: string | null;
  size_bytes: number;
  page_count: number | null;
  status: string;
  [k: string]: unknown;
}

// POST /single-documents/prepare
documentsRouter.post("/prepare", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { filename, size_bytes } = req.body as { filename?: string; size_bytes?: number };

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
    `INSERT INTO documents (user_id, filename, file_type, size_bytes, status)
     VALUES (:userId, :filename, :fileType, :sizeBytes, 'processing')
     RETURNING id, filename`,
    [
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

// POST /single-documents/:documentId/register
documentsRouter.post("/:documentId/register", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { documentId } = req.params;
  const { upload_key } = req.body as { upload_key?: string };

  if (!upload_key?.trim())
    return void res.status(400).json({ detail: "upload_key is required" });

  const doc = await queryOne<{
    id: string;
    filename: string;
    file_type: string | null;
    size_bytes: number;
    status: string;
  }>(
    `SELECT id, filename, file_type, size_bytes, status
     FROM documents
     WHERE id = :id AND user_id = :userId AND project_id IS NULL`,
    [
      { name: "id", value: { stringValue: documentId } },
      { name: "userId", value: { stringValue: userId } },
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

// GET /single-documents
documentsRouter.get("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const docs = await query<DocumentRow>(
    `SELECT * FROM documents
     WHERE user_id = :userId AND project_id IS NULL
     ORDER BY created_at DESC`,
    [{ name: "userId", value: { stringValue: userId } }],
  );
  await attachLatestVersionNumbers(docs);
  await attachActiveVersionPaths(docs);
  res.json(docs);
});

// DELETE /single-documents/:documentId
documentsRouter.delete("/:documentId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const { documentId } = req.params;

  const doc = await queryOne<{ id: string }>(
    `SELECT id FROM documents WHERE id = :id AND user_id = :userId`,
    [
      { name: "id", value: { stringValue: documentId } },
      { name: "userId", value: { stringValue: userId } },
    ],
  );
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });

  // Storage now lives on document_versions — fan out and delete each
  // version's bytes (DOCX + PDF rendition) before dropping rows.
  const versions = await query<{
    storage_path: string | null;
    pdf_storage_path: string | null;
  }>(
    `SELECT storage_path, pdf_storage_path FROM document_versions
     WHERE document_id = :documentId`,
    [{ name: "documentId", value: { stringValue: documentId } }],
  );
  await Promise.all(
    versions.flatMap((v) =>
      [v.storage_path, v.pdf_storage_path]
        .filter((p): p is string => typeof p === "string" && p.length > 0)
        .map((p) => deleteFile(p).catch(() => {})),
    ),
  );
  await execute(
    `DELETE FROM documents WHERE id = :id`,
    [{ name: "id", value: { stringValue: documentId } }],
  );
  res.status(204).send();
});

// GET /single-documents/:documentId/display
// Returns a presigned S3 URL and file type so the frontend can choose the
// right viewer (PDF.js vs docx-preview) and fetch bytes directly from S3.
documentsRouter.get("/:documentId/display", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string;
  const { documentId } = req.params;
  const versionIdParam =
    typeof req.query.version_id === "string" ? req.query.version_id : null;

  const doc = await queryOne<{
    id: string;
    filename: string;
    file_type: string | null;
    user_id: string;
    project_id: string | null;
  }>(
    `SELECT id, filename, file_type, user_id, project_id
     FROM documents WHERE id = :id`,
    [{ name: "id", value: { stringValue: documentId } }],
  );
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, versionIdParam);
  if (!active)
    return void res.status(404).json({ detail: "No file available" });

  const fileType = doc.file_type ?? "";
  const isDocx = fileType === "docx" || fileType === "doc";
  const hasPdf = isDocx && !!active.pdf_storage_path;
  const servePath = hasPdf ? active.pdf_storage_path! : active.storage_path;

  const url = await getSignedUrl(servePath, 900, doc.filename);
  if (!url)
    return void res.status(503).json({ detail: "Storage not configured" });

  res.json({ url, type: hasPdf ? "pdf" : fileType, filename: doc.filename });
});

// POST /single-documents/download-zip
documentsRouter.post("/download-zip", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { document_ids } = req.body as { document_ids?: string[] };

  if (!Array.isArray(document_ids) || document_ids.length === 0)
    return void res.status(400).json({ detail: "document_ids is required" });

  const placeholders = document_ids.map((_, i) => `:id${i}::uuid`).join(", ");
  const rawDocs = await query<{
    id: string;
    filename: string;
    file_type: string | null;
    current_version_id: string | null;
    user_id: string;
    project_id: string | null;
  }>(
    `SELECT id, filename, file_type, current_version_id, user_id, project_id
     FROM documents WHERE id IN (${placeholders})`,
    document_ids.map((id, i) => ({
      name: `id${i}`,
      value: { stringValue: id },
    })),
  );

  // Filter to docs the user actually has access to (own + shared-project).
  const accessChecks = await Promise.all(
    rawDocs.map(async (d) => ({
      doc: d,
      access: await ensureDocAccess(
        { user_id: d.user_id, project_id: d.project_id },
        userId,
        userEmail,
      ),
    })),
  );
  const docs = accessChecks
    .filter((x) => x.access.ok)
    .map((x) => x.doc);
  if (docs.length === 0)
    return void res.status(404).json({ detail: "No documents found" });

  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();

  await Promise.all(
    docs.map(async (doc) => {
      const active = await loadActiveVersion(doc.id);
      if (!active) return;
      const raw = await downloadFile(active.storage_path);
      if (!raw) return;
      zip.file(doc.filename, Buffer.from(raw));
    }),
  );

  const content = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", 'attachment; filename="documents.zip"');
  res.send(content);
});

// GET /single-documents/:documentId/url
// Optional ?version_id= selects a specific tracked-changes version.
// Otherwise falls back to documents.current_version_id, else the original upload.
documentsRouter.get("/:documentId/url", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const versionIdParam = typeof req.query.version_id === "string" ? req.query.version_id : null;

  const doc = await queryOne<{
    id: string;
    filename: string;
    user_id: string;
    project_id: string | null;
  }>(
    `SELECT id, filename, user_id, project_id FROM documents WHERE id = :id`,
    [{ name: "id", value: { stringValue: documentId } }],
  );
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, versionIdParam);
  if (!active)
    return void res.status(404).json({ detail: "No file available" });

  const downloadFilename = resolveDownloadFilename(
    doc.filename,
    active.display_name,
    active.version_number,
  );
  const url = await getSignedUrl(
    active.storage_path,
    3600,
    downloadFilename,
  );
  if (!url)
    return void res.status(503).json({ detail: "Storage not configured" });

  res.json({
    url,
    document_id: documentId,
    filename: downloadFilename,
    version_id: active.id,
    // Lets the frontend decide between DocView (PDF.js) and DocxView
    // (docx-preview) without a follow-up round-trip.
    has_pdf_rendition: !!active.pdf_storage_path,
  });
});

// GET /single-documents/:documentId/docx
// Returns a presigned S3 URL for the raw .docx bytes, optionally at a
// specific tracked-changes version. Browser fetches directly from S3.
documentsRouter.get("/:documentId/docx", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;
  const versionIdParam = typeof req.query.version_id === "string" ? req.query.version_id : null;

  const doc = await queryOne<{
    id: string;
    filename: string;
    user_id: string;
    project_id: string | null;
  }>(
    `SELECT id, filename, user_id, project_id FROM documents WHERE id = :id`,
    [{ name: "id", value: { stringValue: documentId } }],
  );
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId, versionIdParam);
  if (!active)
    return void res.status(404).json({ detail: "No file available" });

  const downloadFilename = resolveDownloadFilename(
    doc.filename,
    active.display_name,
    active.version_number,
  );
  const url = await getSignedUrl(active.storage_path, 900, downloadFilename);
  if (!url)
    return void res.status(503).json({ detail: "Storage not configured" });

  res.json({ url, filename: downloadFilename, version_id: active.id });
});

// Compose a download-friendly filename that carries the edit version
// marker: "Purchase Agreement.docx" → "Purchase Agreement [Edited V2].docx".
// Preserves the original extension (fallback: .docx).
function versionedFilename(filename: string, version: number | null): string {
  if (!version || version < 1) return filename;
  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : ".docx";
  return `${stem} [Edited V${version}]${ext}`;
}

// Produce the filename a download should present to the user for a given
// (document, version) pair. Prefers the version's display_name (appending
// the original extension if the user didn't include one), falling back to
// the versionedFilename heuristic.
function resolveDownloadFilename(
  originalFilename: string,
  displayName: string | null | undefined,
  versionNumber: number | null,
): string {
  const dot = originalFilename.lastIndexOf(".");
  const origExt = dot > 0 ? originalFilename.slice(dot) : "";
  if (displayName && displayName.trim()) {
    const trimmed = displayName.trim();
    const trimmedDot = trimmed.lastIndexOf(".");
    const hasExt =
      trimmedDot > 0 &&
      trimmed
        .slice(trimmedDot)
        .toLowerCase()
        .match(/^\.[a-z0-9]{1,6}$/);
    if (hasExt) return trimmed;
    return origExt ? `${trimmed}${origExt}` : trimmed;
  }
  return versionedFilename(originalFilename, versionNumber);
}

// GET /single-documents/:documentId/versions
// Returns every version row for the document in document order, with
// the human-friendly version number when present.
documentsRouter.get("/:documentId/versions", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId } = req.params;

  const doc = await queryOne<{
    id: string;
    current_version_id: string | null;
    user_id: string;
    project_id: string | null;
  }>(
    `SELECT id, current_version_id, user_id, project_id
     FROM documents WHERE id = :id`,
    [{ name: "id", value: { stringValue: documentId } }],
  );
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const rows = await query(
    `SELECT id, version_number, source, created_at, display_name
     FROM document_versions
     WHERE document_id = :documentId
     ORDER BY created_at ASC`,
    [{ name: "documentId", value: { stringValue: documentId } }],
  );

  res.json({
    current_version_id: doc.current_version_id,
    versions: rows,
  });
});

// POST /single-documents/:documentId/versions
// Upload a brand-new version of an existing document. The uploaded file
// becomes the new current_version_id. display_name defaults to the
// uploaded filename; client may override via the `display_name` form field.
documentsRouter.post(
  "/:documentId/versions",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;

    const file = req.file;
    if (!file)
      return void res.status(400).json({ detail: "file is required" });

    const doc = await queryOne<{
      id: string;
      filename: string;
      file_type: string | null;
      user_id: string;
      project_id: string | null;
    }>(
      `SELECT id, filename, file_type, user_id, project_id
       FROM documents WHERE id = :id`,
      [{ name: "id", value: { stringValue: documentId } }],
    );
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail);
    if (!access.ok)
      return void res.status(404).json({ detail: "Document not found" });

    // Reject if the uploaded file's extension doesn't match the document's
    // declared type — otherwise every downstream viewer/extractor breaks.
    const suffix = file.originalname.includes(".")
      ? file.originalname.split(".").pop()!.toLowerCase()
      : "";
    if (doc.file_type && suffix && doc.file_type !== suffix) {
      return void res.status(400).json({
        detail: `Uploaded file type (${suffix}) does not match document type (${doc.file_type}).`,
      });
    }

    // Peg the new version into a predictable /versions/:id path under the
    // existing document folder so ops can spot the history in storage.
    const versionSlug = crypto.randomUUID().replace(/-/g, "");
    const key = versionStorageKey(
      userId,
      documentId,
      versionSlug,
      file.originalname,
    );
    const contentType =
      suffix === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    try {
      await uploadFile(
        key,
        file.buffer.buffer.slice(
          file.buffer.byteOffset,
          file.buffer.byteOffset + file.buffer.byteLength,
        ) as ArrayBuffer,
        contentType,
      );
    } catch (e) {
      console.error("[versions/upload] storage write failed", e);
      return void res
        .status(500)
        .json({ detail: "Failed to upload new version." });
    }

    // PDF rendition is handled by the conversion Lambda (EventBridge-triggered).
    let pdfStoragePath: string | null = null;
    if (suffix === "pdf") {
      pdfStoragePath = key;
    }

    // Per-document sequential version_number — the upload is V1 and
    // user_upload + assistant_edit count forward from there.
    const maxRow = await queryOne<{ version_number: number | null }>(
      `SELECT version_number FROM document_versions
       WHERE document_id = :documentId
         AND source IN ('upload', 'user_upload', 'assistant_edit')
         AND version_number IS NOT NULL
       ORDER BY version_number DESC
       LIMIT 1`,
      [{ name: "documentId", value: { stringValue: documentId } }],
    );
    const nextVersionNumber = (maxRow?.version_number ?? 1) + 1;

    const defaultDisplayName =
      typeof req.body?.display_name === "string" &&
      req.body.display_name.trim()
        ? req.body.display_name.trim().slice(0, 200)
        : file.originalname;

    const versionRow = await queryOne<{
      id: string;
      version_number: number | null;
      source: string;
      created_at: string;
      display_name: string | null;
    }>(
      `INSERT INTO document_versions
         (document_id, storage_path, pdf_storage_path, source, version_number, display_name)
       VALUES
         (:documentId, :storagePath, :pdfStoragePath, :source, :versionNumber, :displayName)
       RETURNING id, version_number, source, created_at, display_name`,
      [
        { name: "documentId", value: { stringValue: documentId } },
        { name: "storagePath", value: { stringValue: key } },
        {
          name: "pdfStoragePath",
          value: pdfStoragePath != null
            ? { stringValue: pdfStoragePath }
            : { isNull: true },
        },
        { name: "source", value: { stringValue: "user_upload" } },
        { name: "versionNumber", value: { longValue: nextVersionNumber } },
        { name: "displayName", value: { stringValue: defaultDisplayName } },
      ],
    );
    if (!versionRow) {
      console.error("[versions/upload] insert failed");
      return void res
        .status(500)
        .json({ detail: "Failed to record new version." });
    }

    // Also propagate the user-provided display_name to the parent document's
    // filename so the document's display name stays in sync across the UI.
    // Preserve a sensible extension: if the display_name has none, append
    // the uploaded file's extension (fallback: the existing doc's extension).
    const providedDisplayName =
      typeof req.body?.display_name === "string" &&
      req.body.display_name.trim()
        ? req.body.display_name.trim().slice(0, 200)
        : null;
    if (providedDisplayName) {
      const hasExt = /\.[a-z0-9]{1,6}$/i.test(providedDisplayName);
      const existingExt = doc.filename?.match(/\.[a-z0-9]{1,6}$/i)?.[0];
      const uploadedExt = suffix ? `.${suffix}` : "";
      const ext = hasExt ? "" : uploadedExt || existingExt || "";
      const newFilename = `${providedDisplayName}${ext}`;
      await execute(
        `UPDATE documents SET current_version_id = :versionId, filename = :filename
         WHERE id = :id`,
        [
          { name: "versionId", value: { stringValue: versionRow.id } },
          { name: "filename", value: { stringValue: newFilename } },
          { name: "id", value: { stringValue: documentId } },
        ],
      );
    } else {
      await execute(
        `UPDATE documents SET current_version_id = :versionId WHERE id = :id`,
        [
          { name: "versionId", value: { stringValue: versionRow.id } },
          { name: "id", value: { stringValue: documentId } },
        ],
      );
    }

    res.status(201).json(versionRow);
  },
);

// PATCH /single-documents/:documentId/versions/:versionId
// Rename a version's display_name. Pass `{ "display_name": "…" }`; an empty
// or missing value clears the override so the UI falls back to V{n}.
documentsRouter.patch(
  "/:documentId/versions/:versionId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId, versionId } = req.params;

    const doc = await queryOne<{
      id: string;
      user_id: string;
      project_id: string | null;
    }>(
      `SELECT id, user_id, project_id FROM documents WHERE id = :id`,
      [{ name: "id", value: { stringValue: documentId } }],
    );
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail);
    if (!access.ok)
      return void res.status(404).json({ detail: "Document not found" });

    const raw = req.body?.display_name;
    const displayName =
      typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 200) : null;

    const updated = await queryOne(
      `UPDATE document_versions SET display_name = :displayName
       WHERE id = :versionId AND document_id = :documentId
       RETURNING id, version_number, source, created_at, display_name`,
      [
        {
          name: "displayName",
          value: displayName != null ? { stringValue: displayName } : { isNull: true },
        },
        { name: "versionId", value: { stringValue: versionId } },
        { name: "documentId", value: { stringValue: documentId } },
      ],
    );
    if (!updated) {
      return void res.status(404).json({ detail: "Version not found" });
    }
    res.json(updated);
  },
);

// GET /single-documents/:documentId/tracked-change-ids
// Returns the ordered list of { kind, w_id } for every w:ins / w:del in
// the current (or specified) version's document.xml. The frontend uses
// this to tag each rendered <ins>/<del> with data-w-id, since
// docx-preview drops the w:id attribute during parsing.
documentsRouter.get(
  "/:documentId/tracked-change-ids",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const versionIdParam =
      typeof req.query.version_id === "string" ? req.query.version_id : null;

    const doc = await queryOne<{
      id: string;
      user_id: string;
      project_id: string | null;
    }>(
      `SELECT id, user_id, project_id FROM documents WHERE id = :id`,
      [{ name: "id", value: { stringValue: documentId } }],
    );
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail);
    if (!access.ok)
      return void res.status(404).json({ detail: "Document not found" });

    const active = await loadActiveVersion(documentId, versionIdParam);
    if (!active)
      return void res.status(404).json({ detail: "No file available" });

    const raw = await downloadFile(active.storage_path);
    if (!raw)
      return void res
        .status(404)
        .json({ detail: "Document bytes not available" });

    const ids = await extractTrackedChangeIds(Buffer.from(raw));
    res.json({ ids });
  },
);

// POST /single-documents/:documentId/edits/:editId/accept
// POST /single-documents/:documentId/edits/:editId/reject
async function handleEditResolution(
  req: import("express").Request,
  res: import("express").Response,
  mode: "accept" | "reject",
) {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { documentId, editId } = req.params;

  console.log(`[edit-resolution] incoming ${mode}`, {
    userId,
    documentId,
    editId,
  });

  const edit = await queryOne<{
    id: string;
    document_id: string;
    change_id: string;
    del_w_id: string | null;
    ins_w_id: string | null;
    status: string;
  }>(
    `SELECT id, document_id, change_id, del_w_id, ins_w_id, status
     FROM document_edits
     WHERE id = :editId AND document_id = :documentId`,
    [
      { name: "editId", value: { stringValue: editId } },
      { name: "documentId", value: { stringValue: documentId } },
    ],
  );
  console.log(`[edit-resolution] fetched edit row`, { edit });
  if (!edit) {
    console.log(`[edit-resolution] edit not found, returning 404`);
    return void res.status(404).json({ detail: "Edit not found" });
  }
  // Idempotent: if the edit is already resolved, return the current doc
  // state so stale UI (e.g. an old chat reloaded in a new session) can
  // reconcile without throwing.
  if (edit.status !== "pending") {
    console.log(`[edit-resolution] edit already resolved`, {
      editId,
      status: edit.status,
    });
    const docResolved = await queryOne<{
      current_version_id: string | null;
      filename: string;
      user_id: string;
      project_id: string | null;
    }>(
      `SELECT current_version_id, filename, user_id, project_id
       FROM documents WHERE id = :id`,
      [{ name: "id", value: { stringValue: documentId } }],
    );
    if (!docResolved) {
      console.log(`[edit-resolution] doc not found for resolved edit`);
      return void res.status(404).json({ detail: "Document not found" });
    }
    const accessResolved = await ensureDocAccess(docResolved, userId, userEmail);
    if (!accessResolved.ok) {
      console.log(`[edit-resolution] doc access denied for resolved edit`);
      return void res.status(404).json({ detail: "Document not found" });
    }
    const activeForResolved = await loadActiveVersion(documentId);
    const payload = {
      ok: true,
      already_resolved: true,
      status: edit.status,
      version_id: docResolved.current_version_id ?? null,
      download_url: activeForResolved
        ? buildDownloadUrl(
            activeForResolved.storage_path,
            docResolved.filename ?? "document.docx",
          )
        : null,
      remaining_pending: 0,
    };
    console.log(`[edit-resolution] returning already-resolved payload`, payload);
    return void res.status(200).json(payload);
  }

  const doc = await queryOne<{
    id: string;
    current_version_id: string | null;
    user_id: string;
    project_id: string | null;
  }>(
    `SELECT id, current_version_id, user_id, project_id
     FROM documents WHERE id = :id`,
    [{ name: "id", value: { stringValue: documentId } }],
  );
  console.log(`[edit-resolution] fetched doc`, { doc });
  if (!doc)
    return void res.status(404).json({ detail: "Document not found" });
  const access = await ensureDocAccess(doc, userId, userEmail);
  if (!access.ok)
    return void res.status(404).json({ detail: "Document not found" });

  const active = await loadActiveVersion(documentId);
  const latestPath = active?.storage_path ?? null;
  console.log(`[edit-resolution] resolved latestPath`, {
    latestPath,
    current_version_id: doc.current_version_id,
  });
  if (!latestPath)
    return void res.status(404).json({ detail: "No file to edit" });

  const raw = await downloadFile(latestPath);
  console.log(`[edit-resolution] downloaded bytes`, {
    byteLength: raw?.byteLength ?? 0,
  });
  if (!raw)
    return void res.status(404).json({ detail: "Document bytes not available" });

  const wIds = [edit.del_w_id, edit.ins_w_id].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  const { bytes: resolvedBytes, found } = await resolveTrackedChange(
    Buffer.from(raw),
    wIds,
    mode,
  );
  console.log(`[edit-resolution] resolveTrackedChange result`, {
    mode,
    change_id: edit.change_id,
    wIds,
    found,
    resolvedByteLength: resolvedBytes?.byteLength ?? 0,
  });
  if (!found) {
    console.log(
      `[edit-resolution] change_id not found in docx — updating status only`,
    );
    // Still update DB status so the UI reflects the decision — the change
    // may have been auto-consumed by a previous accept/reject pass.
    await execute(
      `UPDATE document_edits
       SET status = :status, resolved_at = NOW()
       WHERE id = :editId`,
      [
        {
          name: "status",
          value: { stringValue: mode === "accept" ? "accepted" : "rejected" },
        },
        { name: "editId", value: { stringValue: editId } },
      ],
    );
    const filenameRow = await queryOne<{ filename: string }>(
      `SELECT filename FROM documents WHERE id = :id`,
      [{ name: "id", value: { stringValue: documentId } }],
    );
    const payload = {
      ok: true,
      version_id: doc.current_version_id,
      download_url: buildDownloadUrl(
        latestPath,
        filenameRow?.filename ?? "document.docx",
      ),
      remaining_pending: 0,
    };
    console.log(`[edit-resolution] returning not-found payload`, payload);
    return void res.status(200).json(payload);
  }

  // Overwrite bytes in place at the current version's storage path —
  // accept/reject mutates the existing version rather than spawning a
  // new row. This keeps document_versions lean (one row per assistant
  // edit, not one per accept/reject click) and avoids the N-versions-
  // per-doc churn as users resolve pending changes.
  const ab = resolvedBytes.buffer.slice(
    resolvedBytes.byteOffset,
    resolvedBytes.byteOffset + resolvedBytes.byteLength,
  ) as ArrayBuffer;
  console.log(`[edit-resolution] overwriting bytes in place`, {
    latestPath,
    byteLength: ab.byteLength,
  });
  await uploadFile(
    latestPath,
    ab,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );

  await execute(
    `UPDATE document_edits
     SET status = :status, resolved_at = NOW()
     WHERE id = :editId`,
    [
      {
        name: "status",
        value: { stringValue: mode === "accept" ? "accepted" : "rejected" },
      },
      { name: "editId", value: { stringValue: editId } },
    ],
  );
  console.log(`[edit-resolution] updated document_edits status`, {
    editId,
    newStatus: mode === "accept" ? "accepted" : "rejected",
  });

  const remainingRow = await queryOne<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM document_edits
     WHERE document_id = :documentId AND status = 'pending'`,
    [{ name: "documentId", value: { stringValue: documentId } }],
  );
  const remainingPending = remainingRow?.count ?? 0;
  console.log(`[edit-resolution] remaining pending count`, { remainingPending });

  const filenameRow = await queryOne<{ filename: string }>(
    `SELECT filename FROM documents WHERE id = :id`,
    [{ name: "id", value: { stringValue: documentId } }],
  );
  const payload = {
    ok: true,
    version_id: doc.current_version_id,
    download_url: buildDownloadUrl(
      latestPath,
      filenameRow?.filename ?? "document.docx",
    ),
    remaining_pending: remainingPending,
  };
  console.log(`[edit-resolution] returning success payload`, payload);
  res.json(payload);
}

documentsRouter.post(
  "/:documentId/edits/:editId/accept",
  requireAuth,
  (req, res) => void handleEditResolution(req, res, "accept"),
);

documentsRouter.post(
  "/:documentId/edits/:editId/reject",
  requireAuth,
  (req, res) => void handleEditResolution(req, res, "reject"),
);

// POST /single-documents/:documentId/edits/resolve-batch
// Accepts or rejects all specified edits in a single S3 read-modify-write
// cycle, eliminating the race condition that occurs when per-edit requests
// overlap on the same document bytes.
documentsRouter.post(
  "/:documentId/edits/resolve-batch",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { documentId } = req.params;
    const { editIds, mode } = req.body as {
      editIds: string[];
      mode: "accept" | "reject";
    };

    if (!Array.isArray(editIds) || editIds.length === 0)
      return void res.status(400).json({ detail: "editIds must be a non-empty array" });
    if (mode !== "accept" && mode !== "reject")
      return void res.status(400).json({ detail: "mode must be accept or reject" });

    const doc = await queryOne<{
      id: string;
      current_version_id: string | null;
      user_id: string;
      project_id: string | null;
      filename: string;
    }>(
      `SELECT id, current_version_id, user_id, project_id, filename FROM documents WHERE id = :id`,
      [{ name: "id", value: { stringValue: documentId } }],
    );
    if (!doc) return void res.status(404).json({ detail: "Document not found" });
    const access = await ensureDocAccess(doc, userId, userEmail);
    if (!access.ok) return void res.status(404).json({ detail: "Document not found" });

    const placeholders = editIds.map((_, i) => `:id${i}::uuid`).join(", ");
    const edits = await query<{
      id: string;
      del_w_id: string | null;
      ins_w_id: string | null;
      status: string;
    }>(
      `SELECT id, del_w_id, ins_w_id, status FROM document_edits
       WHERE id IN (${placeholders}) AND document_id = :documentId AND status = 'pending'`,
      [
        ...editIds.map((id, i) => ({ name: `id${i}`, value: { stringValue: id } })),
        { name: "documentId", value: { stringValue: documentId } },
      ],
    );

    const active = await loadActiveVersion(documentId);
    const latestPath = active?.storage_path ?? null;
    if (!latestPath) return void res.status(404).json({ detail: "No file to edit" });

    const raw = await downloadFile(latestPath);
    if (!raw) return void res.status(404).json({ detail: "Document bytes not available" });

    // Apply all resolutions sequentially in memory — one S3 read, one write.
    let currentBytes = Buffer.from(raw);
    for (const edit of edits) {
      const wIds = [edit.del_w_id, edit.ins_w_id].filter(
        (v): v is string => typeof v === "string" && v.length > 0,
      );
      if (wIds.length === 0) continue;
      const { bytes } = await resolveTrackedChange(currentBytes, wIds, mode);
      currentBytes = bytes;
    }

    const ab = currentBytes.buffer.slice(
      currentBytes.byteOffset,
      currentBytes.byteOffset + currentBytes.byteLength,
    ) as ArrayBuffer;
    await uploadFile(latestPath, ab, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");

    const newStatus = mode === "accept" ? "accepted" : "rejected";
    if (edits.length > 0) {
      const updatePlaceholders = edits.map((_, i) => `:id${i}::uuid`).join(", ");
      await execute(
        `UPDATE document_edits SET status = :status, resolved_at = NOW()
         WHERE id IN (${updatePlaceholders})`,
        [
          { name: "status", value: { stringValue: newStatus } },
          ...edits.map((e, i) => ({ name: `id${i}`, value: { stringValue: e.id } })),
        ],
      );
    }

    res.json({
      ok: true,
      version_id: doc.current_version_id,
      download_url: buildDownloadUrl(latestPath, doc.filename ?? "document.docx"),
      resolved_count: edits.length,
      remaining_pending: 0,
    });
  },
);
