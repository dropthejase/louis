import { tool } from '@strands-agents/sdk';
import { z } from 'zod';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType,
} from 'docx';
import { uploadFile, getPresignedUrl } from '../lib/storage';
import { SupabaseClient } from '@supabase/supabase-js';
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
  db: SupabaseClient
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

      // Record in DB
      const { data: docRow } = await db.from('documents').insert({
        id: docId,
        user_id: userId,
        filename,
        file_type: 'docx',
        size_bytes: buf.length,
        status: 'ready',
      }).select().single();

      let versionId: string | undefined;
      if (docRow) {
        const { data: versionRow } = await db.from('document_versions').insert({
          document_id: docId,
          storage_path: storageKey,
          source: 'assistant_generated',
          version_number: 1,
          display_name: 'Generated',
        }).select().single();

        if (versionRow) {
          versionId = versionRow.id as string;
          await db.from('documents').update({ current_version_id: versionRow.id }).eq('id', docId);
        }
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
