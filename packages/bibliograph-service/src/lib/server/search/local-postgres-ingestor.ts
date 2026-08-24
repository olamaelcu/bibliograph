import type { Logger } from 'pino';
import { cidForLex } from '@atproto/lex-cbor';
import { db as defaultDb } from '../db/index';
import { editions, works, contributors } from '../db/schema';
import { PUBLISHER_DID } from '../did';
import type { EditionItem, WorkItem, ContributorItem, Ingestor, Identifier } from './types';

type Db = typeof defaultDb;

function rkeyForEdition(olKey: string): string {
  return `ol-edition-${olKey.replace(/^\/books\//, '')}`;
}
function rkeyForWork(olKey: string): string {
  return `ol-work-${olKey.replace(/^\/works\//, '')}`;
}
function rkeyForContributor(olKey: string): string {
  return `ol-author-${olKey.replace(/^\/authors\//, '')}`;
}

function olKeyFromIdentifiers(idents: Identifier[]): string | undefined {
  return idents.find((i) => i.resource === 'openlibrary')?.uri.replace(/^https:\/\/openlibrary\.org/, '');
}

export class LocalPostgresIngestor implements Ingestor<EditionItem | WorkItem | ContributorItem> {
  readonly name = 'local-postgres-ingestor';
  constructor(private readonly log: Logger, private readonly db: Db = defaultDb) {}

  async ingest(items: ReadonlyArray<EditionItem | WorkItem | ContributorItem>): Promise<void> {
    if (items.length === 0) return;
    this.log.info({ stage: this.name, queued: items.length }, 'ingest start');
    try {
      for (const item of items) {
        const olKey = olKeyFromIdentifiers(item.identifiers);
        if (!olKey) continue;
        if ('title' in item && 'publishedYear' in item) {
          await this.ingestEdition(item as EditionItem, olKey);
        } else if ('title' in item && 'subjects' in item) {
          await this.ingestWork(item as WorkItem, olKey);
        } else if ('name' in item) {
          await this.ingestContributor(item as ContributorItem, olKey);
        }
      }
      this.log.info({ stage: this.name, done: items.length }, 'ingest complete');
    } catch (err) {
      this.log.error({ stage: this.name, err }, 'ingest failed');
    }
  }

  private async ingestEdition(item: EditionItem, olKey: string): Promise<void> {
    const rkey = rkeyForEdition(olKey);
    const uri = `at://${PUBLISHER_DID}/community.lexicon.book.edition/${rkey}`;
    const value = {
      $type: 'community.lexicon.book.edition' as const,
      title: item.title,
      subtitle: item.subtitle ?? undefined,
      place: item.place ?? undefined,
      publishedYear: item.publishedYear ?? undefined,
      language: item.language ?? undefined,
      coverImageUrl: item.coverImageUrl ?? undefined,
      contributors: item.contributors,
      identifiers: item.identifiers,
      description: item.description ?? undefined,
      createdAt: item.createdAt,
    };
    const cid = await cidForLex(value as never);
    await this.db.insert(editions).values({
      uri,
      cid: cid.toString(),
      did: PUBLISHER_DID,
      rkey,
      title: item.title,
      subtitle: item.subtitle ?? null,
      place: item.place ?? null,
      publishedYear: item.publishedYear ?? null,
      language: item.language ?? null,
      description: item.description ?? null,
      coverImageUrl: item.coverImageUrl ?? null,
      contributors: item.contributors,
      identifiers: item.identifiers,
      createdAt: new Date(item.createdAt),
    }).onConflictDoUpdate({
      target: editions.uri,
      set: {
        title: item.title,
        subtitle: item.subtitle ?? null,
        description: item.description ?? null,
        coverImageUrl: item.coverImageUrl ?? null,
        identifiers: item.identifiers,
        contributors: item.contributors,
        indexedAt: new Date(),
      },
    });
  }

  private async ingestWork(item: WorkItem, olKey: string): Promise<void> {
    const rkey = rkeyForWork(olKey);
    const uri = `at://${PUBLISHER_DID}/community.lexicon.book.work/${rkey}`;
    const value = {
      $type: 'community.lexicon.book.work' as const,
      title: item.title,
      subtitle: item.subtitle ?? undefined,
      originalLanguage: item.originalLanguage ?? undefined,
      firstPublishedYear: item.firstPublishedYear ?? undefined,
      subjects: item.subjects,
      contributors: item.contributors,
      identifiers: item.identifiers,
      description: item.description ?? undefined,
      createdAt: item.createdAt,
    };
    const cid = await cidForLex(value as never);
    await this.db.insert(works).values({
      uri,
      cid: cid.toString(),
      did: PUBLISHER_DID,
      rkey,
      title: item.title,
      subtitle: item.subtitle ?? null,
      originalLanguage: item.originalLanguage ?? null,
      firstPublishedYear: item.firstPublishedYear ?? null,
      subjects: item.subjects,
      contributors: item.contributors,
      identifiers: item.identifiers,
      description: item.description ?? null,
      createdAt: new Date(item.createdAt),
    }).onConflictDoUpdate({
      target: works.uri,
      set: {
        title: item.title,
        subtitle: item.subtitle ?? null,
        description: item.description ?? null,
        identifiers: item.identifiers,
        contributors: item.contributors,
        indexedAt: new Date(),
      },
    });
  }

  private async ingestContributor(item: ContributorItem, olKey: string): Promise<void> {
    const rkey = rkeyForContributor(olKey);
    const uri = `at://${PUBLISHER_DID}/community.lexicon.book.contributor/${rkey}`;
    const value = {
      $type: 'community.lexicon.book.contributor' as const,
      name: item.name,
      aliases: item.aliases,
      bio: item.bio ?? undefined,
      bornYear: item.bornYear ?? undefined,
      diedYear: item.diedYear ?? undefined,
      linkedDid: item.linkedDid ?? undefined,
      identifiers: item.identifiers,
      createdAt: item.createdAt,
    };
    const cid = await cidForLex(value as never);
    await this.db.insert(contributors).values({
      uri,
      cid: cid.toString(),
      did: PUBLISHER_DID,
      rkey,
      name: item.name,
      aliases: item.aliases,
      linkedDid: item.linkedDid ?? null,
      bio: item.bio ?? null,
      bornYear: item.bornYear ?? null,
      diedYear: item.diedYear ?? null,
      identifiers: item.identifiers,
      createdAt: new Date(item.createdAt),
    }).onConflictDoUpdate({
      target: contributors.uri,
      set: {
        name: item.name,
        aliases: item.aliases,
        bio: item.bio ?? null,
        identifiers: item.identifiers,
        indexedAt: new Date(),
      },
    });
  }
}
