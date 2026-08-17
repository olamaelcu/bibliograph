import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export class LexiconNotFound extends Error {
  readonly nsid: string;
  constructor(nsid: string) {
    super(`Lexicon not found: ${nsid}`);
    this.name = 'LexiconNotFound';
    this.nsid = nsid;
  }
}

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const TYPES_DIR = join(__dirname, 'lexicons/types');

function walkDir(dir: string, base: string = ''): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const nsids: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      nsids.push(...walkDir(join(dir, entry.name), `${base}${entry.name}/`));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      const name = entry.name.replace(/\.(ts|tsx)$/, '');
      const rel = `${base}${name}`.replace(/\/$/, '');
      const nsid = rel.replace(/\//g, '.').replace(/^net\//, 'net.');
      nsids.push(nsid);
    }
  }
  return nsids;
}

const knownNsids = new Set<string>(walkDir(TYPES_DIR));

export function loadKnownNsids(): Set<string> {
  const result = new Set(knownNsids);
  Object.freeze(result);
  return result;
}

export function nsidToJsonPath(nsid: string): string | null {
  const segments = nsid.split('.');
  if (segments.length < 3) return null;
  const path = segments.join('/');
  return `lexicons/${path}.json`;
}

export function loadLexiconSchema(nsid: string): { id: string; json: unknown; bytes: Buffer } {
  if (!knownNsids.has(nsid)) {
    throw new LexiconNotFound(nsid);
  }
  const jsonPath = nsidToJsonPath(nsid);
  if (!jsonPath) {
    throw new LexiconNotFound(nsid);
  }
  const fullPath = join(__dirname, '..', jsonPath);
  const content = readFileSync(fullPath, 'utf8');
  const json = JSON.parse(content);
  const bytes = Buffer.from(JSON.stringify(JSON.parse(content)), 'utf8');
  return { id: nsid, json, bytes };
}
