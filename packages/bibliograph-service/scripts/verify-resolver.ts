#!/usr/bin/env tsx
// End-to-end verification: ask the canonical ATProto lexicon resolver to fetch
// every lex schema we publish. Walks lexicons/net/olamaelcu/livtet/biblio/*.json
// as the source of truth.
//
// Exits 1 if any NSID fails to resolve.
//
// Run after `mise run lex-build` (or before any rsync to prod).

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LexiconSchemaResolver } from '@atcute/lexicon-resolver';
import { AtprotoWebDidDocumentResolver } from '@atcute/identity-resolver';

const DID = 'did:web:biblio.livtet.olamaelcu.net';
const AUTHORITY = 'net/olamaelcu/livtet/biblio';
const LEX_ROOT = process.env.LEX_ROOT ?? 'lexicons';
const LEX_DIR = join(LEX_ROOT, AUTHORITY);

(async () => {
  const entries = await readdir(LEX_DIR);
  // NSIDs come from the directory path + filename, not just the filename.
  // e.g. `lexicons/net/olamaelcu/livtet/biblio/shelf.json` → `net.olamaelcu.livtet.biblio.shelf`.
  const nsids = entries
    .filter((e) => e.endsWith('.json'))
    .map((e) => `${AUTHORITY.replaceAll('/', '.')}.${e.replace(/\.json$/, '')}`)
    .sort();
  if (nsids.length === 0) {
    console.error(`No lex files found under ${LEX_DIR}`);
    process.exit(1);
  }
  console.log(`Verifying ${nsids.length} NSIDs via @atcute/lexicon-resolver…\n`);

  const resolver = new LexiconSchemaResolver({
    didDocumentResolver: new AtprotoWebDidDocumentResolver(),
  });

  let failed = 0;
  for (const nsid of nsids) {
    try {
      const result = await resolver.resolve(
        DID as `did:${string}:${string}`,
        nsid as `${string}.${string}.${string}.${string}.${string}`,
      );
      const defs = Object.keys(result.rawSchema.defs ?? {}).join(', ');
      console.log(`✓ ${nsid}`);
      console.log(`    uri: ${result.uri}`);
      console.log(`    cid: ${result.cid.toString()}`);
      console.log(`    defs: ${defs}`);
    } catch (err) {
      console.error(`✗ ${nsid}: ${(err as Error).message}`);
      failed++;
    }
  }
  console.log();
  if (failed > 0) {
    console.error(`${failed}/${nsids.length} lexica failed canonical-resolver verification.`);
    process.exit(1);
  }
  console.log(`${nsids.length}/${nsids.length} lexica resolved successfully.`);
})();