import { PUBLISHER_DID } from '../did';

const OL_EDITION_RE = /^OL\d+M$/;
const OL_WORK_RE = /^OL\d+W$/;
const OL_AUTHOR_RE = /^OL\d+A$/;

function assertOlId(id: string, re: RegExp, label: string): void {
  if (!re.test(id)) throw new Error(`invalid ${label} OLID: ${id}`);
}

export function parseEditionKey(key: string): string {
  if (!key.startsWith('/books/')) throw new Error(`edition key must start with /books/: ${key}`);
  const id = key.slice(7);
  assertOlId(id, OL_EDITION_RE, 'edition');
  return id;
}

export function parseWorkKey(key: string): string {
  if (!key.startsWith('/works/')) throw new Error(`work key must start with /works/: ${key}`);
  const id = key.slice(7);
  assertOlId(id, OL_WORK_RE, 'work');
  return id;
}

export function parseAuthorKey(key: string): string {
  if (!key.startsWith('/authors/')) throw new Error(`author key must start with /authors/: ${key}`);
  const id = key.slice(9);
  assertOlId(id, OL_AUTHOR_RE, 'author');
  return id;
}

export function editionRkey(olid: string): string {
  assertOlId(olid, OL_EDITION_RE, 'edition');
  return `ol.${olid}`;
}

export function workRkey(olid: string): string {
  assertOlId(olid, OL_WORK_RE, 'work');
  return `ol.W${olid.slice(2)}`;
}

export function contributorRkey(olid: string): string {
  assertOlId(olid, OL_AUTHOR_RE, 'author');
  return `ol.A${olid.slice(2)}`;
}

export function editionUri(olid: string): string {
  return `at://${PUBLISHER_DID}/community.lexicon.book.edition/${editionRkey(olid)}`;
}

export function workUri(olid: string): string {
  return `at://${PUBLISHER_DID}/community.lexicon.book.work/${workRkey(olid)}`;
}

export function contributorUri(olid: string): string {
  return `at://${PUBLISHER_DID}/community.lexicon.book.contributor/${contributorRkey(olid)}`;
}

export function olidFromEditionRkey(rkey: string): string {
  if (!rkey.startsWith('ol.')) throw new Error(`invalid edition rkey: ${rkey}`);
  const olid = rkey.slice(3);
  if (!OL_EDITION_RE.test(olid)) throw new Error(`invalid edition rkey: ${rkey}`);
  return olid;
}

export function olidFromWorkRkey(rkey: string): string {
  if (!rkey.startsWith('ol.W')) throw new Error(`invalid work rkey: ${rkey}`);
  const olid = `OL${rkey.slice(4)}`;
  if (!OL_WORK_RE.test(olid)) throw new Error(`invalid work rkey: ${rkey}`);
  return olid;
}

export function olidFromContributorRkey(rkey: string): string {
  if (!rkey.startsWith('ol.A')) throw new Error(`invalid contributor rkey: ${rkey}`);
  const olid = `OL${rkey.slice(4)}`;
  if (!OL_AUTHOR_RE.test(olid)) throw new Error(`invalid contributor rkey: ${rkey}`);
  return olid;
}