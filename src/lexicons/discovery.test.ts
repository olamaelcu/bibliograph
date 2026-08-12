import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverEndpoints, loadDescriptions, _resetForTests } from './discovery.js';

function writeLex(dir: string, segments: string[], body: string | object): void {
  const full = join(dir, ...segments);
  mkdirSync(join(full, '..'), { recursive: true });
  const content = typeof body === 'string' ? body : JSON.stringify(body);
  writeFileSync(full, content);
}

describe('lexicons/discovery', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lex-discovery-'));
    _resetForTests();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('groups lex files by defs.main.type', () => {
    writeLex(dir, ['community', 'lexicon', 'book', 'a-query.json'], {
      lexicon: 1,
      id: 'community.lexicon.book.aQuery',
      defs: { main: { type: 'query' } },
    });
    writeLex(dir, ['community', 'lexicon', 'book', 'a-proc.json'], {
      lexicon: 1,
      id: 'community.lexicon.book.aProc',
      defs: { main: { type: 'procedure' } },
    });
    writeLex(dir, ['community', 'lexicon', 'book', 'a-record.json'], {
      lexicon: 1,
      id: 'community.lexicon.book.aRecord',
      defs: { main: { type: 'record' } },
    });

    const idx = discoverEndpoints('community.lexicon.book', undefined, dir);

    expect(idx.queries.map((e) => e.nsid)).toEqual(['community.lexicon.book.aQuery']);
    expect(idx.procedures.map((e) => e.nsid)).toEqual(['community.lexicon.book.aProc']);
    expect(idx.records.map((e) => e.nsid)).toEqual(['community.lexicon.book.aRecord']);
    expect(idx.subscriptions).toEqual([]);
    expect(idx.tokens).toEqual([]);
  });

  it('filters lex files to the requested nsPrefix', () => {
    writeLex(dir, ['community', 'lexicon', 'book', 'a.json'], {
      lexicon: 1,
      id: 'community.lexicon.book.a',
      defs: { main: { type: 'query' } },
    });
    writeLex(dir, ['community', 'lexicon', 'other', 'b.json'], {
      lexicon: 1,
      id: 'community.lexicon.other.b',
      defs: { main: { type: 'query' } },
    });

    const idx = discoverEndpoints('community.lexicon.book', undefined, dir);

    expect(idx.queries.map((e) => e.nsid)).toEqual(['community.lexicon.book.a']);
  });

  it('walks subdirectories', () => {
    writeLex(dir, ['community', 'lexicon', 'book', 'sub', 'deep.json'], {
      lexicon: 1,
      id: 'community.lexicon.book.sub.deep',
      defs: { main: { type: 'query' } },
    });

    const idx = discoverEndpoints('community.lexicon.book', undefined, dir);

    expect(idx.queries.map((e) => e.nsid)).toEqual(['community.lexicon.book.sub.deep']);
  });

  it('skips _-prefixed sidecar files', () => {
    writeLex(dir, ['community', 'lexicon', 'book', '_descriptions.json'], {
      'community.lexicon.book.a': 'this is not a lex',
    });
    writeLex(dir, ['community', 'lexicon', 'book', 'a.json'], {
      lexicon: 1,
      id: 'community.lexicon.book.a',
      defs: { main: { type: 'query' } },
    });

    const idx = discoverEndpoints('community.lexicon.book', undefined, dir);

    expect(idx.queries.map((e) => e.nsid)).toEqual(['community.lexicon.book.a']);
  });

  it('skips the shared defs.json', () => {
    writeLex(dir, ['community', 'lexicon', 'book', 'defs.json'], {
      lexicon: 1,
      id: 'community.lexicon.book.defs',
      defs: {
        bookRef: { type: 'object', properties: {} },
        identifier: { type: 'object', properties: {} },
      },
    });
    writeLex(dir, ['community', 'lexicon', 'book', 'a.json'], {
      lexicon: 1,
      id: 'community.lexicon.book.a',
      defs: { main: { type: 'query' } },
    });

    const idx = discoverEndpoints('community.lexicon.book', undefined, dir);

    expect(idx.queries.map((e) => e.nsid)).toEqual(['community.lexicon.book.a']);
  });

  it('ignores files that are not lex documents', () => {
    writeLex(dir, ['community', 'lexicon', 'book', 'broken.json'], '{not json');
    writeLex(dir, ['community', 'lexicon', 'book', 'noMain.json'], {
      lexicon: 1,
      id: 'community.lexicon.book.noMain',
      defs: { secondary: { type: 'object' } },
    });

    const idx = discoverEndpoints('community.lexicon.book', undefined, dir);

    expect(idx.queries).toEqual([]);
  });

  it('ignores lex files with unknown type', () => {
    writeLex(dir, ['community', 'lexicon', 'book', 'weird.json'], {
      lexicon: 1,
      id: 'community.lexicon.book.weird',
      defs: { main: { type: 'mystery' } },
    });

    const idx = discoverEndpoints('community.lexicon.book', undefined, dir);

    expect(idx.byNsid.size).toBe(0);
  });

  it('sorts each bucket alphabetically by NSID', () => {
    const ids = ['zeta', 'alpha', 'mike', 'bravo'];
    for (const id of ids) {
      writeLex(dir, ['community', 'lexicon', 'book', `${id}.json`], {
        lexicon: 1,
        id: `community.lexicon.book.${id}`,
        defs: { main: { type: 'query' } },
      });
    }

    const idx = discoverEndpoints('community.lexicon.book', undefined, dir);

    expect(idx.queries.map((e) => e.nsid)).toEqual([
      'community.lexicon.book.alpha',
      'community.lexicon.book.bravo',
      'community.lexicon.book.mike',
      'community.lexicon.book.zeta',
    ]);
  });

  it('attaches descriptions from the descriptions map', () => {
    writeLex(dir, ['community', 'lexicon', 'book', 'a.json'], {
      lexicon: 1,
      id: 'community.lexicon.book.a',
      defs: { main: { type: 'query' } },
    });

    const idx = discoverEndpoints(
      'community.lexicon.book',
      { 'community.lexicon.book.a': 'A short summary.' },
      dir,
    );

    expect(idx.queries[0].description).toBe('A short summary.');
  });

  it('memoizes across calls with the same arguments', () => {
    writeLex(dir, ['community', 'lexicon', 'book', 'a.json'], {
      lexicon: 1,
      id: 'community.lexicon.book.a',
      defs: { main: { type: 'query' } },
    });

    const first = discoverEndpoints('community.lexicon.book', undefined, dir);
    const second = discoverEndpoints('community.lexicon.book', undefined, dir);

    expect(second).toBe(first);
  });

  it('returns empty buckets when the namespace directory is missing', () => {
    const idx = discoverEndpoints('community.lexicon.book', undefined, dir);

    expect(idx.queries).toEqual([]);
    expect(idx.procedures).toEqual([]);
    expect(idx.records).toEqual([]);
  });

  it('exposes a byNsid lookup map', () => {
    writeLex(dir, ['community', 'lexicon', 'book', 'a.json'], {
      lexicon: 1,
      id: 'community.lexicon.book.a',
      defs: { main: { type: 'query' } },
    });

    const idx = discoverEndpoints('community.lexicon.book', undefined, dir);

    expect(idx.byNsid.get('community.lexicon.book.a')?.type).toBe('query');
    expect(idx.byNsid.get('community.lexicon.book.nope')).toBeUndefined();
  });
});

describe('lexicons/discovery loadDescriptions', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lex-desc-'));
    _resetForTests();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns parsed descriptions from the sidecar file', () => {
    mkdirSync(join(dir, 'community', 'lexicon', 'book'), { recursive: true });
    writeFileSync(
      join(dir, 'community', 'lexicon', 'book', '_descriptions.json'),
      JSON.stringify({ 'community.lexicon.book.get': 'Fetch a single book' }),
    );

    const descriptions = loadDescriptions('community.lexicon.book', dir);

    expect(descriptions['community.lexicon.book.get']).toBe('Fetch a single book');
  });

  it('returns an empty object when the sidecar file is missing', () => {
    const descriptions = loadDescriptions('community.lexicon.book', dir);

    expect(descriptions).toEqual({});
  });

  it('returns an empty object when the sidecar file is malformed', () => {
    mkdirSync(join(dir, 'community', 'lexicon', 'book'), { recursive: true });
    writeFileSync(
      join(dir, 'community', 'lexicon', 'book', '_descriptions.json'),
      '{not json',
    );

    const descriptions = loadDescriptions('community.lexicon.book', dir);

    expect(descriptions).toEqual({});
  });
});
