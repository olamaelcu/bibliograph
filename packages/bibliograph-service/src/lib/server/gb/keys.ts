import { PUBLISHER_DID } from '../did';

/**
 * Google Books has no native OLID-style key. We synthesize `gb.{volumeId}` rkeys
 * (e.g. `gb.GhPSEAAAQBAJ`) and persist them under the same PUBLISHER_DID.
 *
 * Google volumeIds are alphanumeric with `-` and `_`, typically 12+ chars.
 * Fail-closed validation rejects `ol.*` strings and anything with structural
 * confusion.
 */

const GB_VOLUME_RE = /^[A-Za-z0-9_-]{8,}$/;
const GB_PREFIX = 'gb.';

function assertGbId(id: string): void {
  if (!GB_VOLUME_RE.test(id)) throw new Error(`invalid gb volume id: ${id}`);
}

export function isGbRkey(rkey: string): boolean {
  if (!rkey.startsWith(GB_PREFIX)) return false;
  const vid = rkey.slice(GB_PREFIX.length);
  return GB_VOLUME_RE.test(vid);
}

export function gbEditionRkey(volumeId: string): string {
  assertGbId(volumeId);
  return `${GB_PREFIX}${volumeId}`;
}

export function gbWorkRkey(volumeId: string): string {
  return gbEditionRkey(volumeId);
}

export function gbEditionUri(volumeId: string): string {
  return `at://${PUBLISHER_DID}/community.lexicon.book.edition/${gbEditionRkey(volumeId)}`;
}

export function gbWorkUri(volumeId: string): string {
  return `at://${PUBLISHER_DID}/community.lexicon.book.work/${gbEditionRkey(volumeId)}`;
}

export function gbPublisherRkey(publisherId: string): string {
  assertGbId(publisherId);
  return `${GB_PREFIX}${publisherId}`;
}

export function gbPublisherUri(publisherId: string): string {
  return `at://${PUBLISHER_DID}/community.lexicon.book.publisher/${gbPublisherRkey(publisherId)}`;
}

export function volumeIdFromGbRkey(rkey: string): string {
  if (!rkey.startsWith(GB_PREFIX)) throw new Error(`invalid gb rkey: ${rkey}`);
  if (rkey === GB_PREFIX) throw new Error(`invalid gb rkey: ${rkey}`);
  const vid = rkey.slice(GB_PREFIX.length);
  assertGbId(vid);
  return vid;
}

export function gbIdentifierFromUri(uri: string): string | null {
  if (!uri.startsWith('https://books.google.com/books?id=')) return null;
  const vid = uri.slice('https://books.google.com/books?id='.length);
  if (!GB_VOLUME_RE.test(vid)) return null;
  return vid;
}