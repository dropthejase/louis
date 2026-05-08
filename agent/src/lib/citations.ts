/**
 * Citation extraction utilities for the agent response pipeline.
 *
 * The agent appends a `<CITATIONS>[...]</CITATIONS>` JSON block at the end of
 * responses that cite source documents. This module parses that block so the
 * citations can be included in the `citations` SSE event sent to the frontend.
 */
export type ParsedAnnotation = {
  ref: number;
  doc_id: string;
  page: number | string;
  quote: string;
};

/**
 * Parse the `<CITATIONS>` block from an agent response string.
 * Returns an empty array if the block is absent or malformed.
 */
export function extractAnnotations(text: string): ParsedAnnotation[] {
  const match = text.match(/<CITATIONS>([\s\S]*?)<\/CITATIONS>/);
  if (!match) return [];
  try {
    const raw = JSON.parse(match[1].trim()) as unknown[];
    if (!Array.isArray(raw)) return [];
    return raw.filter((r): r is ParsedAnnotation => {
      if (!r || typeof r !== 'object') return false;
      const c = r as Record<string, unknown>;
      return (
        typeof c.ref === 'number' &&
        typeof c.doc_id === 'string' &&
        (typeof c.page === 'number' || typeof c.page === 'string') &&
        typeof c.quote === 'string' &&
        c.quote.length > 0
      );
    });
  } catch {
    return [];
  }
}
