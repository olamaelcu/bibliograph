/**
 * The catalog XRPC methods the edge answers itself.
 *
 * They are anonymous catalog reads over the deployment's own tables, exactly
 * like `resolveEditions` / `searchEditions`, so they never reach HappyView and
 * are not part of `hv-deploy`'s uploaded surface. Keeping the NSIDs in a module
 * without SvelteKit imports makes the dispatch classification testable.
 */

/** The books-wg procedures: `POST`-only by lexicon, answered here. */
export const RESOLVE_EDITIONS = 'community.lexicon.media.book.resolveEditions';
export const SEARCH_EDITIONS = 'community.lexicon.media.book.searchEditions';

export const EDGE_PROCEDURES = new Set([RESOLVE_EDITIONS, SEARCH_EDITIONS]);

export const GET_CONTRIBUTOR = 'net.olamaelcu.livtet.biblio.getContributor';
export const GET_PUBLISHER = 'net.olamaelcu.livtet.biblio.getPublisher';
export const GET_GENRES_OF_BOOK = 'net.olamaelcu.livtet.biblio.getGenresOfBook';
export const LIST_EDITIONS_BY_CONTRIBUTOR =
  'net.olamaelcu.livtet.biblio.listEditionsByContributor';
export const RESOLVE_CONTRIBUTORS = 'net.olamaelcu.livtet.biblio.resolveContributors';
export const RESOLVE_PUBLISHERS = 'net.olamaelcu.livtet.biblio.resolvePublishers';
export const SEARCH_CONTRIBUTORS = 'net.olamaelcu.livtet.biblio.searchContributors';
export const SEARCH_PUBLISHERS = 'net.olamaelcu.livtet.biblio.searchPublishers';

/** GET-only, parameter-in-query methods. */
export const ENTITY_QUERIES = new Set([
  GET_CONTRIBUTOR,
  GET_GENRES_OF_BOOK,
  GET_PUBLISHER,
  LIST_EDITIONS_BY_CONTRIBUTOR,
  SEARCH_CONTRIBUTORS,
  SEARCH_PUBLISHERS
]);

/** POST-only methods: the identifier array travels as a JSON body. */
export const ENTITY_PROCEDURES = new Set([RESOLVE_CONTRIBUTORS, RESOLVE_PUBLISHERS]);

export const ENTITY_METHODS = new Set([...ENTITY_QUERIES, ...ENTITY_PROCEDURES]);
