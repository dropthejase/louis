import { query, queryOne } from './db';

export interface ColumnConfig {
  index: number;
  name: string;
  prompt: string;
}

export interface ReviewDoc {
  id: string;
  filename: string;
}

export interface TabularContext {
  reviewTitle: string;
  columns: ColumnConfig[];
  documents: ReviewDoc[];
}

export async function buildTabularContext(reviewId: string, userId: string): Promise<TabularContext | null> {
  const review = await queryOne<{ title: string | null; columns_config: ColumnConfig[] | null; user_id: string }>(
    `SELECT title, columns_config, user_id FROM tabular_reviews WHERE id = :id`,
    [{ name: 'id', value: { stringValue: reviewId } }],
  );
  if (!review) return null;

  const rawColumns = typeof review.columns_config === 'string'
    ? JSON.parse(review.columns_config)
    : (review.columns_config ?? []);
  const columns: ColumnConfig[] = (rawColumns as ColumnConfig[])
    .slice()
    .sort((a, b) => a.index - b.index);

  const cells = await query<{ document_id: string }>(
    `SELECT DISTINCT document_id FROM tabular_cells WHERE review_id = :reviewId`,
    [{ name: 'reviewId', value: { stringValue: reviewId } }],
  );

  const docIds = cells.map((c) => c.document_id);
  let documents: ReviewDoc[] = [];
  if (docIds.length > 0) {
    const placeholders = docIds.map((_, i) => `:did${i}::uuid`).join(', ');
    documents = await query<ReviewDoc>(
      `SELECT id, filename FROM documents WHERE id IN (${placeholders}) ORDER BY created_at ASC`,
      docIds.map((id, i) => ({ name: `did${i}`, value: { stringValue: id } })),
    );
    console.log('[buildTabularContext] documents query done', { count: documents.length });
  }

  return {
    reviewTitle: review.title ?? 'Untitled Review',
    columns,
    documents,
  };
}
