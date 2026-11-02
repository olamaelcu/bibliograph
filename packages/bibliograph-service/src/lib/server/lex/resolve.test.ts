import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryBlockstore, Repo, WriteOpAction, blocksToCarFile } from '@atproto/repo';
import type { RecordCreateOp } from '@atproto/repo';
import { Secp256k1Keypair } from '@atproto/crypto';
import { cidForLex } from '@atproto/lex-cbor';
import type { LexMap } from '@atproto/lex-data';
import { LEX_COLLECTION } from './publisher';
import { decodeSchemaSlice, resolvePublishedLexicon } from './resolve';

const DID = 'did:web:biblio.test';
const NSID = 'net.olamaelcu.livtet.biblio.shelf';
const OTHER_NSID = 'net.olamaelcu.livtet.biblio.getShelf';
const LEXICON = { lexicon: 1, id: NSID, defs: { main: { type: 'record', key: 'any' } } };

function schemaRecord(nsid: string): LexMap {
  return { $type: LEX_COLLECTION, lexicon: 1, id: nsid, defs: { main: { type: 'record', key: 'any' } } };
}

/** A signed repo whose commit + records are exactly what build-lex-repo.ts emits. */
async function buildRepo(writes: RecordCreateOp[]): Promise<Uint8Array> {
  const keypair = await Secp256k1Keypair.create();
  const store = new MemoryBlockstore();
  const commit = await Repo.formatInitCommit(store, DID, keypair, writes);
  return blocksToCarFile(commit.cid, commit.newBlocks);
}

function schemaWrite(rkey: string, value: LexMap): RecordCreateOp {
  return { action: WriteOpAction.Create, collection: LEX_COLLECTION, rkey, record: value };
}

test('a published schema resolves to its at-uri, record CID, and record value', async () => {
  const car = await buildRepo([schemaWrite(NSID, schemaRecord(NSID))]);
  const resolved = await decodeSchemaSlice(car, NSID);

  assert.ok(resolved, 'expected the slice to resolve');
  assert.equal(resolved.uri, `at://${DID}/${LEX_COLLECTION}/${NSID}`);
  assert.deepEqual(resolved.schema, {
    $type: LEX_COLLECTION,
    lexicon: 1,
    id: NSID,
    defs: LEXICON.defs,
  });
  // The CID must be the record's own block, not the commit's.
  assert.equal(resolved.cid, (await cidForLex(resolved.schema)).toString());
});

test('an NSID the repo does not publish resolves to null', async () => {
  const car = await buildRepo([schemaWrite(NSID, schemaRecord(NSID))]);
  assert.equal(await decodeSchemaSlice(car, OTHER_NSID), null);
});

test('a record whose id disagrees with the requested NSID is not a proof of it', async () => {
  // A slice can be asked for rkey X while carrying a record that names Y: the
  // resolver trusts the record's own `id`, so this must not resolve X.
  const car = await buildRepo([schemaWrite(NSID, schemaRecord(OTHER_NSID))]);
  assert.equal(await decodeSchemaSlice(car, NSID), null);
});

test('bytes that are not a CAR resolve to null instead of throwing', async () => {
  assert.equal(await decodeSchemaSlice(new Uint8Array([1, 2, 3, 4]), NSID), null);
});

test('resolvePublishedLexicon resolves through the injected slice reader', async () => {
  const car = await buildRepo([schemaWrite(NSID, schemaRecord(NSID))]);
  const resolved = await resolvePublishedLexicon(NSID, async () => ({ body: car }));
  assert.equal(resolved?.uri, `at://${DID}/${LEX_COLLECTION}/${NSID}`);
});

test('resolvePublishedLexicon reports a missing slice as unresolved', async () => {
  assert.equal(await resolvePublishedLexicon(NSID, async () => null), null);
});
