// Resolve an NSID to the schema record this host publishes.
//
// The lexicon repo is built ahead of time (`scripts/build-lex-repo.ts`) and
// served as static CAR slices; the very same files back
// `com.atproto.sync.getRecord`. Resolution therefore reads the slice for the
// requested NSID and decodes the one record in it — no network, and no second
// source of truth that could disagree with what `getRecord` hands out.
//
// Scope: this host publishes exactly the lexicons under its own authority
// (`lexicons/net/olamaelcu/livtet/biblio` etc). Foreign NSIDs are resolved by
// their own authority's DNS/publisher chain, not by asking us, so they answer
// `LexiconNotFound` here rather than proxying a request to a third party.

import { readCar, parseObjByDef, def } from '@atproto/repo';
import { decode as cborDecode } from '@atproto/lex-cbor';
import type { LexMap, LexValue } from '@atproto/lex-data';
import { LEX_COLLECTION, readPerRecordCar } from './publisher';
import { createLogger } from '../logger';

const log = createLogger('web');

export interface PublishedLexicon {
  /** `at://<publisher did>/com.atproto.lexicon.schema/<nsid>` */
  uri: string;
  /** CID of the schema record — the block the repo's MST points at. */
  cid: string;
  /** The record value: the lexicon document itself. */
  schema: Record<string, unknown>;
}

/**
 * A schema record names itself: the lexicon document carries `id`, and that is
 * what a resolver must match on. The rkey and the `id` inside the record are
 * written from the same NSID, so a mismatch means the slice does not prove the
 * NSID it was asked about.
 */
function isSchemaRecord(value: LexValue, nsid: string): value is LexMap {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as LexMap;
  return record.$type === LEX_COLLECTION && record.id === nsid;
}

/**
 * Decode one per-NSID CAR slice and return the schema record it carries.
 *
 * `null` covers every way a slice can fail to answer: unreadable bytes, no
 * commit root, or no record for this NSID — the caller turns that into
 * `LexiconNotFound`, because the honest answer is that this host does not
 * publish a schema under that name.
 */
export async function decodeSchemaSlice(car: Uint8Array, nsid: string): Promise<PublishedLexicon | null> {
  let parsed;
  try {
    parsed = await readCar(car);
  } catch (err) {
    log.warn({ err, nsid }, 'resolveLexicon: CAR slice did not parse');
    return null;
  }
  // The slice is `commit + MST proof + record`; the commit names the repo the
  // record belongs to, so the at-uri is read from it instead of from config.
  const commitCid = parsed.roots[0];
  const commitBytes = commitCid ? parsed.blocks.get(commitCid) : undefined;
  if (!commitCid || !commitBytes) {
    log.warn({ nsid }, 'resolveLexicon: CAR slice has no commit root');
    return null;
  }
  const { obj: commit } = parseObjByDef(commitBytes, commitCid, def.commit);

  for (const [cid, bytes] of parsed.blocks) {
    let value: LexValue;
    try {
      value = cborDecode(bytes);
    } catch {
      continue;
    }
    if (!isSchemaRecord(value, nsid)) continue;
    return { uri: `at://${commit.did}/${LEX_COLLECTION}/${nsid}`, cid: cid.toString(), schema: value };
  }
  return null;
}

/**
 * Resolve `nsid` against the lex repo this host serves. `read` is the slice
 * reader — injected so tests can resolve without a populated `LEX_OUT_DIR`.
 */
export async function resolvePublishedLexicon(
  nsid: string,
  read: (nsid: string) => Promise<{ body: Uint8Array } | null> = readPerRecordCar,
): Promise<PublishedLexicon | null> {
  const slice = await read(nsid);
  if (!slice) return null;
  return decodeSchemaSlice(slice.body, nsid);
}
