#!/usr/bin/env tsx
// Build a signed ATProto lex repository from lexicons/ JSON sources and emit CAR files.
//
// Output:
//   <OUT_DIR>/full.car                   — full repo (commit + MST + all records)
//   <OUT_DIR>/<nsid_safe>.car             — per-NSID slice (commit + MST proof + record)
//
// Usage:
//   pnpm exec tsx scripts/build-lex-repo.ts
//   pnpm exec tsx scripts/build-lex-repo.ts --out=/tmp/lex --verify
//
// Env vars:
//   LEX_PUBLISHER_HOSTNAME  (default: biblio.livtet.olamaelcu.net)
//   LEX_AUTHORITY           (default: net/olamaelcu/livtet)
//   LEX_ROOT                (default: <package>/lexicons)
//   LEX_OUT_DIR             (default: <package>/data/lex)
//   ATP_SIGNING_KEY         (required; 64 hex chars; the K-256 private scalar)

import { readFile, readdir, mkdir, writeFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Repo,
  MemoryBlockstore,
  WriteOpAction,
  blocksToCarFile,
  getRecords,
} from '@atproto/repo';
import type { RecordCreateOp } from '@atproto/repo';
import type { LexMap } from '@atproto/lex-data';
import { Secp256k1Keypair } from '@atproto/crypto';
import { TID } from '@atproto/common-web';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOSTNAME = process.env.LEX_PUBLISHER_HOSTNAME ?? 'biblio.livtet.olamaelcu.net';
const DID = `did:web:${HOSTNAME}`;
const COLLECTION = 'com.atproto.lexicon.schema' as const;
const LEX_AUTHORITY = process.env.LEX_AUTHORITY ?? 'net/olamaelcu/livtet';
const LEX_ROOT = process.env.LEX_ROOT ?? join(PACKAGE_ROOT, 'lexicons');
// The usage comment above advertises `--out=<dir>`; honor it so an exploratory
// build cannot silently overwrite the published CARs in `data/lex`.
const OUT_ARG = process.argv.find((arg) => arg.startsWith('--out='))?.slice('--out='.length);
const OUT_DIR = OUT_ARG || process.env.LEX_OUT_DIR || join(PACKAGE_ROOT, '..', '..', 'data', 'lex');
const PRIVATE_KEY_HEX = process.env.ATP_SIGNING_KEY;

function nsidFromPath(path: string): string {
  return path.replaceAll(sep, '.').replace(/\.json$/, '');
}

function safeNsid(nsid: string): string {
  return nsid.replaceAll('.', '_');
}

function lexRecordValue(nsid: string, lex: { defs?: unknown; description?: string }): LexMap {
  return {
    $type: COLLECTION,
    lexicon: 1,
    id: nsid,
    defs: lex.defs ?? { main: { type: 'record', key: 'any', record: { type: 'object', properties: {} } } },
    description: lex.description,
  };
}

async function findLexFiles(): Promise<Array<{ nsid: string; file: string; lex: { defs?: unknown; description?: string } }>> {
  // NSIDs are derived from the path relative to LEX_ROOT (not relative to LEX_AUTHORITY),
  // so a file at `lexicons/net/olamaelcu/livtet/biblio/shelf.json` becomes the NSID
  // `net.olamaelcu.livtet.biblio.shelf`. Walking is restricted to LEX_AUTHORITY
  // so we don't accidentally publish lexica outside our authority. The
  // authority includes both the bibliograph namespace and the space
  // declarations Livtet's OAuth scopes resolve.
  const baseDir = join(LEX_ROOT, LEX_AUTHORITY);
  const out: Array<{ nsid: string; file: string; lex: { defs?: unknown; description?: string } }> = [];
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith('.json')) {
        const lex = JSON.parse(await readFile(full, 'utf8')) as { defs?: unknown; description?: string };
        const nsid = nsidFromPath(relative(LEX_ROOT, full));
        out.push({ nsid, file: full, lex });
      }
    }
  }
  await walk(baseDir);
  out.sort((a, b) => a.nsid.localeCompare(b.nsid));
  return out;
}

async function loadKey(): Promise<Secp256k1Keypair> {
  if (!PRIVATE_KEY_HEX) {
    console.error('ATP_SIGNING_KEY env var not set. Run `mise run lex-keygen` first and export the value.');
    process.exit(1);
  }
  const bytes = Uint8Array.from(Buffer.from(PRIVATE_KEY_HEX, 'hex'));
  if (bytes.length !== 32) {
    console.error(`ATP_SIGNING_KEY must be 32 bytes (64 hex chars), got ${bytes.length} bytes`);
    process.exit(1);
  }
  return Secp256k1Keypair.import(bytes, { exportable: false });
}

async function buildRepo(lexFiles: Array<{ nsid: string; lex: { defs?: unknown; description?: string } }>, did: string, kp: Secp256k1Keypair) {
  const store = new MemoryBlockstore();
  const writes: RecordCreateOp[] = lexFiles.map(({ nsid, lex }) => ({
    action: WriteOpAction.Create,
    collection: COLLECTION,
    rkey: nsid,
    record: lexRecordValue(nsid, lex),
  }));
  const commit = await Repo.formatInitCommit(store, did, kp, writes);
  const carBytes = await blocksToCarFile(commit.cid, commit.newBlocks);
  return { commit, carBytes, store };
}

