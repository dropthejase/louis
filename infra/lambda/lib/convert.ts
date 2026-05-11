import JSZip from "jszip";

/**
 * Some older Windows/Word archives store .docx entries with backslash
 * separators (e.g. `word\document.xml`). Mammoth and LibreOffice both look
 * up entries by exact string and miss those files, producing empty output
 * or conversion failures. Rewrite any such entries to the canonical
 * forward-slash form before handing the buffer off.
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
    if (relativePath.includes("\\")) {
      renames.push([relativePath, relativePath.replace(/\\/g, "/")]);
    }
  });
  if (renames.length === 0) return buffer;
  for (const [oldPath, newPath] of renames) {
    const entry = zip.file(oldPath);
    if (!entry) continue;
    const content = await entry.async("nodebuffer");
    zip.remove(oldPath);
    zip.file(newPath, content);
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

export function convertedPdfKey(userId: string, docId: string): string {
  return `converted-pdfs/${userId}/${docId}.pdf`;
}
