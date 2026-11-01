import type { Logger } from 'pino';
import * as wikidata from '../api/wikidata';
import type { ContributorItem, EditionItem, WorkItem, Enricher } from './types';

/**
 * Attaches Wikidata identity links to editions and works.
 *
 * Results land in `identifiers` as `wikidata` / `viaf` / `isni` entries rather
 * than new top-level fields: `identifiers` is already the structured-ID channel
 * of `community.lexicon.book.*`, so the links reach clients, persist through
 * sync ingest, and need no lexicon or schema change.
 */
export class WikidataEditionEnricher implements Enricher<EditionItem | WorkItem> {
  readonly name = 'wikidata-enricher-edition';
  enrich<T extends EditionItem | WorkItem>(items: T[], log: Logger, signal?: AbortSignal): Promise<T[]> {
    return wikidata.enrichWithWikidata(items, log, signal);
  }
}

export class WikidataContributorEnricher implements Enricher<ContributorItem> {
  readonly name = 'wikidata-enricher-contributor';
  enrich(items: ContributorItem[], log: Logger, signal?: AbortSignal): Promise<ContributorItem[]> {
    return wikidata.enrichWithWikidata(items, log, signal);
  }
}
