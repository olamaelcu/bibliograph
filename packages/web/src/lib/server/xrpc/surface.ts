/**
 * The methods this deployment answers, as one list.
 *
 * `community.lexicon.service.describe` reports it so a caller can discover the
 * surface instead of trying NSIDs and reading failures. The edge cannot
 * enumerate HappyView's uploaded scripts, so the forwarded NSIDs are literals;
 * `packages/web/test/xrpc-surface.test.ts` holds them to
 * `happyview/scripts/xrpc/{query,procedure}/` and to the dispatch registries,
 * so the description cannot drift from what is actually served.
 *
 * Free of `$env` and SvelteKit imports (like `./dispatch.ts`) so the dispatch
 * and its tests can load it.
 */

import { EDGE_PROCEDURES, ENTITY_METHODS } from '../catalog/entity-methods.ts';
import { DESCRIBE_FEED_GENERATOR, GET_FEED_SKELETON } from '../feeds/methods.ts';
import { PDS_READS } from '../pds-methods.ts';

export const SERVICE_DESCRIBE = 'community.lexicon.service.describe';

/** The roles this deployment answers under: an index plus a feed generator. */
export const SERVICE_ROLES = ['appview', 'feedgen'] as const;

/** The `#nsid` object every described method is named by. */
const NSID = `${SERVICE_DESCRIBE}#nsid`;

/** The query methods forwarded to HappyView: one uploaded Lua script each. */
export const FORWARDED_QUERIES = [
  'net.olamaelcu.livtet.biblio.getActorProfile',
  'net.olamaelcu.livtet.biblio.getBookOnShelf',
  'net.olamaelcu.livtet.biblio.getReadingGoal',
  'net.olamaelcu.livtet.biblio.getReviewsByBook',
  'net.olamaelcu.livtet.biblio.getShelf',
  'net.olamaelcu.livtet.biblio.getShelversOfBook',
  'net.olamaelcu.livtet.biblio.getShelvingOfBook',
  'net.olamaelcu.livtet.biblio.graph.isFollowing',
  'net.olamaelcu.livtet.biblio.graph.listFollowees',
  'net.olamaelcu.livtet.biblio.graph.listFollowers',
  'net.olamaelcu.livtet.biblio.listBooksOnShelf',
  'net.olamaelcu.livtet.biblio.listRecentShelving',
  'net.olamaelcu.livtet.biblio.listReviewsByActor',
  'net.olamaelcu.livtet.biblio.listShelfItems',
  'net.olamaelcu.livtet.biblio.listShelfItemsByBook',
  'net.olamaelcu.livtet.biblio.listShelves',
  'net.olamaelcu.livtet.biblio.listShelvesWithBooks'
] as const;

/** The procedure methods forwarded to HappyView, in `hv-deploy`'s own order. */
export const FORWARDED_PROCEDURES = [
  'net.olamaelcu.livtet.biblio.graph.follow',
  'net.olamaelcu.livtet.biblio.graph.unfollow',
  'net.olamaelcu.livtet.biblio.shelf.create',
  'net.olamaelcu.livtet.biblio.shelf.update',
  'net.olamaelcu.livtet.biblio.shelf.delete',
  'net.olamaelcu.livtet.biblio.shelf.addItem',
  'net.olamaelcu.livtet.biblio.shelf.removeItem',
  'net.olamaelcu.livtet.biblio.shelf.addBooks',
  'net.olamaelcu.livtet.biblio.status.set',
  'net.olamaelcu.livtet.biblio.status.clear',
  'net.olamaelcu.livtet.biblio.readingGoal.set',
  'net.olamaelcu.livtet.biblio.profile.set',
  'net.olamaelcu.livtet.biblio.review.create',
  'net.olamaelcu.livtet.biblio.review.update',
  'net.olamaelcu.livtet.biblio.review.delete'
] as const;

/**
 * Every NSID this deployment answers, sorted and deduplicated. The edge-served
 * methods come from the registries the dispatch classifies against, so there is
 * one list per method rather than a second copy here.
 */
export function serviceMethods(): string[] {
  return [
    ...new Set<string>([
      SERVICE_DESCRIBE,
      DESCRIBE_FEED_GENERATOR,
      GET_FEED_SKELETON,
      ...EDGE_PROCEDURES,
      ...ENTITY_METHODS,
      ...PDS_READS,
      ...FORWARDED_QUERIES,
      ...FORWARDED_PROCEDURES
    ])
  ].sort();
}

/**
 * The `community.lexicon.service.describe` output. Anonymous, static, and
 * independent of any setting: it answers from the literals above, so it never
 * needs `DATABASE_URL` or `FEED_GENERATOR_DID`.
 */
export function describeService(): {
  roles: string[];
  methods: { $type: string; value: string }[];
} {
  return {
    roles: [...SERVICE_ROLES],
    methods: serviceMethods().map((value) => ({ $type: NSID, value }))
  };
}
