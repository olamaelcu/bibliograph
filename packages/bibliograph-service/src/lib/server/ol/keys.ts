import { PUBLISHER_DID } from '../did';

const OL_EDITION_RE = /^OL\d+M$/;
const OL_WORK_RE = /^OL\d+W$/;
const OL_AUTHOR_RE = /^OL\d+A$/;
const OL_PUBLISHER_RE = /^OL\d+P$/;

function assertOlId(id: string, re: RegExp, label: string): void {
  if (!re.test(id)) throw new Error(`invalid ${label} OLID: ${id}`);
}

function stripPrefix(key: string, prefix: string): string {
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

export function parseEditionKey(key: string): string {
  const id = stripPrefix(key, '/books/');
  assertOlId(id, OL_EDITION_RE, 'edition');
  return id;
}

export function parseWorkKey(key: string): string {
  const id = stripPrefix(key, '/works/');
  assertOlId(id, OL_WORK_RE, 'work');
  return id;
}

export function parseAuthorKey(key: string): string {
  const id = stripPrefix(key, '/authors/');
  assertOlId(id, OL_AUTHOR_RE, 'author');
  return id;
}

export function parsePublisherKey(key: string): string {
  const id = stripPrefix(key, '/publishers/');
  assertOlId(id, OL_PUBLISHER_RE, 'publisher');
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

export function publisherRkey(olid: string): string {
  assertOlId(olid, OL_PUBLISHER_RE, 'publisher');
  return `ol.P${olid.slice(2)}`;
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

export function publisherUri(olid: string): string {
  return `at://${PUBLISHER_DID}/community.lexicon.book.publisher/${publisherRkey(olid)}`;
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

export function olidFromPublisherRkey(rkey: string): string {
  if (!rkey.startsWith('ol.P')) throw new Error(`invalid publisher rkey: ${rkey}`);
  const olid = `OL${rkey.slice(4)}`;
  if (!OL_PUBLISHER_RE.test(olid)) throw new Error(`invalid publisher rkey: ${rkey}`);
  return olid;
}