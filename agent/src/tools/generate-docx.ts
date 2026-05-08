import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType,
} from 'docx';
import { uploadFile, getPresignedUrl } from '../lib/storage';
import { query, execute } from '../lib/db';
import { DocStore, DocIndex } from '../lib/doc-context';

const SectionSchema = z.object({
  heading: z.string().optional(),
  level: z.number().int().optional(),
  content: z.string().optional(),
  pageBreak: z.boolean().optional(),
  table: z.object({
    headers: z.array(z.string()),
    rows: z.array(z.array(z.string())),
  }).optional(),
});

export function makeGenerateDocxTool(
  userId: string,
  docStore: DocStore,
  docIndex: DocIndex,
) {
  return tool({
    name: 'generate_docx',
    description: 'Generate a Word (.docx) document from structured content. Returns a doc_id for the generated document.',
    inputSchema: z.object({
      title: z.string().describe('Document title'),
      landscape: z.boolean().optional().describe('Landscape orientation'),
      sections: z.array(SectionSchema).describe('Document sections'),
    }),
    callback: async ({ title, landscape, sections }): Promise<string> => {
      const children: (Paragraph | Table)[] = [];

      // Title paragraph
      children.push(new Paragraph({ text: title, heading: HeadingLevel.TITLE }));

      for (const section of sections) {
        if (section.pageBreak) {
          children.push(new Paragraph({ pageBreakBefore: true, text: '' }));
        }
        if (section.heading) {
          const headingLevels = [
            HeadingLevel.HEADING_1,
            HeadingLevel.HEADING_2,
            HeadingLevel.HEADING_3,
          ];
          const level = headingLevels[(section.level ?? 1) - 1] ?? HeadingLevel.HEADING_1;
          children.push(new Paragraph({ text: section.heading, heading: level }));
        }
        if (section.content) {
          for (const para of section.content.split('\n\n')) {
            if (para.trim()) children.push(new Paragraph({ children: [new TextRun(para.trim())] }));
          }
        }
        if (section.table) {
          const rows = [
            new TableRow({
              children: section.table.headers.map(h => new TableCell({
                children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })],
              })),
            }),
            ...section.table.rows.map(row => new TableRow({
              children: row.map(cell => new TableCell({
                children: [new Paragraph({ children: [new TextRun(cell)] })],
              })),
            })),
          ];
          children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
        }
      }

      const doc = new Document({
        sections: [{
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          properties: landscape ? { page: { size: { orientation: 'landscape' as any } } } : {},
          children,
        }],
      });

      const buf = await Packer.toBuffer(doc);
      const docId = crypto.randomUUID();
      const filename = `${title.replace(/[^a-z0-9]/gi, '_')}.docx`;
      const storageKey = `generated/${userId}/${docId}/generated.docx`;

      await uploadFile(storageKey, buf, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

      // Insert document record
      await execute(
        `INSERT INTO documents (id, user_id, filename, file_type, size_bytes, status)
         VALUES (:id, :userId, :filename, 'docx', :sizeBytes, 'ready')`,
        [
          { name: 'id', value: { stringValue: docId } },
          { name: 'userId', value: { stringValue: userId } },
          { name: 'filename', value: { stringValue: filename } },
          { name: 'sizeBytes', value: { longValue: buf.length } },
        ],
      );

      const versionRows = await query<{ id: string }>(
        `INSERT INTO document_versions (document_id, storage_path, source, version_number, display_name)
         VALUES (:documentId, :storagePath, 'assistant_generated', 1, 'Generated')
         RETURNING id`,
        [
          { name: 'documentId', value: { stringValue: docId } },
          { name: 'storagePath', value: { stringValue: storageKey } },
        ],
      );

      let versionId: string | undefined;
      if (versionRows.length > 0) {
        versionId = versionRows[0].id;
        await execute(
          `UPDATE documents SET current_version_id = :versionId WHERE id = :documentId`,
          [
            { name: 'versionId', value: { stringValue: versionId } },
            { name: 'documentId', value: { stringValue: docId } },
          ],
        );
      }

      // Add to docStore for immediate use in same session
      const label = `doc-${Object.keys(docIndex).length}`;
      docStore.set(label, { storage_path: storageKey, file_type: 'docx', filename });
      docIndex[label] = { document_id: docId, filename, version_number: 1, version_id: versionId };

      const url = await getPresignedUrl(storageKey, 900, filename);
      return JSON.stringify({ doc_id: label, filename, download_url: url, document_id: docId, version_id: versionId });
    },
  });
}