async function writePerRecordSlices(
  lexFiles: Array<{ nsid: string }>,
  commitCidStr: string,
  fullCar: Uint8Array,
  outDir: string,
): Promise<Map<string, Uint8Array>> {
  const { readCar, MemoryBlockstore } = await import('@atproto/repo');
  const parsed = await readCar(fullCar);
  const store = new MemoryBlockstore(parsed.blocks);
  const out = new Map<string, Uint8Array>();
  for (const { nsid } of lexFiles) {
    const stream = getRecords(store, parsed.roots[0]!, [
      { collection: COLLECTION, rkey: nsid },
    ]);
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.byteLength;
    }
    out.set(nsid, merged);
  }
  return out;
}

async function deterministicRev(lexFiles: Array<{ nsid: string; lex: { defs?: unknown; description?: string } }>): Promise<string> {
  // The served `rev` must be a valid TID: 13 chars of base32-sortable
  // (`[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}`), i.e. 63 bits
  // with the top bit clear. Hash the canonical lex set, then emit the first 8
  // digest bytes as 13 base32 chars MSB-first.
  const { createHash } = await import('node:crypto');
  const h = createHash('sha256');
  for (const { nsid, lex } of lexFiles) {
    h.update(nsid);
    h.update('\n');
    h.update(JSON.stringify({ defs: lex.defs ?? {}, description: lex.description }));
    h.update('\n');
  }
  const ALPHA = '234567abcdefghijklmnopqrstuvwxyz';
  const digest = h.digest();
  const v = digest.readBigUInt64BE(0) & 0x7fffffffffffffffn;
  let out = '';
  // First char carries the top 4 bits (63 bits = 4 + 12 * 5 bits = 13 chars).
  out += ALPHA[Number((v >> 60n) & 0x0fn)];
  for (let shift = 55n; shift >= 0n; shift -= 5n) out += ALPHA[Number((v >> shift) & 0x1fn)];
  return out;
}

async function main(): Promise<void> {
  const verify = process.argv.includes('--verify');

  console.log(`[lex-build] Reading lex files from ${join(LEX_ROOT, LEX_AUTHORITY)}`);
  const lexFiles = await findLexFiles();
  if (lexFiles.length === 0) {
    console.error(`[lex-build] No lex files found under ${join(LEX_ROOT, LEX_AUTHORITY)}`);
    process.exit(1);
  }
  console.log(`[lex-build] Found ${lexFiles.length} lex files (sorted: ${lexFiles[0]?.nsid} … ${lexFiles.at(-1)?.nsid})`);

  console.log(`[lex-build] Loading signing key for ${DID}`);
  const kp = await loadKey();

  const rev = await deterministicRev(lexFiles);
  console.log(`[lex-build] Using deterministic rev: ${rev}`);

  console.log(`[lex-build] Building signed init commit`);
  const store1 = new MemoryBlockstore();
  const writes1: RecordCreateOp[] = lexFiles.map(({ nsid, lex }) => ({
    action: WriteOpAction.Create,
    collection: COLLECTION,
    rkey: nsid,
    record: lexRecordValue(nsid, lex),
  }));
  const firstData = await Repo.formatInitCommit(store1, DID, kp, writes1, rev);
  const firstCar = await blocksToCarFile(firstData.cid, firstData.newBlocks);
  console.log(`[lex-build] commit CID: ${firstData.cid.toString()}; rev: ${firstData.rev}`);

  console.log(`[lex-build] Verifying determinism (build twice, compare bytes)`);
  const store2 = new MemoryBlockstore();
  const writes2: RecordCreateOp[] = lexFiles.map(({ nsid, lex }) => ({
    action: WriteOpAction.Create,
    collection: COLLECTION,
    rkey: nsid,
    record: lexRecordValue(nsid, lex),
  }));
  const secondData = await Repo.formatInitCommit(store2, DID, kp, writes2, rev);
  const secondCar = await blocksToCarFile(secondData.cid, secondData.newBlocks);
  if (Buffer.compare(Buffer.from(firstCar), Buffer.from(secondCar)) !== 0) {
    console.error('[lex-build] DETERMINISM FAILURE: two builds of the same inputs produced different CAR bytes.');
    console.error('  This means record-insertion order or MST shape derivation is non-deterministic.');
    process.exit(2);
  }
  console.log('[lex-build] determinism OK');

  console.log(`[lex-build] Writing full.car and per-NSID slices to ${OUT_DIR}`);
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, 'full.car'), firstCar);

  const slices = await writePerRecordSlices(lexFiles, firstData.cid.toString(), firstCar, OUT_DIR);
  for (const [nsid, bytes] of slices) {
    await writeFile(join(OUT_DIR, `${safeNsid(nsid)}.car`), bytes);
  }
  console.log(`[lex-build] Wrote ${slices.size} per-NSID CAR files + full.car (${firstCar.byteLength} bytes)`);

  if (verify) {
    console.log('[lex-build] --verify: re-running build and comparing against on-disk artifacts');
    const store3 = new MemoryBlockstore();
    const writes3: RecordCreateOp[] = lexFiles.map(({ nsid, lex }) => ({
      action: WriteOpAction.Create,
      collection: COLLECTION,
      rkey: nsid,
      record: lexRecordValue(nsid, lex),
    }));
    const thirdData = await Repo.formatInitCommit(store3, DID, kp, writes3, rev);
    const thirdCar = await blocksToCarFile(thirdData.cid, thirdData.newBlocks);
    const onDisk = await readFile(join(OUT_DIR, 'full.car'));
    if (Buffer.compare(Buffer.from(thirdCar), onDisk) !== 0) {
      console.error('[lex-build] --verify FAILURE: on-disk full.car does not match a fresh build.');
      process.exit(3);
    }
    console.log('[lex-build] --verify OK');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
