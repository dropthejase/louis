/**
 * Helpers for resolving document storage paths via the document_versions table.
 *
 * Storage paths (DOCX bytes and PDF renditions) live on document_versions rows,
 * not on documents. Every read-from-storage path must go through these helpers
 * so the current version is always respected.
 */
import { query, queryOne } from "./db";

export interface ActiveVersion {
  id: string;
  storage_path: string;
  pdf_storage_path: string | null;
  version_number: number | null;
  display_name: string | null;
  source: string | null;
}

/**
 * Resolve storage paths for a document. Prefers the version pointed to by
 * `versionId` (if it belongs to this document); else falls back to
 * `documents.current_version_id`. Returns null if no usable version exists.
 *
 * After the storage_path/pdf_storage_path columns moved off `documents`,
 * every read-from-storage path goes through here.
 */
export async function loadActiveVersion(
  documentId: string,
  versionId?: string | null,
): Promise<ActiveVersion | null> {
  const doc = await queryOne<{ current_version_id: string | null }>(
    `SELECT current_version_id FROM documents WHERE id = :documentId`,
    [{ name: "documentId", value: { stringValue: documentId } }],
  );
  const targetVersionId =
    (typeof versionId === "string" && versionId) ||
    doc?.current_version_id ||
    null;
  if (!targetVersionId) return null;

  const v = await queryOne<{
    id: string;
    document_id: string;
    storage_path: string;
    pdf_storage_path: string | null;
    version_number: number | null;
    display_name: string | null;
    source: string | null;
  }>(
    `SELECT id, document_id, storage_path, pdf_storage_path, version_number, display_name, source
     FROM document_versions WHERE id = :versionId`,
    [{ name: "versionId", value: { stringValue: targetVersionId } }],
  );
  if (!v || v.document_id !== documentId || !v.storage_path) return null;
  return {
    id: v.id,
    storage_path: v.storage_path,
    pdf_storage_path: v.pdf_storage_path ?? null,
    version_number: v.version_number ?? null,
    display_name: v.display_name ?? null,
    source: v.source ?? null,
  };
}

interface DocRow {
  id: string;
  current_version_id?: string | null;
  storage_path?: string | null;
  pdf_storage_path?: string | null;
  active_version_number?: number | null;
  latest_version_number?: number | null;
  [k: string]: unknown;
}

/**
 * For a list of documents, look up the active version for each and merge
 * `storage_path` + `pdf_storage_path` onto the row. One round-trip total
 * regardless of list size. Documents with no current_version_id retain
 * null paths.
 */
export async function attachActiveVersionPaths<T extends DocRow>(
  docs: T[],
): Promise<T[]> {
  if (docs.length === 0) return docs;
  const versionIds = docs
    .map((d) => d.current_version_id)
    .filter((id): id is string => typeof id === "string");
  if (versionIds.length === 0) {
    for (const d of docs) { d.storage_path = null; d.pdf_storage_path = null; }
    return docs;
  }
  const placeholders = versionIds.map((_, i) => `:id${i}::uuid`).join(", ");
  const rows = await query<{
    id: string;
    storage_path: string | null;
    pdf_storage_path: string | null;
    version_number: number | null;
  }>(
    `SELECT id, storage_path, pdf_storage_path, version_number
     FROM document_versions WHERE id IN (${placeholders})`,
    versionIds.map((id, i) => ({ name: `id${i}`, value: { stringValue: id } })),
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const d of docs) {
    const v = d.current_version_id ? byId.get(d.current_version_id) : null;
    d.storage_path = v?.storage_path ?? null;
    d.pdf_storage_path = v?.pdf_storage_path ?? null;
    d.active_version_number = v?.version_number ?? null;
  }
  return docs;
}

/**
 * Given a list of document rows, attach `latest_version_number` — the
 * max `version_number` across all assistant_edit rows for that doc, or
 * null if none. Mutates rows in place and returns the same reference.
 * One extra query regardless of list size.
 */
export async function attachLatestVersionNumbers<T extends DocRow>(
  docs: T[],
): Promise<T[]> {
  if (docs.length === 0) return docs;
  const placeholders = docs.map((_, i) => `:id${i}::uuid`).join(", ");
  const rows = await query<{ document_id: string; version_number: number | null }>(
    `SELECT document_id, version_number FROM document_versions
     WHERE document_id IN (${placeholders})
       AND source = 'assistant_edit'
       AND version_number IS NOT NULL`,
    docs.map((d, i) => ({ name: `id${i}`, value: { stringValue: d.id } })),
  );
  const latestByDoc = new Map<string, number>();
  for (const r of rows) {
    if (r.version_number == null) continue;
    const prev = latestByDoc.get(r.document_id) ?? 0;
    if (r.version_number > prev) latestByDoc.set(r.document_id, r.version_number);
  }
  for (const d of docs) d.latest_version_number = latestByDoc.get(d.id) ?? null;
  return docs;
}
