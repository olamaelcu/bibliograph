import type { Logger } from "pino";
import {
  GoodreadsBlockedError,
  fetchGoodreadsBookById,
  fetchGoodreadsSearch,
  type GoodreadsSearchHit,
} from "../api/goodreads";
import { resolveContributorsByName } from "../api/contributor-name-resolver";
import { goodreadsBookUrl, grEditionUri } from "../gr/keys";
import { isbnFromQuery } from "../api/isbndb";
import { providerIdentifier } from "../identifiers";
import type { EditionItem, SearchQuery, SearchResult } from "./types";

/** Goodreads often serves covers from Amazon's media CDN; the cover proxy allows i.gr-assets. */
export function goodreadsCoverUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (
      parsed.hostname === "m.media-amazon.com" ||
      parsed.hostname === "images.gr-assets.com"
    ) {
      parsed.hostname = "i.gr-assets.com";
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function mapHit(
  hit: GoodreadsSearchHit,
  contributors: EditionItem["contributors"],
  createdAt: string,
): EditionItem {
  return {
    uri: grEditionUri(hit.id),
    title: hit.title,
    publishedYear: hit.publishedYear,
    coverImageUrl: goodreadsCoverUrl(hit.coverImageUrl),
    identifiers: [providerIdentifier("goodreads", goodreadsBookUrl(hit.id))],
    contributors,
    createdAt,
  };
}

export async function fetchGoodreadsEdition(
  id: string,
  log: Logger,
  signal?: AbortSignal,
): Promise<EditionItem | null> {
  const book = await fetchGoodreadsBookById(id, signal);
  if (!book?.title) return null;
  const contributors = await resolveContributorsByName(
    book.contributors.map((contributor) => contributor.name),
    "goodreads",
    log,
  );
  return {
    uri: grEditionUri(id),
    title: book.title,
    publishedYear: book.publishedYear,
    coverImageUrl: goodreadsCoverUrl(book.imageUrl),
    pages: book.pages,
    format: book.format,
    identifiers: [providerIdentifier("goodreads", goodreadsBookUrl(id))],
    contributors,
    createdAt: new Date().toISOString(),
  };
}

export class GoodreadsSource {
  constructor(private readonly log: Logger) {}

  /**
   * General title/author search. ISBN queries are deliberately left to the
   * structured providers; this source is for discovery, not lookup.
   */
  async searchEditions(
    query: SearchQuery,
    signal?: AbortSignal,
  ): Promise<SearchResult<EditionItem>> {
    if (!query.q || isbnFromQuery(query.q)) return { items: [], total: 0 };
    try {
      const result = await fetchGoodreadsSearch(query.q, query.limit, signal);
      if (!result) return { items: [], total: 0 };
      const createdAt = new Date().toISOString();
      const items: EditionItem[] = [];
      for (const hit of result.hits) {
        const contributors = await resolveContributorsByName(
          hit.authors,
          "goodreads",
          this.log,
        );
        items.push(mapHit(hit, contributors, createdAt));
      }
      this.log.info(
        {
          stage: "goodreads-source",
          q: query.q,
          items: items.length,
          total: result.total,
        },
        "goodreads ok",
      );
      return { items, total: result.total };
    } catch (err) {
      if (err instanceof GoodreadsBlockedError) {
        this.log.warn(
          { stage: "goodreads-source", status: err.status, q: query.q },
          "goodreads blocked general search",
        );
        return {
          items: [],
          total: 0,
          degraded: { upstream: "goodreads", reason: "blocked" },
        };
      }
      this.log.warn(
        { stage: "goodreads-source", err, q: query.q },
        "goodreads general search failed",
      );
      return {
        items: [],
        total: 0,
        degraded: { upstream: "goodreads", reason: "fetch_failed" },
      };
    }
  }
}
