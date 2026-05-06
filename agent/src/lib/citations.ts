export type ParsedAnnotation = {
  ref: number;
  doc_id: string;
  page: number | string;
  quote: string;
};

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
