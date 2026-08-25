import { eq } from 'drizzle-orm';
import { db } from './db';
import { editions, works, contributors, publishers } from './db/schema';
import { PUBLISHER_DID } from './did';
import { getEditionByRkey, getWorkByRkey, getContributorByRkey } from './api/open-library.js';
import { enqueueIngest } from './jobs/enqueue.js';
import pino from 'pino';
import type { Logger } from 'pino';
import type {
  DetailKind,
  DetailValue,
  EditionValue,
  WorkValue,
  ContributorValue,
  PublisherValue,
  Identifier,
  Contribution,
  LoadResult,
} from '$lib/types/record-detail';

export type { DetailKind, DetailValue, LoadResult } from '$lib/types/record-detail';

const COLLECTION: Record<DetailKind, string> = {
  editions: 'community.lexicon.book.edition',
  works: 'community.lexicon.book.work',
  contributors: 'community.lexicon.book.contributor',
  publishers: 'community.lexicon.book.publisher',
};

const log: Logger = pino({ level: 'info', redact: ['password'] });

export function collectionFor(kind: DetailKind): string {
  return COLLECTION[kind];
}

function identFromJson(i: Identifier): Identifier { return { uri: i.uri, resource: i.resource }; }
function contributionFromJson(c: Contribution): Contribution { return { subject: c.subject, role: c.role }; }

export async function loadRecord(kind: DetailKind, rkey: string): Promise<LoadResult> {
  const collection = COLLECTION[kind];
  const uri = `at://${PUBLISHER_DID}/${collection}/${rkey}`;

  if (kind === 'editions') {
    const [row] = await db.select().from(editions).where(eq(editions.uri, uri)).limit(1);
    if (!row) {
      const item = await getEditionByRkey(rkey, log).catch(() => null);
      if (item) {
        enqueueIngest('edition', item).catch(() => {});
        const value: EditionValue = {
          $type: 'community.lexicon.book.edition',
          title: item.title,
          subtitle: item.subtitle,
          place: item.place,
          publishedYear: item.publishedYear,
          language: item.language,
          coverImageUrl: item.coverImageUrl,
          description: item.description,
          contributors: item.contributors as unknown as Contribution[],
          identifiers: item.identifiers,
          createdAt: item.createdAt,
        };
        return { kind, rkey, notFound: false, value };
      }
      return { kind, rkey, notFound: true };
    }
    const value: EditionValue = {
      $type: 'community.lexicon.book.edition',
      title: row.title,
      subtitle: row.subtitle ?? undefined,
      place: row.place ?? undefined,
      publishedYear: row.publishedYear ?? undefined,
      language: row.language ?? undefined,
      coverImageUrl: row.coverImageUrl ?? undefined,
      description: row.description ?? undefined,
      contributors: (row.contributors ?? []).map(contributionFromJson),
      identifiers: (row.identifiers ?? []).map(identFromJson),
      createdAt: row.createdAt.toISOString(),
    };
    return { kind, rkey, notFound: false, value };
  }
  if (kind === 'works') {
    const [row] = await db.select().from(works).where(eq(works.uri, uri)).limit(1);
    if (!row) {
      const item = await getWorkByRkey(rkey, log).catch(() => null);
      if (item) {
        enqueueIngest('work', item).catch(() => {});
        return { kind, rkey, notFound: false, value: {
          $type: 'community.lexicon.book.work',
          title: item.title,
          subtitle: item.subtitle,
          originalLanguage: item.originalLanguage,
          firstPublishedYear: item.firstPublishedYear,
          subjects: item.subjects,
          description: item.description,
          contributors: item.contributors as unknown as Contribution[],
          identifiers: item.identifiers,
          createdAt: item.createdAt,
        }};
      }
      return { kind, rkey, notFound: true };
    }
    const value: WorkValue = {
      $type: 'community.lexicon.book.work',
      title: row.title,
      subtitle: row.subtitle ?? undefined,
      originalLanguage: row.originalLanguage ?? undefined,
      firstPublishedYear: row.firstPublishedYear ?? undefined,
      subjects: row.subjects ?? [],
      description: row.description ?? undefined,
      contributors: (row.contributors ?? []).map(contributionFromJson),
      identifiers: (row.identifiers ?? []).map(identFromJson),
      createdAt: row.createdAt.toISOString(),
    };
    return { kind, rkey, notFound: false, value };
  }
  if (kind === 'contributors') {
    const [row] = await db.select().from(contributors).where(eq(contributors.uri, uri)).limit(1);
    if (!row) {
      const item = await getContributorByRkey(rkey, log).catch(() => null);
      if (item) {
        enqueueIngest('contributor', item).catch(() => {});
        return { kind, rkey, notFound: false, value: {
          $type: 'community.lexicon.book.contributor',
          name: item.name,
          aliases: item.aliases,
          bio: item.bio ?? undefined,
          bornYear: item.bornYear ?? undefined,
          diedYear: item.diedYear ?? undefined,
          linkedDid: item.linkedDid ?? undefined,
          identifiers: item.identifiers,
          createdAt: item.createdAt,
        }};
      }
      return { kind, rkey, notFound: true };
    }
    const value: ContributorValue = {
      $type: 'community.lexicon.book.contributor',
      name: row.name,
      aliases: row.aliases ?? [],
      bio: row.bio ?? undefined,
      bornYear: row.bornYear ?? undefined,
      diedYear: row.diedYear ?? undefined,
      linkedDid: row.linkedDid ?? undefined,
      identifiers: (row.identifiers ?? []).map(identFromJson),
      createdAt: row.createdAt.toISOString(),
    };
    return { kind, rkey, notFound: false, value };
  }
  const [row] = await db.select().from(publishers).where(eq(publishers.uri, uri)).limit(1);
  if (!row) return { kind, rkey, notFound: true };
  const value: PublisherValue = {
    $type: 'community.lexicon.book.publisher',
    name: row.name,
    imprintOf:
      row.imprintOfUri && row.imprintOfCid
        ? { uri: row.imprintOfUri, cid: row.imprintOfCid }
        : undefined,
    foundingDate: row.foundingDate ?? undefined,
    closingDate: row.closingDate ?? undefined,
    identifiers: (row.identifiers ?? []).map(identFromJson),
    createdAt: row.createdAt.toISOString(),
  };
  return { kind, rkey, notFound: false, value };
}