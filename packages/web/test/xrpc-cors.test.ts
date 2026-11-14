import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyXrpcCors,
  withXrpcCors,
  xrpcPreflight
} from '../src/lib/server/xrpc/cors.ts';
import {
  dispatchGet,
  dispatchMethodNotAllowed,
  dispatchOptions,
  dispatchPost,
  isNsid,
  type XrpcDependencies
} from '../src/lib/server/xrpc/dispatch.ts';
import {
  DESCRIBE_FEED_GENERATOR,
  GET_FEED_SKELETON
} from '../src/lib/server/feeds/methods.ts';

/**
 * The CORS contract of `/xrpc/[...method]`.
 *
 * The route wraps every exported handler in `withXrpcCors`; these tests drive
 * the same composition over the real dispatch function with mocked handlers, so
 * every branch's response is checked for the headers, including the 400/405
 * branches and the forwarded/proxied paths.
 */

const CATALOG_GET = 'net.olamaelcu.livtet.biblio.getContributor';
const CATALOG_POST = 'community.lexicon.media.book.resolveEditions';
const CATALOG_SEARCH = 'community.lexicon.media.book.searchEditions';
const ENTITY_RESOLVE = 'net.olamaelcu.livtet.biblio.resolvePublishers';
const FORWARDED = 'app.bsky.feed.getTimeline';
const PDS_READ = 'com.atproto.repo.getRecord';
const SERVICE_DESCRIBE = 'community.lexicon.service.describe';

type Call = { handler: string; method: string };

/** The shape `dispatchGet` and `dispatchPost` share. */
type Dispatch = (
  method: string,
  request: Request,
  dependencies: XrpcDependencies
) => Response | Promise<Response>;

type Mocked = { dependencies: XrpcDependencies; calls: Call[] };

function respond(label: string, status = 200): Response {
  return new Response(JSON.stringify({ handler: label }), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function mocked(): Mocked {
  const calls: Call[] = [];
  const dependencies: XrpcDependencies = {
    serviceDescribe: () => {
      calls.push({ handler: 'serviceDescribe', method: SERVICE_DESCRIBE });
      return respond('serviceDescribe');
    },
    describeFeedGenerator: () => {
      calls.push({ handler: 'describe', method: DESCRIBE_FEED_GENERATOR });
      return respond('describe');
    },
    getFeedSkeleton: () => {
      calls.push({ handler: 'skeleton', method: GET_FEED_SKELETON });
      return respond('skeleton');
    },
    entityGet: (_request, method) => {
      calls.push({ handler: 'entityGet', method });
      return respond('entityGet');
    },
    resolveEditions: () => {
      calls.push({ handler: 'resolveEditions', method: CATALOG_POST });
      return respond('resolveEditions');
    },
    searchEditions: () => {
      calls.push({ handler: 'searchEditions', method: CATALOG_SEARCH });
      return respond('searchEditions');
    },
    entityResolve: (_request, method) => {
      calls.push({ handler: 'entityResolve', method });
      return respond('entityResolve');
    },
    proxyPdsRead: (method) => {
      calls.push({ handler: 'proxyPdsRead', method });
      return respond('proxyPdsRead');
    },
    forward: (method) => {
      calls.push({ handler: 'forward', method });
      return respond('forward');
    }
  };
  return { dependencies, calls };
}

/** Compose exactly like the route does: dispatch first, CORS wrapper second. */
async function invoke(
  dispatch: Dispatch,
  method: string
): Promise<{ response: Response; calls: Call[] }> {
  const { dependencies, calls } = mocked();
  const wrapped = withXrpcCors<{ params: { method: string } }>((event) => {
    const request = new Request(`https://edge.test/xrpc/${method}`);
    return dispatch(event.params.method, request, dependencies);
  });
  return { response: await wrapped({ params: { method } }), calls };
}

function assertCors(response: Response): void {
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('vary'), 'Origin');
  assert.equal(response.headers.get('access-control-expose-headers'), 'dpop-nonce');
}

function assertPreflight(response: Response): void {
  assert.equal(response.status, 204);
  assertCors(response);
  assert.equal(response.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS');
  const allowed = (response.headers.get('access-control-allow-headers') ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase());
  for (const header of ['content-type', 'authorization', 'dpop', 'accept']) {
    assert.ok(allowed.includes(header), `preflight must allow ${header}`);
  }
  assert.equal(response.headers.get('access-control-max-age'), '86400');
}

test('isNsid accepts the routed methods and rejects non-NSID paths', () => {
  for (const method of [
    CATALOG_GET,
    CATALOG_POST,
    ENTITY_RESOLVE,
    FORWARDED,
    PDS_READ,
    DESCRIBE_FEED_GENERATOR,
    GET_FEED_SKELETON,
    'a.b.c'
  ]) {
    assert.ok(isNsid(method), `${method} is an NSID`);
  }
  for (const method of ['', 'abc', 'com.atproto', 'com..foo', 'com/atproto/foo', '.com.foo']) {
    assert.ok(!isNsid(method), `${JSON.stringify(method)} is not an NSID`);
  }
});

test('the preflight advertises the credentials and headers the surface needs', () => {
  assertPreflight(xrpcPreflight());
});

test('every GET branch carries CORS, including forwarded and proxied reads', async () => {
  const cases: Array<{ method: string; handler: string }> = [
    { method: DESCRIBE_FEED_GENERATOR, handler: 'describe' },
    { method: GET_FEED_SKELETON, handler: 'skeleton' },
    { method: CATALOG_GET, handler: 'entityGet' },
    { method: PDS_READ, handler: 'proxyPdsRead' },
    { method: FORWARDED, handler: 'forward' }
  ];

  for (const { method, handler } of cases) {
    const { response, calls } = await invoke(dispatchGet, method);
    assertCors(response);
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [{ handler, method }]);
    assert.deepEqual(await response.json(), { handler });
  }
});

test('every POST branch carries CORS, including forwarded writes', async () => {
  const cases: Array<{ method: string; handler: string }> = [
    { method: CATALOG_POST, handler: 'resolveEditions' },
    { method: CATALOG_SEARCH, handler: 'searchEditions' },
    { method: ENTITY_RESOLVE, handler: 'entityResolve' },
    { method: FORWARDED, handler: 'forward' }
  ];

  for (const { method, handler } of cases) {
    const { response, calls } = await invoke(dispatchPost, method);
    assertCors(response);
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [{ handler, method }]);
  }
});

