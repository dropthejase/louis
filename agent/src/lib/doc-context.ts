import { SupabaseClient } from '@supabase/supabase-js';

export type DocStore = Map<string, { storage_path: string; file_type: string; filename: string }>;
export type DocIndex = Record<string, { document_id: string; filename: string; version_id?: string; version_number?: number }>;

export async function buildDocContext(
  userId: string,
  db: SupabaseClient
): Promise<{ docIndex: DocIndex; docStore: DocStore }> {
  const docStore: DocStore = new Map();
  const docIndex: DocIndex = {};

  const { data: docs } = await db
    .from('documents')
    .select('id, filename, file_type, current_version_id')
    .eq('user_id', userId)
    .is('project_id', null)
    .order('created_at', { ascending: true });

  if (!docs) return { docIndex, docStore };

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const label = `doc-${i}`;

    const { data: version } = await db
      .from('document_versions')
      .select('storage_path, pdf_storage_path, version_number')
      .eq('id', doc.current_version_id)
      .single();

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
  db: SupabaseClient
): Promise<{ docIndex: DocIndex; docStore: DocStore }> {
  const docStore: DocStore = new Map();
  const docIndex: DocIndex = {};

  const { data: docs } = await db
    .from('documents')
    .select('id, filename, file_type, current_version_id')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });

  if (!docs) return { docIndex, docStore };

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const label = `doc-${i}`;

    const { data: version } = await db
      .from('document_versions')
      .select('storage_path, version_number')
      .eq('id', doc.current_version_id)
      .single();

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
