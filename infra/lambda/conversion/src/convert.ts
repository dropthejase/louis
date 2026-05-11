/**
 * LibreOffice-based DOCX→PDF conversion for the conversion Lambda.
 *
 * Nearly identical to backend/src/lib/convert.ts but in a separate package
 * because the conversion Lambda is a standalone x86_64 container. The
 * `convertedPdfKey` function here derives the PDF key from the full S3 source
 * key (path-based) rather than from (userId, docId) as in the backend version.
 */
import { promisify } from 'util';
import JSZip from 'jszip';

let _convert:
  | ((buf: Buffer, ext: string, filter: undefined) => Promise<Buffer>)
  | null = null;

async function getConvert() {
  if (!_convert) {
    const libre = await import('libreoffice-convert');
    _convert = promisify(libre.default.convert.bind(libre.default));
  }
  return _convert;
}

/**
 * Some older Windows/Word archives store .docx entries with backslash
 * separators (e.g. `word\document.xml`). Rewrite any such entries to the
 * canonical forward-slash form before handing the buffer off.
 */
export async function normalizeDocxZipPaths(buffer: Buffer): Promise<Buffer> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return buffer;
  }
  const renames: [string, string][] = [];
  zip.forEach((relativePath) => {
    if (relativePath.includes('\\')) {
      renames.push([relativePath, relativePath.replace(/\\/g, '/')]);
    }
  });
  if (renames.length === 0) return buffer;
  for (const [oldPath, newPath] of renames) {
    const entry = zip.file(oldPath);
    if (!entry) continue;
    const content = await entry.async('nodebuffer');
    zip.remove(oldPath);
    zip.file(newPath, content);
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

/**
 * Convert a DOCX/DOC buffer to PDF using LibreOffice.
 * Throws if LibreOffice is not installed or conversion fails.
 */
export async function docxToPdf(buffer: Buffer): Promise<Buffer> {
  const convert = await getConvert();
  const normalized = await normalizeDocxZipPaths(buffer);
  return convert(normalized, '.pdf', undefined);
}

/**
 * Derives the PDF S3 key from the source DOCX key.
 * Source:  documents/{userId}/{docId}/source.docx
 * PDF:     converted-pdfs/{userId}/{docId}/source.pdf
 */
export function convertedPdfKey(sourceKey: string): string {
  // sourceKey: documents/{userId}/{docId}/source.docx
  const parts = sourceKey.split('/');
  // parts: ['documents', userId, docId, 'source.docx']
  const userId = parts[1];
  const docId = parts[2];
  return `converted-pdfs/${userId}/${docId}/source.pdf`;
}
