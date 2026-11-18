/**
 * Every method the edge calls or matches must be spelled exactly as its lexicon
 * document spells it.
 *
 * `dispatchPost` compares the request's method against `RESOLVE_EDITIONS` /
 * `SEARCH_EDITIONS`; anything it does not match is forwarded to HappyView, which
 * answers 401 to a procedure without DPoP. The same holds for the HappyView NRPC
 * ids in `entity-methods.ts`: a wrong spelling reaches a method that does not
 * exist. A storage rename rewrote all of these string literals, took
 * `searchEditions` off the edge and made it answer 401, and pointed two catalog
 * reads at NRPC methods HappyView does not serve — the surface test did not
 * catch either, because the described surface is built from the lexicon catalog
 * rather than from these constants.
 */

import { expect, test } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';

import * as entityMethods from '../src/lib/server/catalog/entity-methods.ts';
import {
  RESOLVE_EDITIONS,
  SEARCH_EDITIONS
} from '../src/lib/server/catalog/entity-methods.ts';
import {
  dispatchGet,
  dispatchPost,
  type XrpcDependencies
} from '../src/lib/server/xrpc/dispatch.ts';

const BOOK_LEXICONS = new URL(
  '../../../happyview/lexicons/community/lexicon/media/book/',
  import.meta.url
);
const BIBLIO_LEXICONS = new URL(
  '../../../happyview/lexicons/net/olamaelcu/livtet/biblio/',
  import.meta.url
);

async function lexiconId(name: string): Promise<string> {
  const document = JSON.parse(await readFile(new URL(`${name}.json`, BOOK_LEXICONS), 'utf8'));
  return document.id;
}

async function biblioIds(): Promise<Set<string>> {
  const files = await readdir(BIBLIO_LEXICONS, { recursive: true });
  const ids = new Set<string>();
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const document = JSON.parse(await readFile(new URL(file, BIBLIO_LEXICONS), 'utf8'));
    if (typeof document.id === 'string') ids.add(document.id);
  }
  return ids;
}

function dependencies(calls: string[]): XrpcDependencies {
  const respond = () => new Response('ok', { status: 200 });
  return {
    serviceDescribe: respond,
    describeFeedGenerator: respond,
    getFeedSkeleton: respond,
    entityGet: respond,
    resolveEditions: () => {
      calls.push('resolveEditions');
      return respond();
    },
    searchEditions: () => {
      calls.push('searchEditions');
      return respond();
    },
    proxyPdsRead: respond,
    forward: () => {
      calls.push('forward');
      return respond();
    }
  };
}

test('the local procedure constants are the lexicon ids', async () => {
  expect(RESOLVE_EDITIONS).toBe(await lexiconId('resolveEditions'));
  expect(SEARCH_EDITIONS).toBe(await lexiconId('searchEditions'));
});

test('every HappyView method constant is a lexicon id', async () => {
  const ids = await biblioIds();
  const constants = Object.entries(entityMethods).filter(
    ([, value]) =>
      typeof value === 'string' && value.startsWith('net.olamaelcu.livtet.biblio.')
  );
  expect(constants.length).toBeGreaterThan(0);
  for (const [name, value] of constants) {
    expect(ids.has(value as string), `${name} = ${String(value)} is not a lexicon id`).toBe(true);
  }
});

test('each local procedure is handled at the edge, never forwarded', async () => {
  const calls: string[] = [];
  const request = () => new Request('https://example.test/xrpc', { method: 'POST' });

  expect((await dispatchPost(RESOLVE_EDITIONS, request(), dependencies(calls))).status).toBe(200);
  expect(calls).toEqual(['resolveEditions']);

  calls.length = 0;
  expect((await dispatchPost(SEARCH_EDITIONS, request(), dependencies(calls))).status).toBe(200);
  expect(calls).toEqual(['searchEditions']);
});

test('a local procedure is POST-only', () => {
  const calls: string[] = [];
  const request = new Request('https://example.test/xrpc');
  for (const method of [RESOLVE_EDITIONS, SEARCH_EDITIONS]) {
    expect(dispatchGet(method, request, dependencies(calls)).status).toBe(405);
  }
  expect(calls).toEqual([]);
});