test('wrong-verb 405s carry CORS', async () => {
  for (const method of [
    CATALOG_POST,
    'net.olamaelcu.livtet.biblio.resolveContributors'
  ]) {
    const { response: viaGet } = await invoke(dispatchGet, method);
    assertCors(viaGet);
    assert.equal(viaGet.status, 405);
    assert.deepEqual(await viaGet.json(), { error: 'MethodNotAllowed' });
  }

  for (const method of [CATALOG_GET, 'net.olamaelcu.livtet.biblio.searchPublishers']) {
    const { response: viaPost } = await invoke(dispatchPost, method);
    assertCors(viaPost);
    assert.equal(viaPost.status, 405);
    assert.deepEqual(await viaPost.json(), { error: 'MethodNotAllowed' });
  }
});

test('method-not-allowed responses carry CORS for a valid NSID', () => {
  for (const method of [CATALOG_GET, CATALOG_POST, FORWARDED, PDS_READ]) {
    const response = applyXrpcCors(dispatchMethodNotAllowed(method));
    assertCors(response);
    assert.equal(response.status, 405);
  }
});

test('invalid NSID paths return a CORS-bearing JSON 400 on every verb', async () => {
  for (const method of ['not-an-nsid', 'com.atproto', '']) {
    const viaGet = await invoke(dispatchGet, method);
    const viaPost = await invoke(dispatchPost, method);
    for (const { response } of [viaGet, viaPost]) {
      assertCors(response);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: 'InvalidRequest' });
    }
    const options = applyXrpcCors(dispatchOptions(method));
    assertCors(options);
    assert.equal(options.status, 400);
    const other = applyXrpcCors(dispatchMethodNotAllowed(method));
    assertCors(other);
    assert.equal(other.status, 400);
    assert.deepEqual(viaGet.calls, [], 'an invalid path must not reach a handler');
    assert.deepEqual(viaPost.calls, [], 'an invalid path must not reach a handler');
  }
});

test('OPTIONS answers every valid NSID, catalog or forwarded', () => {
  for (const method of [
    CATALOG_GET,
    CATALOG_POST,
    ENTITY_RESOLVE,
    FORWARDED,
    PDS_READ,
    DESCRIBE_FEED_GENERATOR,
    GET_FEED_SKELETON
  ]) {
    assertPreflight(applyXrpcCors(dispatchOptions(method)));
  }
});

test('catalog, entity and proxy error responses keep their status and gain CORS', () => {
  const errors: Array<{ response: Response; status: number }> = [
    { response: respond('bad-request', 400), status: 400 },
    { response: respond('not-found', 404), status: 404 },
    { response: respond('upstream', 502), status: 502 },
    { response: respond('unavailable', 503), status: 503 }
  ];

  for (const { response, status } of errors) {
    const wrapped = applyXrpcCors(response);
    assertCors(wrapped);
    assert.equal(wrapped.status, status);
    assert.deepEqual(wrapped.headers.get('content-type'), 'application/json');
  }
});

test('proxied headers survive CORS and an upstream origin is not reflected', async () => {
  const upstream = new Response(JSON.stringify({ error: 'AuthRequired' }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'dpop-nonce': 'nonce-value',
      'access-control-allow-origin': 'https://livtet.example'
    }
  });

  const wrapped = applyXrpcCors(upstream);
  assertCors(wrapped);
  assert.equal(wrapped.status, 401);
  assert.equal(wrapped.headers.get('dpop-nonce'), 'nonce-value');
  assert.equal(wrapped.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await wrapped.json(), { error: 'AuthRequired' });
});

test('applying CORS twice leaves one value per header', async () => {
  const once = applyXrpcCors(respond('ok'));
  const twice = applyXrpcCors(once);
  assert.equal(twice.headers.get('access-control-allow-origin'), '*');
  assert.equal(twice.headers.get('vary'), 'Origin');
  assert.equal(twice.headers.get('access-control-expose-headers'), 'dpop-nonce');
  assert.deepEqual(await twice.json(), { handler: 'ok' });
});
