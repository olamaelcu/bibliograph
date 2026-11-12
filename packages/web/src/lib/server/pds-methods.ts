/**
 * The only publisher-record reads served at the edge.
 *
 * Livtet's book, contributor and feed routes call `com.atproto.repo.getRecord`
 * and `listRecords` directly against this base URL. HappyView's built-in
 * `com.atproto.*` proxy is authority-bound and fails against the publisher
 * PDS, so these two GETs are answered here instead.
 *
 * Kept free of `$env` imports (unlike `./pds.ts`) so the XRPC dispatch and its
 * tests can classify a method without loading the proxy.
 */

export function isPdsRead(method: string): boolean {
  return method === 'com.atproto.repo.getRecord' || method === 'com.atproto.repo.listRecords';
}
