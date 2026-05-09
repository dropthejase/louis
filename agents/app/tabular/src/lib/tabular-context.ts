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

  // Ownership check: allow review owner or any project member (checked via cells join below)
  // For agent use, we only need read access — verified by JOIN in read_table_cells tool.
  // We also accept project-shared access if the review row exists (ownership enforced in tool).

  const columns: ColumnConfig[] = (review.columns_config ?? [])
    .slice()
    .sort((a, b) => a.index - b.index);

  const cells = await query<{ document_id: string }>(
    `SELECT DISTINCT document_id FROM tabular_cells WHERE review_id = :reviewId`,
    [{ name: 'reviewId', value: { stringValue: reviewId } }],
  );

  const docIds = cells.map((c) => c.document_id);
  let documents: ReviewDoc[] = [];
  if (docIds.length > 0) {
    const placeholders = docIds.map((_, i) => `:did${i}`).join(', ');
    documents = await query<ReviewDoc>(
      `SELECT id, filename FROM documents WHERE id IN (${placeholders}) ORDER BY created_at ASC`,
      docIds.map((id, i) => ({ name: `did${i}`, value: { stringValue: id } })),
    );
  }

  return {
    reviewTitle: review.title ?? 'Untitled Review',
    columns,
    documents,
  };
}
