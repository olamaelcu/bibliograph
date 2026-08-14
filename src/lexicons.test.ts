import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const LEXICON_DIR = join(PROJECT_ROOT, 'lexicons/net/olamaelcu/livtet/biblio');

interface LexiconFile {
  lexicon: number;
  id: string;
  description?: string;
  defs: Record<string, unknown>;
}

function loadLexicons(): LexiconFile[] {
  const files = readdirSync(LEXICON_DIR).filter((f) => f.endsWith('.json'));
  return files.map((file) => JSON.parse(readFileSync(join(LEXICON_DIR, file), 'utf8')));
}

function walkRefs(node: unknown, refs: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) walkRefs(item, refs);
    return;
  }
  if (node !== null && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (typeof obj.ref === 'string') refs.push(obj.ref);
    for (const value of Object.values(obj)) walkRefs(value, refs);
  }
}

function collectRefs(doc: LexiconFile): string[] {
  const refs: string[] = [];
  walkRefs(doc.defs, refs);
  return refs;
}

const NSID_BASE = 'net.olamaelcu.livtet.biblio.';

describe('biblio lexicons', () => {
  const docs = loadLexicons();

  it('loads a non-empty lexicon set', () => {
    expect(docs.length).toBeGreaterThan(0);
  });

  it('every lexicon is version 1 with a valid NSID', () => {
    for (const doc of docs) {
      expect(doc.lexicon).toBe(1);
      expect(doc.id).toMatch(/^net\.olamaelcu\.livtet\.biblio\.[a-zA-Z]+$/);
    }
  });

  it('NSIDs are unique', () => {
    const ids = docs.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every non-defs lexicon defines a main record, query, or procedure', () => {
    for (const doc of docs) {
      if (doc.id.endsWith('.defs')) continue;
      const main = doc.defs.main as { type?: string } | undefined;
      expect(main?.type, `${doc.id} missing main`).toBeDefined();
      expect(['record', 'query', 'procedure'], `${doc.id} unexpected main type`).toContain(main?.type);
    }
  });

  it('every ref points at a known lexicon or shared def', () => {
    const knownNsids = new Set<string>([
      ...docs.map((d) => d.id),
      `${NSID_BASE}defs#identifier`,
      `${NSID_BASE}defs#timestamp`,
    ]);
    for (const doc of docs) {
      for (const ref of collectRefs(doc)) {
        const base = ref.split('#')[0];
        expect(knownNsids.has(base), `${doc.id} refs unknown '${ref}'`).toBe(true);
      }
    }
  });
});

describe('book lexicon', () => {
  const doc = loadLexicons().find((d) => d.id === `${NSID_BASE}book`);
  const record = (doc?.defs.main as { record: { properties: Record<string, unknown>; required?: string[] } }).record;
  const properties = record.properties;

  it('title is required', () => {
    expect(record.required).toContain('title');
  });

  it('work is a strong ref', () => {
    const work = properties.work as { type: string; ref: string; strong?: boolean };
    expect(work.type).toBe('ref');
    expect(work.ref).toBe(`${NSID_BASE}work`);
    expect(work.strong).toBe(true);
  });

  it('format is a strong ref', () => {
    const format = properties.format as { type: string; ref: string; strong?: boolean };
    expect(format.type).toBe('ref');
    expect(format.ref).toBe(`${NSID_BASE}format`);
    expect(format.strong).toBe(true);
  });

  it('genres ref the genre lexicon', () => {
    const genres = properties.genres as { items: { ref: string } };
    expect(genres.items.ref).toBe(`${NSID_BASE}genre`);
  });
});

describe('contributor lexicon', () => {
  const doc = loadLexicons().find((d) => d.id === `${NSID_BASE}contributor`);
  const properties = (doc?.defs.main as { record: { properties: Record<string, unknown> } }).record.properties;

  it('bio maxGraphemes is 16384', () => {
    const bio = properties.bio as { maxGraphemes: number };
    expect(bio.maxGraphemes).toBe(16384);
  });

  it('name is required and capped', () => {
    const name = properties.name as { maxGraphemes: number };
    expect(name.maxGraphemes).toBe(200);
  });

  it('identifiers reference the shared identifier def', () => {
    const identifiers = properties.identifiers as { items: { ref: string } };
    expect(identifiers.items.ref).toBe(`${NSID_BASE}defs#identifier`);
  });
});

describe('shared defs', () => {
  const doc = loadLexicons().find((d) => d.id === `${NSID_BASE}defs`);
  const defs = doc?.defs as Record<string, { type?: string; required?: string[] }>;

  it('identifier requires resource and url', () => {
    expect(defs.identifier.type).toBe('object');
    expect(defs.identifier.required).toEqual(['resource', 'url']);
  });

  it('timestamp is a datetime string', () => {
    expect(defs.timestamp.type).toBe('string');
    expect((defs.timestamp as { format: string }).format).toBe('datetime');
  });
});
