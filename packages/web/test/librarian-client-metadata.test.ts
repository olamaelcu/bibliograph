import { expect, test } from 'vitest';

import { canonicalDevUrl, redirectUri } from '../src/lib/server/librarian/return-to.ts';
import {
  isInsecureOrigin,
  librarianClientMetadata
} from '../src/lib/server/librarian/client-metadata.ts';

/**
 * The client id is the one thing the authorization server uses to decide what a
 * client may ask for, and it has two legal shapes: an https metadata URL, or an
 * RFC 8252 loopback id. These pin which shape each origin produces, because a
 * development host that slips through as neither is exactly the bug that made
 * sign-in fail with `redirect_external_not_allowed`'s neighbour: `client_id`
 * must use https, and a redirect URI must not name `localhost`.
 */

const CALLBACK = '/librarian/oauth/callback';

test('an https origin names its own metadata document', () => {
  const origin = 'https://biblio.livtet.olamaelcu.net';
  const metadata = librarianClientMetadata(origin);
  expect(metadata.client_id).toBe(`${origin}/oauth-client-metadata.json`);
  expect(metadata.redirect_uris).toEqual([`${origin}${CALLBACK}`]);
  expect(metadata.application_type).toBe('web');
  expect(isInsecureOrigin(origin)).toBe(false);
});

test('a loopback origin becomes a loopback client id, with no fetched document', () => {
  const metadata = librarianClientMetadata('http://127.0.0.1:5176');
  expect(metadata.client_id.startsWith('http://localhost')).toBe(true);
  expect(new URL(metadata.client_id).searchParams.get('redirect_uri')).toBe(
    'http://127.0.0.1:5176/librarian/oauth/callback'
  );
  expect(metadata.redirect_uris).toEqual(['http://127.0.0.1:5176/librarian/oauth/callback']);
  expect(metadata.application_type).toBe('native');
  expect(metadata.scope).toBe('atproto');
});

test('a development host opened as localhost still registers a loopback IP redirect', () => {
  const metadata = librarianClientMetadata('http://localhost:5176');
  expect(metadata.redirect_uris).toEqual(['http://127.0.0.1:5176/librarian/oauth/callback']);
  expect(JSON.stringify({ ...metadata, client_id: undefined })).not.toContain('localhost');
});

test('only the loopback host is rewritten, and only on a callback URL', () => {
  expect(redirectUri('https://biblio.livtet.olamaelcu.net')).toBe(
    'https://biblio.livtet.olamaelcu.net/librarian/oauth/callback'
  );
  expect(redirectUri('http://localhost:5176')).toBe('http://127.0.0.1:5176/librarian/oauth/callback');
});

test('a localhost URL is canonicalised to the loopback IP, path and query intact', () => {
  expect(canonicalDevUrl(new URL('http://localhost:5176/librarian/claims?page=2'))?.toString()).toBe(
    'http://127.0.0.1:5176/librarian/claims?page=2'
  );
  expect(canonicalDevUrl(new URL('http://127.0.0.1:5176/x'))).toBeNull();
  expect(canonicalDevUrl(new URL('https://biblio.livtet.olamaelcu.net/x'))).toBeNull();
});
