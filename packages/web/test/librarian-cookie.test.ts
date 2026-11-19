import { expect, test } from 'vitest';

import {
  LIBRARIAN_COOKIE_PARTS,
  parseAllowlist,
  readSessionCookie,
  signSessionCookie
} from '../src/lib/server/librarian/cookie.ts';

/**
 * The librarian allowlist and session cookie, without a SvelteKit environment.
 *
 * The cookie is the only thing standing between a browser and someone else's
 * decisions, so these pin the three ways it must fail: no signature, a signature
 * for another DID, and an expiry in the past. The allowlist is pinned too,
 * because an entry that is not a DID can never be signed in as.
 */

const SECRET = 'test-secret-value';
const DID = 'did:plc:librarian';
const NOW = 1_800_000_000;

test('the allowlist accepts DIDs separated by commas or whitespace', () => {
  const allowlist = parseAllowlist('did:plc:one, did:web:two\n did:plc:three');
  expect([...allowlist].sort()).toEqual(['did:plc:one', 'did:plc:three', 'did:web:two']);
});

test('the allowlist drops entries that are not DIDs, and is empty when unset', () => {
  expect([...parseAllowlist('alice.bsky.social, did:plc:one, ')])
    .toEqual(['did:plc:one']);
  expect(parseAllowlist(undefined).size).toBe(0);
  expect(parseAllowlist('   ').size).toBe(0);
});

test('a signed cookie reads back as its DID', () => {
  const value = signSessionCookie(DID, NOW + 60, SECRET);
  expect(value.split('.')).toHaveLength(LIBRARIAN_COOKIE_PARTS);
  expect(readSessionCookie(value, SECRET, NOW)).toBe(DID);
});

test('a cookie expired or unsigned by this secret reads back as null', () => {
  const value = signSessionCookie(DID, NOW + 60, SECRET);

  // Expired: the expiry is inside the signed payload, so it cannot be moved
  // forward without the signature failing as well.
  expect(readSessionCookie(value, SECRET, NOW + 61)).toBeNull();
  expect(readSessionCookie(signSessionCookie(DID, NOW, SECRET), SECRET, NOW)).toBeNull();

  // Another deployment's secret.
  expect(readSessionCookie(value, 'other-secret', NOW)).toBeNull();
});

test('a forged or malformed cookie reads back as null', () => {
  const value = signSessionCookie(DID, NOW + 60, SECRET);
  const [encodedDid, expires, signature] = value.split('.');

  // Same expiry, different DID: the signature no longer matches.
  const otherDid = Buffer.from('did:plc:impostor', 'utf8').toString('base64url');
  expect(readSessionCookie(`${otherDid}.${expires}.${signature}`, SECRET, NOW)).toBeNull();

  expect(readSessionCookie('', SECRET, NOW)).toBeNull();
  expect(readSessionCookie(undefined, SECRET, NOW)).toBeNull();
  expect(readSessionCookie(`${encodedDid}.${expires}`, SECRET, NOW)).toBeNull();
  expect(readSessionCookie(`${encodedDid}.notanumber.${signature}`, SECRET, NOW)).toBeNull();
});
