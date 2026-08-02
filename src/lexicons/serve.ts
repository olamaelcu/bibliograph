import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { logger } from '../logger.js';

const LEXICONS_DIR = resolve('lexicons');

function walkDir(dir: string, ext: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walkDir(full, ext));
    } else if (entry.endsWith(ext)) {
      files.push(full);
    }
  }
  return files;
}

function nsidToPath(nsid: string): string {
  const segments = nsid.split('.');
  return join(LEXICONS_DIR, ...segments) + '.json';
}

function pathToNsid(filePath: string): string {
  const relative = filePath.slice(LEXICONS_DIR.length + 1);
  return relative.replace(/\.json$/, '').replace(/\//g, '.');
}

export function serveLexicon(c: Context): Response {
  const log = c.get('log') as typeof logger;
  const nsid = c.req.param('nsid');
  if (!nsid) {
    log.warn('serveLexicon rejected: missing nsid');
    return c.json({ error: 'InvalidRequest', message: 'nsid is required' }, 400);
  }

  log.info({ nsid }, 'serving lexicon');

  try {
    const path = nsidToPath(nsid);
    const content = readFileSync(path, 'utf-8');
    return c.json(JSON.parse(content));
  } catch {
    log.info({ nsid }, 'lexicon not found');
    return c.json({ error: 'NotFound', message: 'Lexicon not found' }, 404);
  }
}

export function serveLexiconHashes(c: Context): Response {
  const log = c.get('log') as typeof logger;
  log.info('serving lexicon hashes');

  const files = walkDir(LEXICONS_DIR, '.json');
  const hashes: Record<string, string> = {};

  for (const file of files) {
    const nsid = pathToNsid(file);
    if (nsid.endsWith('.defs')) continue;
    const content = readFileSync(file, 'utf-8');
    hashes[nsid] = createHash('sha256').update(content).digest('hex');
  }

  return c.json(hashes);
}
