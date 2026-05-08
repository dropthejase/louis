import { query, queryOne } from './db';

export type DocStore = Map<string, { storage_path: string; file_type: string; filename: string }>;
export type DocIndex = Record<string, { document_id: string; filename: string; version_id?: string; version_number?: number }>;

export async function buildDocContext(
  userId: string,
): Promise<{ docIndex: DocIndex; docStore: DocStore }> {
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

    const version = await queryOne<{ storage_path: string; version_number: number }>(
      `SELECT storage_path, version_number FROM document_versions WHERE id = :versionId`,
      [{ name: 'versionId', value: { stringValue: doc.current_version_id } }],
    );

    if (!version) continue;

    docStore.set(label, {
      storage_path: version.storage_path,
      file_type: doc.file_type,
      filename: doc.filename,
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

export async function buildProjectDocContext(
  projectId: string,
): Promise<{ docIndex: DocIndex; docStore: DocStore }> {
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

    const version = await queryOne<{ storage_path: string; version_number: number }>(
      `SELECT storage_path, version_number FROM document_versions WHERE id = :versionId`,
      [{ name: 'versionId', value: { stringValue: doc.current_version_id } }],
    );

    if (!version) continue;

    docStore.set(label, {
      storage_path: version.storage_path,
      file_type: doc.file_type,
      filename: doc.filename,
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
