/**
 * Document context builders — populate the in-memory DocStore and DocIndex
 * for a single agent invocation.
 *
 * DocStore maps chat-local labels (doc-0, doc-1, …) to S3 storage metadata;
 * DocIndex maps the same labels to DB identifiers needed for write operations.
 * Labels are assigned in ascending created_at order and are stable within one
 * invocation but may differ across turns if documents are added between calls.
 *
 * The N+1 query pattern (one version lookup per document) is intentional:
 * Aurora Data API does not support JOINs that return nested objects, so a
 * batch IN clause would require post-processing that is equivalent complexity.
 */
import { query, queryOne } from './db';

export type DocStore = Map<string, { storage_path: string; file_type: string; filename: string; document_id: string; version_id: string }>;
export type DocIndex = Record<string, { document_id: string; filename: string; version_id?: string; version_number?: number }>;

/**
 * Build document context for a standalone (non-project) agent invocation.
 * Loads all documents owned by userId that have no project_id.
 */
export async function buildDocContext(
  userId: string,
): Promise<{ docIndex: DocIndex; docStore: DocStore }> {
  console.log('[buildDocContext] query start', { userId });
  const docStore: DocStore = new Map();
  const docIndex: DocIndex = {};

  const docs = await query<{ id: string; filename: string; file_type: string; current_version_id: string }>(
    `SELECT id, filename, file_type, current_version_id
     FROM documents
     WHERE user_id = :userId AND project_id IS NULL
     ORDER BY created_at ASC`,
    [{ name: 'userId', value: { stringValue: userId } }],
  );

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const label = `doc-${i}`;

    if (!doc.current_version_id) {
      console.warn(`[doc-context] doc ${doc.id} (${doc.filename}) has no current_version_id — skipping`);
      continue;
    }

    const version = await queryOne<{ storage_path: string; version_number: number }>(
      `SELECT storage_path, version_number FROM document_versions WHERE id = :versionId`,
      [{ name: 'versionId', value: { stringValue: doc.current_version_id } }],
    );

    if (!version) continue;

    docStore.set(label, {
      storage_path: version.storage_path,
      file_type: doc.file_type,
      filename: doc.filename,
      document_id: doc.id,
      version_id: doc.current_version_id,
    });

    docIndex[label] = {
      document_id: doc.id,
      filename: doc.filename,
      version_id: doc.current_version_id,
      version_number: version.version_number,
    };
  }

  console.log('[buildDocContext] query done', { count: docStore.size });
  return { docIndex, docStore };
}

/**
 * Build document context for a project-scoped agent invocation.
 * Loads all documents belonging to the given project, regardless of owner.
 */
export async function buildProjectDocContext(
  projectId: string,
): Promise<{ docIndex: DocIndex; docStore: DocStore }> {
  console.log('[buildProjectDocContext] query start', { projectId });
  const docStore: DocStore = new Map();
  const docIndex: DocIndex = {};

  const docs = await query<{ id: string; filename: string; file_type: string; current_version_id: string }>(
    `SELECT id, filename, file_type, current_version_id
     FROM documents
     WHERE project_id = :projectId
     ORDER BY created_at ASC`,
    [{ name: 'projectId', value: { stringValue: projectId } }],
  );

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const label = `doc-${i}`;

    if (!doc.current_version_id) {
      console.warn(`[doc-context] doc ${doc.id} (${doc.filename}) has no current_version_id — skipping`);
      continue;
    }

    const version = await queryOne<{ storage_path: string; version_number: number }>(
      `SELECT storage_path, version_number FROM document_versions WHERE id = :versionId`,
      [{ name: 'versionId', value: { stringValue: doc.current_version_id } }],
    );

    if (!version) continue;

    docStore.set(label, {
      storage_path: version.storage_path,
      file_type: doc.file_type,
      filename: doc.filename,
      document_id: doc.id,
      version_id: doc.current_version_id,
    });

    docIndex[label] = {
      document_id: doc.id,
      filename: doc.filename,
      version_id: doc.current_version_id,
      version_number: version.version_number,
    };
  }

  return { docIndex, docStore };
}
