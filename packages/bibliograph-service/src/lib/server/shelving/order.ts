// Book ordering within a shelf.
//
// `metadata.position` is optional and only some writers set it, so the order is:
// positioned books first in ascending position, then the rest — and every tie is
// broken by URI, because a stable order is what makes a shelf read repeatable.

import type { NetOlamaelcuLivtetBiblioDefs } from '../lexicons/index.js';

export function compareShelfBooks(
  a: NetOlamaelcuLivtetBiblioDefs.BookShelfView,
  b: NetOlamaelcuLivtetBiblioDefs.BookShelfView,
): number {
  const left = a.metadata?.position;
  const right = b.metadata?.position;
  if (left !== right) {
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    return left - right;
  }
  return a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0;
}
