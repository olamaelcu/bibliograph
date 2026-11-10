#!/usr/bin/env tsx
// Verify the alpha `type: "space"` declarations served by the static lexicon
// publisher. @atcute/lex-cli does not model this type, so the canonical
// record/query resolver cannot validate them; this checks the CAR slices that
// `com.atproto.sync.getRecord` serves instead.
//
// Run after `mise run publish-lex`, with LEX_OUT_DIR pointing at the published
// directory.

import assert from 'node:assert/strict';
import { resolvePublishedLexicon } from '../src/lib/server/lex/resolve.js';

const NSIDS = [
  'net.olamaelcu.livtet.readingList',
  'net.olamaelcu.livtet.bookClub',
  'net.olamaelcu.livtet.clubBookmarks',
] as const;

for (const nsid of NSIDS) {
  const published = await resolvePublishedLexicon(nsid);
  assert(published, `${nsid}: no published CAR slice`);
  assert.equal(published.schema.id, nsid, `${nsid}: schema id mismatch`);
  assert.equal(
    (published.schema.defs as { main?: { type?: unknown } } | undefined)?.main
      ?.type,
    'space',
    `${nsid}: main def is not a space`,
  );
  console.log(`✓ ${nsid}`);
  console.log(`    uri: ${published.uri}`);
  console.log(`    cid: ${published.cid}`);
}

console.log(`${NSIDS.length}/${NSIDS.length} space declarations resolved.`);
