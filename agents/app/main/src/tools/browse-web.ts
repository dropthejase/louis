/**
 * `browse_web` tool — fetches a URL and returns stripped text + extracted links.
 *
 * Domain allowlist is loaded from S3 (ADMIN_BUCKET_NAME/browse-allowlist.json)
 * once at process startup and cached for the lifetime of the container. Ops can
 * update the allowlist by uploading a new file — takes effect on next cold start.
 *
 * Returns:
 *   text  — visible page text (script/style stripped, up to MAX_TEXT_CHARS)
 *   links — { text, url }[] from <a href> tags (up to MAX_LINKS)
 */
import { tool } from '@strands-agents/sdk';
import type { JSONValue } from '@strands-agents/sdk';
import { z } from 'zod';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const MAX_TEXT_CHARS = 40_000;
const MAX_LINKS = 50;
const FETCH_TIMEOUT_MS = 20_000;

const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'eu-west-1' });

// Fallback used only if S3 load fails — ensures the tool degrades safely.
const FALLBACK_DOMAINS: string[] = [
  'curia.europa.eu',
  'eur-lex.europa.eu',
  'www.bailii.org',
  'www.edpb.europa.eu',
  'www.ico.org.uk',
  'www.fca.org.uk',
  'find.companieshouse.gov.uk',
  'beta.companieshouse.gov.uk',
];

let allowedDomains: Set<string> | null = null;

async function loadAllowlist(): Promise<Set<string>> {
  if (allowedDomains) return allowedDomains;

  const bucket = process.env.ADMIN_BUCKET_NAME;
  if (!bucket) {
    console.warn('[browse-web] ADMIN_BUCKET_NAME not set, using fallback allowlist');
    allowedDomains = new Set(FALLBACK_DOMAINS);
    return allowedDomains;
  }

  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: 'browse-allowlist.json' }));
    const body = await res.Body?.transformToString();
    const parsed = JSON.parse(body ?? '[]') as string[];
    allowedDomains = new Set(parsed);
    console.log(`[browse-web] Loaded allowlist from S3: ${parsed.join(', ')}`);
  } catch (err) {
    console.error('[browse-web] Failed to load allowlist from S3, using fallback:', err);
    allowedDomains = new Set(FALLBACK_DOMAINS);
  }

  return allowedDomains;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLinks(html: string, baseUrl: string): { text: string; url: string }[] {
  const base = new URL(baseUrl);
  const links: { text: string; url: string }[] = [];
  const re = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null && links.length < MAX_LINKS) {
    const href = match[1].trim();
    const text = match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) continue;
    try {
      const resolved = new URL(href, base).href;
      if (text) links.push({ text, url: resolved });
    } catch {
      // skip malformed hrefs
    }
  }
  return links;
}

export const browseWebTool = tool({
  name: 'browse_web',
  description: 'Fetch a page from a whitelisted legal/regulatory website and return its text content plus navigation links. Use text to read content; use links to navigate deeper. Only domains in the configured allowlist are permitted.',
  inputSchema: z.object({
    url: z.string().url().describe('The URL to fetch'),
  }),
  callback: async ({ url }): Promise<JSONValue> => {
    const domains = await loadAllowlist();

    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      return { error: 'Invalid URL' } as JSONValue;
    }

    if (!domains.has(hostname)) {
      return { error: `Domain '${hostname}' not permitted. Allowed: ${[...domains].join(', ')}` } as JSONValue;
    }

    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const response = await fetch(url, {
      signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Mike-Legal-Agent/1.0)' },
    });

    if (!response.ok) {
      return { error: `HTTP ${response.status} ${response.statusText}: ${url}` } as JSONValue;
    }

    const html = await response.text();
    const text = htmlToText(html);
    const truncatedText = text.length > MAX_TEXT_CHARS
      ? text.slice(0, MAX_TEXT_CHARS) + `\n\n[Content truncated at ${MAX_TEXT_CHARS} characters]`
      : text;
    const links = extractLinks(html, url);

    return { url, text: truncatedText, links } as JSONValue;
  },
});
