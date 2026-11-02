import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Secp256k1Keypair } from '@atproto/crypto';
import type { ServiceJwtVerifier } from '@atcute/xrpc-server/auth';
import type { DidDocumentResolver } from '@atcute/identity-resolver';
import type { Did, Nsid } from '@atcute/lexicons';
import type { AtprotoAudience } from '@atcute/lexicons/syntax';
import { PUBLISHER_DID } from '../did';
import { createFeedAuthVerifier, requireFeedAuth } from './feed-auth';
import { createInMemoryReplayStore } from './replay-store';

const VIEWER_DID: Did = 'did:plc:viewer';
const LXM: Nsid = 'com.atproto.feed.getFeedSkeleton';
const FEED_AUDIENCE = `${PUBLISHER_DID}#atproto_feed` as AtprotoAudience;

/** The document shape the resolver hands back; the library owns the type. */
type ResolvedDocument = Awaited<ReturnType<DidDocumentResolver['resolve']>>;

const keypair = await Secp256k1Keypair.create();

/** A DID document carrying the fixture key, so nothing is resolved over the network. */
const viewerDocument = {
  id: VIEWER_DID,
  verificationMethod: [
    {
      id: '#atproto',
      type: 'Multikey',
      controller: VIEWER_DID,
      publicKeyMultibase: keypair.did().replace('did:key:', ''),
    },
  ],
};

const fixtureResolver: DidDocumentResolver = {
  async resolve(did) {
    if (did === VIEWER_DID) return viewerDocument as unknown as ResolvedDocument;
    throw new Error(`no document for ${did}`);
  },
};

function verifier(): ServiceJwtVerifier {
  return createFeedAuthVerifier({
    resolver: fixtureResolver,
    replayStore: createInMemoryReplayStore(),
  });
}

async function mintJwt(
  options: {
    aud?: Did | AtprotoAudience;
    lxm?: Nsid;
    issuedAt?: number;
    expiresIn?: number;
    issuer?: Did;
  } = {},
): Promise<string> {
  const encoder = new TextEncoder();
  const issuedAt = options.issuedAt ?? Math.floor(Date.now() / 1_000);
  const claims = {
    iss: options.issuer ?? VIEWER_DID,
    aud: options.aud ?? FEED_AUDIENCE,
    lxm: options.lxm ?? LXM,
    iat: issuedAt,
    exp: issuedAt + (options.expiresIn ?? 60),
    jti: randomBytes(12).toString('base64url'),
  };
  // Same envelope the PDS emits from `com.atproto.server.getServiceAuth`:
  // header/payload base64url, ES256K signature over them.
  const signingInput = [
    { typ: 'JWT', alg: keypair.jwtAlg },
    claims,
  ]
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
    .join('.');
  const signature = await keypair.sign(encoder.encode(signingInput));
  return `${signingInput}.${Buffer.from(signature).toString('base64url')}`;
}

function feedRequest(token?: string): Request {
  return new Request('https://biblio.livtet.olamaelcu.net/xrpc/com.atproto.feed.getFeedSkeleton', {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

/**
 * The verifier reports every failure as an `AuthRequiredError` whose precise
 * cause rides the `WWW-Authenticate` challenge (`Bearer error="..."`), not the
 * error body.
 */
function challengeCode(err: unknown): string | null {
  if (!err || typeof err !== 'object' || !('headers' in err)) return null;
  const headers = err.headers;
  if (!(headers instanceof Headers)) return null;
  return /error="([^"]+)"/.exec(headers.get('www-authenticate') ?? '')?.[1] ?? null;
}

async function assertChallenge(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (err: unknown) => challengeCode(err) === code);
}

test('accepts a token minted by a user PDS and returns that DID', async () => {
  const token = await mintJwt();
  const result = await verifier().verifyRequest(feedRequest(token), { lxm: LXM });
  assert.equal(result.issuer, VIEWER_DID);
  assert.equal(result.audience, FEED_AUDIENCE);
  assert.equal(result.lxm, LXM);
});

test('accepts the bare publisher DID as an audience', async () => {
  const token = await mintJwt({ aud: PUBLISHER_DID as Did });
  const result = await verifier().verifyRequest(feedRequest(token), { lxm: LXM });
  assert.equal(result.issuer, VIEWER_DID);
});

test('rejects a token minted for another service', async () => {
  const token = await mintJwt({ aud: 'did:web:elsewhere.example#atproto_feed' as AtprotoAudience });
  await assertChallenge(verifier().verifyRequest(feedRequest(token), { lxm: LXM }), 'InvalidAudience');
});

test('rejects a token bound to a different endpoint', async () => {
  const token = await mintJwt({ lxm: 'net.olamaelcu.livtet.biblio.follow' });
  await assertChallenge(
    verifier().verifyRequest(feedRequest(token), { lxm: LXM }),
    'BadJwtLexiconMethod',
  );
});

test('rejects an expired token', async () => {
  // Minted in the past with a short life: `iat < exp < now`, which is what a
  // token that simply aged out looks like (the parser rejects `exp < iat`).
  const now = Math.floor(Date.now() / 1_000);
  const token = await mintJwt({ issuedAt: now - 600, expiresIn: 60 });
  await assertChallenge(verifier().verifyRequest(feedRequest(token), { lxm: LXM }), 'JwtExpired');
});

test('rejects a token whose lifetime exceeds the verifier window', async () => {
  const token = await mintJwt({ expiresIn: 3_600 });
  await assertChallenge(verifier().verifyRequest(feedRequest(token), { lxm: LXM }), 'JwtTooOld');
});

test('rejects a replayed token', async () => {
  const token = await mintJwt();
  const v = verifier();
  await v.verifyRequest(feedRequest(token), { lxm: LXM });
  await assertChallenge(v.verifyRequest(feedRequest(token), { lxm: LXM }), 'NonceNotUnique');
});

test('rejects an issuer whose DID document cannot be resolved', async () => {
  const token = await mintJwt({ issuer: 'did:plc:unknown' as Did });
  await assertChallenge(
    verifier().verifyRequest(feedRequest(token), { lxm: LXM }),
    'DidResolutionFailed',
  );
});

test('rejects a request without an Authorization header', async () => {
  await assert.rejects(
    verifier().verifyRequest(feedRequest(), { lxm: LXM }),
    (err: { status?: number }) => err.status === 401,
  );
});

test('required auth surfaces the precise failure in the challenge', async () => {
  // The dynamic feed lets this error escape so a client can tell an expired
  // token from a malformed one; a re-wrapped 401 would lose that.
  await assert.rejects(
    requireFeedAuth(feedRequest('not-a-jwt')),
    (err: unknown) => challengeCode(err) !== null,
  );
});

test('replay store accepts each (iss, jti) once inside its ttl, then again after expiry', async () => {
  let now = 1_000_000;
  const store = createInMemoryReplayStore(() => now);
  const key = { iss: VIEWER_DID, jti: 'abc' };

  assert.equal(await store.check(key, 60), true);
  assert.equal(await store.check(key, 60), false);

  now += 59_000;
  assert.equal(await store.check(key, 60), false);

  now += 2_000;
  assert.equal(await store.check(key, 60), true);
});
