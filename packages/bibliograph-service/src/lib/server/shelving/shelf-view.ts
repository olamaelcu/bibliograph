// The one derivation of a `defs#shelfView` from a shelf record.
//
// Shelves are read from three places — the TAP mirror (`hydrateShelvesByUri`),
// a PDS `getRecord` (`getShelf`), and the fallback branch of
// `listShelvesWithBooks` — and each used to build the view by hand. They agreed
// only by accident: the mirror and the shelf listing published no description
// at all, so a custom shelf's description vanished depending on which read
// answered. This module is the single definition those paths call.

import type { NetOlamaelcuLivtetBiblioDefs } from '../lexicons/index.js';
import { shelfRkeyOf } from './shelf-rows';

/**
 * The shelves every reader has whether or not they wrote a record for them.
 * Their rkey is fixed by the lexicon, so the name can be derived from the URI
 * alone — which is what titles a shelf whose record has not reached the mirror.
 */
const SHELF_DISPLAY_NAMES: Record<string, string> = {
  'reading': 'Currently Reading',
  'to-read': 'To Read',
  'read': 'Read',
  'dnf': 'Did Not Finish',
};

export function displayNameForShelfRkey(rkey: string): string | null {
  return SHELF_DISPLAY_NAMES[rkey] ?? null;
}

/**
 * The view a shelf record's value describes.
 *
 * Every optional field is omitted rather than sent blank: `description` is
 * absent on the four reading-status shelves, and a client that renders it must
 * see "no description" instead of an empty paragraph. `name` falls back to the
 * fixed display name of a status shelf, so a shelf record the mirror has not
 * seen yet still titles itself.
 */
export function shelfViewFromValue(
  uri: string,
  value: unknown,
): NetOlamaelcuLivtetBiblioDefs.ShelfView {
  const record = value !== null && typeof value === 'object'
    ? (value as { name?: unknown; description?: unknown; createdAt?: unknown; updatedAt?: unknown })
    : {};
  const description = typeof record.description === 'string' && record.description !== '' ? record.description : undefined;
  const createdAt = typeof record.createdAt === 'string' && record.createdAt !== '' ? record.createdAt : undefined;
  const updatedAt = typeof record.updatedAt === 'string' && record.updatedAt !== '' ? record.updatedAt : undefined;
  const name = (typeof record.name === 'string' && record.name !== '')
    ? record.name
    : displayNameForShelfRkey(shelfRkeyOf(uri)) ?? '';
  return {
    uri: uri as NetOlamaelcuLivtetBiblioDefs.ShelfView['uri'],
    name,
    description,
    createdAt,
    updatedAt,
    $type: 'net.olamaelcu.livtet.biblio.defs#shelfView',
  };
}
