import test from 'node:test';
import assert from 'node:assert/strict';

import { P256Keypair, Secp256k1Keypair } from '@atproto/crypto';

import {
  FeedAuthError,
  verifyFeedServiceJwt,
  type DidDocument
} from '../src/lib/server/feeds/auth.ts';

/**
 * Service-JWT verification, exercised with real generated keys. These are the
 * accept/reject cases the edge relies on: a token signed by the issuer's
 * `#atproto` key is accepted, and every malformed, expired, wrong-audience,
 * wrong-lxm or tampered token is rejected.
 */

const NOW = 1_800_000_000;

type Keypair = { did(): string; sign(message: Uint8Array): Promise<Uint8Array> };

function documentFor(did: string, keypair: Keypair): DidDocument {
  return {
    id: did,
    verificationMethod: [
      {
        id: `${did}#atproto`,
        type: 'Multikey',
        controller: did,
        publicKeyMultibase: keypair.did().slice('did:key:'.length)
      }
    ]
  };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

async function signJwt(
  keypair: Keypair,
  options: {
    iss: string;
    aud?: string;
    lxm?: string;
    alg?: string;
    typ?: string;
    iat?: number;
    exp?: number;
  }
): Promise<string> {
  const header = { alg: options.alg ?? 'ES256K', typ: options.typ ?? 'JWT' };
  const payload = {
    iss: options.iss,
    aud: options.aud ?? `${options.iss}#atproto_feed`,
    lxm: options.lxm ?? 'com.atproto.feed.getFeedSkeleton',
    iat: options.iat ?? NOW - 5,
    exp: options.exp ?? NOW + 55
  };
  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = await keypair.sign(new TextEncoder().encode(signingInput));
  return `${signingInput}.${Buffer.from(signature).toString('base64url')}`;
}

function resolverFor(documents: Record<string, DidDocument>): (did: string) => Promise<DidDocument | null> {
  return async (did) => documents[did] ?? null;
}

test('accepts a valid ES256K service JWT and returns the issuer', async () => {
  const keypair = await Secp256k1Keypair.create();
  const iss = 'did:plc:feedkeytest256k';
  const token = await signJwt(keypair, { iss });
  const issReturned = await verifyFeedServiceJwt(token, {
    audience: `${iss}#atproto_feed`,
    resolveDid: resolverFor({ [iss]: documentFor(iss, keypair) }),
    now: NOW
  });
  assert.equal(issReturned, iss);
});

test('accepts a valid ES256 (P-256) service JWT', async () => {
  const keypair = await P256Keypair.create();
  const iss = 'did:web:feed.test.example';
  const token = await signJwt(keypair, { iss, alg: 'ES256' });
  const issReturned = await verifyFeedServiceJwt(token, {
    audience: `${iss}#atproto_feed`,
    resolveDid: resolverFor({ [iss]: documentFor(iss, keypair) }),
    now: NOW
  });
  assert.equal(issReturned, iss);
});

test('rejects a tampered payload even though the header and signature are intact', async () => {
  const keypair = await Secp256k1Keypair.create();
  const iss = 'did:plc:feedtamper';
  const attacker = 'did:plc:feedattacker';
  const token = await signJwt(keypair, { iss });
  const [header, , signature] = token.split('.');
  const forgedPayload = encode({
    iss: attacker,
    aud: `${iss}#atproto_feed`,
    lxm: 'com.atproto.feed.getFeedSkeleton',
    iat: NOW - 5,
    exp: NOW + 55
  });
  const forged = `${header}.${forgedPayload}.${signature}`;

  await assert.rejects(
    verifyFeedServiceJwt(forged, {
      audience: `${iss}#atproto_feed`,
      resolveDid: resolverFor({
        [iss]: documentFor(iss, keypair),
        [attacker]: documentFor(attacker, keypair)
      }),
      now: NOW
    }),
    FeedAuthError
  );
});

test('rejects a tampered signature', async () => {
  const keypair = await Secp256k1Keypair.create();
  const iss = 'did:plc:feedsigtamper';
  const token = await signJwt(keypair, { iss });
  const parts = token.split('.');
  const signature = Buffer.from(parts[2]!, 'base64url');
  signature[10] ^= 0xff;
  const forged = `${parts[0]}.${parts[1]}.${signature.toString('base64url')}`;

  await assert.rejects(
    verifyFeedServiceJwt(forged, {
      audience: `${iss}#atproto_feed`,
      resolveDid: resolverFor({ [iss]: documentFor(iss, keypair) }),
      now: NOW
    }),
    /signature does not verify/
  );
});

test('rejects an expired token', async () => {
  const keypair = await Secp256k1Keypair.create();
  const iss = 'did:plc:feedexpired';
  const token = await signJwt(keypair, { iss, iat: NOW - 120, exp: NOW - 60 });
  await assert.rejects(
    verifyFeedServiceJwt(token, {
      audience: `${iss}#atproto_feed`,
      resolveDid: resolverFor({ [iss]: documentFor(iss, keypair) }),
      now: NOW
    }),
    /expired/
  );
});

test('rejects a token issued in the future', async () => {
  const keypair = await Secp256k1Keypair.create();
  const iss = 'did:plc:feedfuture';
  const token = await signJwt(keypair, { iss, iat: NOW + 600, exp: NOW + 660 });
  await assert.rejects(
    verifyFeedServiceJwt(token, {
      audience: `${iss}#atproto_feed`,
      resolveDid: resolverFor({ [iss]: documentFor(iss, keypair) }),
      now: NOW
    }),
    /future/
  );
});

test('rejects the wrong audience', async () => {
  const keypair = await Secp256k1Keypair.create();
  const iss = 'did:plc:feedaudience';
  const token = await signJwt(keypair, { iss, aud: 'did:plc:other#atproto_feed' });
  await assert.rejects(
    verifyFeedServiceJwt(token, {
      audience: `${iss}#atproto_feed`,
      resolveDid: resolverFor({ [iss]: documentFor(iss, keypair) }),
      now: NOW
    }),
    /audience/
  );
});

test('rejects the wrong lxm', async () => {
  const keypair = await Secp256k1Keypair.create();
  const iss = 'did:plc:feedlxm';
  const token = await signJwt(keypair, { iss, lxm: 'com.atproto.repo.putRecord' });
  await assert.rejects(
    verifyFeedServiceJwt(token, {
      audience: `${iss}#atproto_feed`,
      resolveDid: resolverFor({ [iss]: documentFor(iss, keypair) }),
      now: NOW
    }),
    /getFeedSkeleton/
  );
});

test('rejects an algorithm that does not match the issuer key', async () => {
  const keypair = await Secp256k1Keypair.create();
  const iss = 'did:plc:feedalg';
  const token = await signJwt(keypair, { iss, alg: 'ES256' });
  await assert.rejects(
    verifyFeedServiceJwt(token, {
      audience: `${iss}#atproto_feed`,
      resolveDid: resolverFor({ [iss]: documentFor(iss, keypair) }),
      now: NOW
    }),
    /signature does not verify/
  );
});

test('rejects an unsupported algorithm', async () => {
  const keypair = await Secp256k1Keypair.create();
  const iss = 'did:plc:feedalgunsupported';
  const token = await signJwt(keypair, { iss, alg: 'HS256' });
  await assert.rejects(
    verifyFeedServiceJwt(token, {
      audience: `${iss}#atproto_feed`,
      resolveDid: resolverFor({ [iss]: documentFor(iss, keypair) }),
      now: NOW
    }),
    /unsupported algorithm/
  );
});

test('rejects an issuer with no resolvable DID document', async () => {
  const keypair = await Secp256k1Keypair.create();
  const iss = 'did:plc:feedunresolved';
  const token = await signJwt(keypair, { iss });
  await assert.rejects(
    verifyFeedServiceJwt(token, {
      audience: `${iss}#atproto_feed`,
      resolveDid: resolverFor({}),
      now: NOW
    }),
    /could not be resolved/
  );
});

test('rejects a document without the #atproto Multikey', async () => {
  const keypair = await Secp256k1Keypair.create();
  const iss = 'did:plc:feednokey';
  const token = await signJwt(keypair, { iss });
  await assert.rejects(
    verifyFeedServiceJwt(token, {
      audience: `${iss}#atproto_feed`,
      resolveDid: resolverFor({
        [iss]: { id: iss, verificationMethod: [{ id: `${iss}#other`, type: 'Multikey' }] }
      }),
      now: NOW
    }),
    /no #atproto verification method/
  );
});

test('rejects a non-compact token', async () => {
  await assert.rejects(
    verifyFeedServiceJwt('not-a-jwt', {
      audience: 'did:plc:x#atproto_feed',
      resolveDid: resolverFor({}),
      now: NOW
    }),
    /not a compact JWT/
  );
});
