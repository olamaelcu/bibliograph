// Runtime helpers for the static-file lex publisher.
//
// Reads prebuilt CAR files from disk and serves them verbatim. The build
// step (`pnpm exec tsx scripts/build-lex-repo.ts`) regenerates these files
// on every lex publish; the serving path does no MST walking or signing.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const LEX_COLLECTION = 'com.atproto.lexicon.schema';
export const LEX_DIR = process.env.LEX_OUT_DIR ?? join(process.cwd(), 'data', 'lex');

export function safeNsid(nsid: string): string {
  return nsid.replaceAll('.', '_');
}

export function lexFilePath(nsid: string): string {
  return join(LEX_DIR, `${safeNsid(nsid)}.car`);
}

export function fullRepoPath(): string {
  return join(LEX_DIR, 'full.car');
}

export interface LexLookup {
  body: Uint8Array;
  contentType: 'application/vnd.ipld.car';
}

export async function readPerRecordCar(nsid: string): Promise<LexLookup | null> {
  const path = lexFilePath(nsid);
  try {
    const bytes = await readFile(path);
    return { body: bytes, contentType: 'application/vnd.ipld.car' };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function readFullRepoCar(): Promise<LexLookup | null> {
  try {
    const bytes = await readFile(fullRepoPath());
    return { body: bytes, contentType: 'application/vnd.ipld.car' };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export interface ResolvedIdentity {
  did: string;
  handle: string;
}

export function resolveHandle(handle: string): ResolvedIdentity | null {
  const expected = process.env.LEX_PUBLISHER_HANDLE ?? 'biblio.livtet.olamaelcu.net';
  if (handle.toLowerCase() !== expected.toLowerCase()) return null;
  return {
    did: process.env.LEX_PUBLISHER_DID ?? `did:web:${expected}`,
    handle: expected,
  };
}

export function resolveDid(did: string): ResolvedIdentity | null {
  const expected = process.env.LEX_PUBLISHER_DID ?? `did:web:${process.env.LEX_PUBLISHER_HANDLE ?? 'biblio.livtet.olamaelcu.net'}`;
  if (did !== expected) return null;
  return {
    did: expected,
    handle: process.env.LEX_PUBLISHER_HANDLE ?? 'biblio.livtet.olamaelcu.net',
  };
}
