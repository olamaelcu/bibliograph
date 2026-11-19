import { expect, test } from 'vitest';

import { readdir } from 'node:fs/promises';

import {
  EDGE_PROCEDURES,
  ENTITY_QUERIES
} from '../src/lib/server/catalog/entity-methods.ts';
import {
  DESCRIBE_FEED_GENERATOR,
  GET_FEED_SKELETON
} from '../src/lib/server/feeds/methods.ts';
import { PDS_READS } from '../src/lib/server/pds-methods.ts';
import {
  dispatchGet,
  dispatchPost,
  type XrpcDependencies
} from '../src/lib/server/xrpc/dispatch.ts';
import {
  FORWARDED_PROCEDURES,
  FORWARDED_QUERIES,
  SERVICE_DESCRIBE,
  describeService,
  serviceMethods
} from '../src/lib/server/xrpc/surface.ts';

/**
 * `community.lexicon.service.describe` must not lie.
 *
 * The description is a literal list, so these tests are the binding: the two
 * forwarded lists are held to the Lua scripts `hv-deploy` uploads, and the
 * whole list is held to the registries the dispatch classifies against. A
 * method added to one of those places and not the other fails here.
 */

const NSID = /^[a-zA-Z][a-zA-Z0-9-]{0,62}(\.[a-zA-Z0-9-]{1,63})+\.[a-zA-Z][a-zA-Z0-9-]{0,62}$/;

/** The NSIDs of the uploaded scripts, without the `.lua` suffix. */
async function uploaded(kind: 'query' | 'procedure'): Promise<string[]> {
  const directory = new URL(`../../../happyview/scripts/xrpc/${kind}/`, import.meta.url);
  const files = await readdir(directory);
  return files
    .filter((file) => file.endsWith('.lua'))
    .map((file) => file.slice(0, -'.lua'.length));
}

/** Records which handler answered, so a misroute cannot pass silently. */
function mocked(): { dependencies: XrpcDependencies; calls: string[] } {
  const calls: string[] = [];
  const respond = (handler: string) => {
    calls.push(handler);
    return new Response(JSON.stringify({ handler }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  const record =
    (handler: string) =>
    (): Response =>
      respond(handler);

  const dependencies: XrpcDependencies = {
    serviceDescribe: record('serviceDescribe'),
    describeFeedGenerator: record('describeFeedGenerator'),
    getFeedSkeleton: record('getFeedSkeleton'),
    entityGet: record('entityGet'),
    resolveEditions: record('resolveEditions'),
    searchEditions: record('searchEditions'),
    giveawayDraw: record('giveawayDraw'),
    giveawayExtend: record('giveawayExtend'),
    proxyPdsRead: record('proxyPdsRead'),
    forward: record('forward')
  };
  return { dependencies, calls };
}

test('the forwarded lists match the scripts hv-deploy uploads', async () => {
  expect([...(await uploaded('query'))].sort(), 'scripts/xrpc/query/ and FORWARDED_QUERIES disagree').toEqual([...FORWARDED_QUERIES].sort());
  expect([...(await uploaded('procedure'))].sort(), 'scripts/xrpc/procedure/ and FORWARDED_PROCEDURES disagree').toEqual([...FORWARDED_PROCEDURES].sort());
});

test('the described surface is exactly the registries it is built from', () => {
  const expected = new Set([
    SERVICE_DESCRIBE,
    DESCRIBE_FEED_GENERATOR,
    GET_FEED_SKELETON,
    ...EDGE_PROCEDURES,
    ...ENTITY_QUERIES,
    ...PDS_READS,
    ...FORWARDED_QUERIES,
    ...FORWARDED_PROCEDURES
  ]);
  expect(serviceMethods()).toEqual([...expected].sort());
  expect(serviceMethods().length).toBe(58);
});

test('every described method is a valid NSID, listed once', () => {
  const methods = serviceMethods();
  expect(new Set(methods).size, 'a method is listed twice').toBe(methods.length);
  for (const method of methods) expect(method).toMatch(NSID);
});

test('describeService uses the rsky shape', () => {
  const described = describeService();
  expect(described.roles).toEqual(['appview', 'feedgen']);
  expect(described.methods.length).toBe(serviceMethods().length);
  for (const entry of described.methods) {
    expect(entry.$type).toBe('community.lexicon.service.describe#nsid');
    expect(typeof entry.value).toBe('string');
  }
  expect(described.methods.map((entry) => entry.value)).toEqual(serviceMethods());
});

test('describe answers GET through its own handler only', async () => {
  const { dependencies, calls } = mocked();
  const response = await dispatchGet(SERVICE_DESCRIBE, new Request('https://edge.test/'), dependencies);
  expect(response.status).toBe(200);
  expect((await response.json()).handler).toBe('serviceDescribe');
  expect(calls).toEqual(['serviceDescribe']);
});

test('describe is GET-only', async () => {
  const { dependencies, calls } = mocked();
  const response = await dispatchPost(
    SERVICE_DESCRIBE,
    new Request('https://edge.test/', { method: 'POST' }),
    dependencies
  );
  expect(response.status).toBe(405);
  expect(await response.json()).toEqual({ error: 'MethodNotAllowed' });
  expect(calls).toEqual([]);
});
