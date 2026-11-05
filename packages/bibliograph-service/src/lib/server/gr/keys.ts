import { PUBLISHER_DID } from '../did';

/**
 * Goodreads has no OLID-style key. We synthesize `gr.{bookId}` rkeys and
 * persist them under PUBLISHER_DID; the book id is the numeric legacy id in
 * `/book/show/{id}`.
 */

const GR_PREFIX = 'gr.';
const GR_ID_RE = /^\d{1,20}$/;

function assertGrId(id: string): void {
  if (!GR_ID_RE.test(id)) throw new Error(`invalid goodreads book id: ${id}`);
}

export function isGrRkey(rkey: string): boolean {
  if (!rkey.startsWith(GR_PREFIX)) return false;
  return GR_ID_RE.test(rkey.slice(GR_PREFIX.length));
}

export function grEditionRkey(id: string): string {
  assertGrId(id);
  return `${GR_PREFIX}${id}`;
}

export function grEditionUri(id: string): string {
  return `at://${PUBLISHER_DID}/community.lexicon.book.edition/${grEditionRkey(id)}`;
}

export function grIdFromRkey(rkey: string): string {
  if (!rkey.startsWith(GR_PREFIX)) throw new Error(`invalid gr rkey: ${rkey}`);
  const id = rkey.slice(GR_PREFIX.length);
  assertGrId(id);
  return id;
}

export function grIdFromIdentifier(uri: string): string | null {
  const match = /^https:\/\/www\.goodreads\.com\/book\/show\/(\d+)/.exec(uri);
  return match?.[1] ?? null;
}

export function goodreadsBookUrl(id: string): string {
  assertGrId(id);
  return `https://www.goodreads.com/book/show/${id}`;
}
