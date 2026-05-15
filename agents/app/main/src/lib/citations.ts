/**
 * Citation extraction utilities for the agent response pipeline.
 *
 * The agent appends a `<CITATIONS>[...]</CITATIONS>` JSON block at the end of
 * responses that cite source documents. This module parses that block so the
 * citations can be included in the `citations` SSE event sent to the frontend.
 *
 * The agent is instructed to output real document_id and version_id UUIDs
 * (sourced from list_documents output) rather than chat-local labels like "doc-0".
 * Citations with invalid or unrecognised UUIDs are dropped and warned.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ParsedAnnotation = {
  ref: number;
  document_id: string;
  version_id: string | null;
  filename: string;
  page: number | string;
  quote: string;
};

/**
 * Parse the `<CITATIONS>` block from an agent response string.
 * Drops entries with missing or malformed document_id UUIDs.
 * Optionally validates document_id against a known set of valid UUIDs.
 */
export function extractAnnotations(
  text: string,
  validDocumentIds?: Set<string>,
): ParsedAnnotation[] {
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
        typeof c.document_id !== 'string' ||
        !UUID_RE.test(c.document_id) ||
        (typeof c.page !== 'number' && typeof c.page !== 'string') ||
        typeof c.quote !== 'string' ||
        c.quote.length === 0
      ) {
        console.warn('[citations] dropping malformed citation entry', c);
        continue;
      }
      if (validDocumentIds && !validDocumentIds.has(c.document_id)) {
        console.warn('[citations] dropping citation with unrecognised document_id', c.document_id);
        continue;
      }
      results.push({
        ref: c.ref,
        document_id: c.document_id,
        version_id: typeof c.version_id === 'string' ? c.version_id : null,
        filename: typeof c.filename === 'string' ? c.filename : '',
        page: c.page as number | string,
        quote: c.quote,
      });
    }
    return results;
  } catch {
    return [];
  }
}
