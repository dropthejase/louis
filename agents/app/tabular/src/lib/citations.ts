import type { TabularContext } from './tabular-context';

export type ParsedAnnotation = {
  ref: number;
  col_index: number;
  row_index: number;
  col_name: string;
  doc_name: string;
  quote: string;
};

/**
 * Parse the `<CITATIONS>` block from an agent response string.
 * Enriches col_name and doc_name from TabularContext.
 * Returns an empty array if the block is absent or malformed.
 */
export function extractAnnotations(text: string, ctx: TabularContext): ParsedAnnotation[] {
  const match = text.match(/<CITATIONS>([\s\S]*?)<\/CITATIONS>/);
  if (!match) return [];
  try {
    const raw = JSON.parse(match[1].trim()) as unknown[];
    if (!Array.isArray(raw)) return [];
    const results: ParsedAnnotation[] = [];
    for (const r of raw) {
      if (!r || typeof r !== 'object') continue;
      const c = r as Record<string, unknown>;
      if (
        typeof c.ref !== 'number' ||
        typeof c.col_index !== 'number' ||
        typeof c.row_index !== 'number' ||
        typeof c.quote !== 'string' ||
        c.quote.length === 0
      ) {
        console.warn('[citations] dropping malformed citation entry', c);
        continue;
      }
      results.push({
        ref: c.ref,
        col_index: c.col_index,
        row_index: c.row_index,
        col_name: ctx.columns[c.col_index]?.name ?? `Col ${c.col_index}`,
        doc_name: ctx.documents[c.row_index]?.filename ?? `Row ${c.row_index}`,
        quote: c.quote,
      });
    }
    return results;
  } catch {
    return [];
  }
}
