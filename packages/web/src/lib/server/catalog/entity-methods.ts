/**
 * The catalog XRPC methods the edge answers itself.
 *
 * They are anonymous catalog reads over the deployment's own tables, exactly
 * like `resolveEditions` / `searchEditions`, so they never reach HappyView and
 * are not part of `hv-deploy`'s uploaded surface. Keeping the NSIDs in a module
 * without SvelteKit imports makes the dispatch classification testable.
 */

// The claim/link query's NSID lives with its implementation, so the method and
// the SQL that answers it cannot be registered under different names.
import { GET_CONTRIBUTOR_LINK } from './contributor-links.ts';

// The giveaway reads' NSIDs live with their implementation for the same reason.
import { GIVEAWAY_ENTRIES, GIVEAWAY_LIST, GIVEAWAY_REPORT } from './giveaway.ts';

export { GET_CONTRIBUTOR_LINK, GIVEAWAY_ENTRIES, GIVEAWAY_LIST, GIVEAWAY_REPORT };

/** The two authenticated procedures: they need `$env` and the index pool. */
export const GIVEAWAY_DRAW = 'net.olamaelcu.livtet.biblio.giveaway.draw';
export const GIVEAWAY_EXTEND = 'net.olamaelcu.livtet.biblio.giveaway.extend';

/** The books-wg procedures: `POST`-only by lexicon, answered here. */
export const RESOLVE_EDITIONS = 'community.lexicon.media.book.resolveEditions';
export const SEARCH_EDITIONS = 'community.lexicon.media.book.searchEditions';

export const EDGE_PROCEDURES = new Set([
  RESOLVE_EDITIONS,
  SEARCH_EDITIONS,
  GIVEAWAY_DRAW,
  GIVEAWAY_EXTEND
]);

export const GET_CONTRIBUTOR = 'net.olamaelcu.livtet.biblio.getContributor';
export const GET_PUBLISHER = 'net.olamaelcu.livtet.biblio.getPublisher';
export const GET_GENRES_OF_BOOK = 'net.olamaelcu.livtet.biblio.getGenresOfBook';
export const GET_IDENTIFIED_FORMATS =
  'net.olamaelcu.livtet.biblio.getIdentifiedFormats';
export const LIST_EDITIONS_BY_CONTRIBUTOR =
  'net.olamaelcu.livtet.biblio.listEditionsByContributor';
export const LIST_EDITIONS = 'net.olamaelcu.livtet.biblio.listEditions';
export const RESOLVE_CONTRIBUTORS = 'net.olamaelcu.livtet.biblio.resolveContributors';
export const RESOLVE_PUBLISHERS = 'net.olamaelcu.livtet.biblio.resolvePublishers';
export const SEARCH_CONTRIBUTORS = 'net.olamaelcu.livtet.biblio.searchContributors';
export const SEARCH_PUBLISHERS = 'net.olamaelcu.livtet.biblio.searchPublishers';

export const ENTITY_QUERIES = new Set([
  GET_CONTRIBUTOR,
  GET_CONTRIBUTOR_LINK,
  GET_GENRES_OF_BOOK,
  GET_IDENTIFIED_FORMATS,
  GET_PUBLISHER,
  GIVEAWAY_ENTRIES,
  GIVEAWAY_LIST,
  GIVEAWAY_REPORT,
  LIST_EDITIONS_BY_CONTRIBUTOR,
  LIST_EDITIONS,
  RESOLVE_CONTRIBUTORS,
  RESOLVE_PUBLISHERS,
  SEARCH_CONTRIBUTORS,
  SEARCH_PUBLISHERS
]);
