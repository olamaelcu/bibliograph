import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LexiconNotFound, loadLexiconSchema, loadKnownNsids } from './lexicon-resolve.js';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const LEXICON_DIR = join(PROJECT_ROOT, 'lexicons/net/olamaelcu/livtet/biblio');

function collectJsonFiles(dir: string, base: string = ''): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJsonFiles(fullPath, `${base}${entry.name}/`));
    } else if (entry.name.endsWith('.json')) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('lexicon-resolve', () => {
  const jsonFiles = collectJsonFiles(LEXICON_DIR);

  describe('loadKnownNsids', () => {
    it('returns a frozen set', () => {
      const nsids = loadKnownNsids();
      expect(Object.isFrozen(nsids)).toBe(true);
    });

    it('contains NSIDs derived from lexicons directory', () => {
      const nsids = loadKnownNsids();
      expect(nsids.size).toBeGreaterThan(0);
      expect(nsids.has('net.olamaelcu.livtet.biblio.book')).toBe(true);
    });
  });

  describe('loadLexiconSchema', () => {
    it('round-trips every lexicon JSON correctly', () => {
      for (const file of jsonFiles) {
        const content = readFileSync(file, 'utf8');
        const json = JSON.parse(content);
        const nsid = json.id as string;
        const result = loadLexiconSchema(nsid);
        expect(result.id).toBe(nsid);
        expect(result.json).toEqual(json);
        expect(result.bytes.toString('utf8')).toBe(JSON.stringify(json));
      }
    });

    it('throws LexiconNotFound for unknown NSID', () => {
      expect(() => loadLexiconSchema('net.olamaelcu.livtet.biblio.doesNotExist')).toThrow(LexiconNotFound);
    });

    it('LexiconNotFound has correct nsid property', () => {
      const unknownNsid = 'net.olamaelcu.livtet.biblio.unknown';
      try {
        loadLexiconSchema(unknownNsid);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(LexiconNotFound);
        expect((err as LexiconNotFound).nsid).toBe(unknownNsid);
      }
    });
  });
});
