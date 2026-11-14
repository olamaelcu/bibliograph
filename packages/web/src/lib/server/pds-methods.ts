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

export const PDS_GET_RECORD = 'com.atproto.repo.getRecord';
export const PDS_LIST_RECORDS = 'com.atproto.repo.listRecords';

/** Both are GET-only reads served by the publisher PDS. */
export const PDS_READS = [PDS_GET_RECORD, PDS_LIST_RECORDS] as const;

export function isPdsRead(method: string): boolean {
  return method === PDS_GET_RECORD || method === PDS_LIST_RECORDS;
}
