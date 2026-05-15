/**
 * `read_local_file` tool — reads a file from the agent's local skills directory.
 *
 * Accepts a relative path within the user's skills directory
 * (e.g. "my-skill/references/guide.md"). Enforces that the resolved path
 * stays within /tmp/<userId>/skills/ — no traversal outside this prefix.
 *
 * Returns an ImageBlock for images or a DocumentBlock for documents.
 * Both types are passed as raw bytes; the Strands SDK serialises them
 * for Bedrock (base64 encoding happens internally).
 *
 * Supported image formats:    png, jpg, jpeg, gif, webp
 * Supported document formats: pdf, csv, doc, docx, xls, xlsx, html, txt, md, json, xml
 */
import * as fs from 'fs';
import * as path from 'path';
import { tool } from '@strands-agents/sdk';
import { ImageBlock, DocumentBlock } from '@strands-agents/sdk';
import type { ImageFormat, DocumentFormat, JSONValue } from '@strands-agents/sdk';
import { z } from 'zod';

const IMAGE_FORMATS = new Set<string>(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const DOCUMENT_FORMATS = new Set<string>(['pdf', 'csv', 'doc', 'docx', 'xls', 'xlsx', 'html', 'txt', 'md', 'json', 'xml']);
const ALL_FORMATS = [...IMAGE_FORMATS, ...DOCUMENT_FORMATS].join(', ');

function sanitizePath(input: string): string {
  return input
    .replace(/^s3:\/\//i, '')
    .replace(/^file:\/\//i, '')
    .replace(/\0/g, '');
}

function cleanDocumentName(stem: string): string {
  return stem.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 200) || 'file';
}

export function makeReadLocalFileTool(userId: string) {
  const skillsBase = path.resolve('/tmp', userId, 'skills');

  return tool({
    name: 'read_local_file',
    description: `Read a file from your local skills directory. Pass a relative path within a skill folder (e.g. "my-skill/references/guide.md" or "my-skill/assets/diagram.png"). Supported formats: ${ALL_FORMATS}.`,
    inputSchema: z.object({
      file_path: z.string().describe('Relative path to the file within the skills directory (e.g. "skill-name/references/guide.md")'),
    }),
    callback: async ({ file_path }): Promise<JSONValue> => {
      const sanitized = sanitizePath(file_path);
      const resolved = path.resolve(skillsBase, sanitized);

      if (!resolved.startsWith(skillsBase + path.sep) && resolved !== skillsBase) {
        throw new Error(`Access denied: path is outside the skills directory.`);
      }

      const ext = path.extname(resolved).slice(1).toLowerCase();
      const stem = path.basename(resolved, path.extname(resolved));

      if (!IMAGE_FORMATS.has(ext) && !DOCUMENT_FORMATS.has(ext)) {
        throw new Error(`Unsupported file type: .${ext}. Supported formats: ${ALL_FORMATS}.`);
      }

      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(fs.readFileSync(resolved));
      } catch {
        throw new Error(`File not found: ${file_path}`);
      }

      if (IMAGE_FORMATS.has(ext)) {
        const format = (ext === 'jpg' ? 'jpeg' : ext) as ImageFormat;
        return new ImageBlock({ format, source: { bytes } }) as unknown as JSONValue;
      }

      const format = ext as DocumentFormat;
      return new DocumentBlock({ format, name: cleanDocumentName(stem), source: { bytes } }) as unknown as JSONValue;
    },
  });
}
