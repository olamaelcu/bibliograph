import { inArray } from 'drizzle-orm';
import { db } from './db';
import { contributors } from './db/schema';

/**
 * Shape the platform's `BookContributorSchema` expects for every
 * `contributors[]` element on a `community.lexicon.book.edition` /
 * `community.lexicon.book.work` record value. The internal `ContributionEntry`
 * strongRef (`{subject:{uri,cid}, role}`) can't stand on its own — the
 * platform validates `bookUri` + a full `contributor` object per entry.
 */
export interface BookContributorView {
  bookUri: string;
  contributor: BookContributorSubject;
  role: string;
}

/**
 * Subset of the platform's `ContributorSchema` we populate from the local
 * `contributors` table. Only fields we actually store are listed; the
 * remaining optional fields (`sortName`, `bio`, `imageUrl`, `updatedAt`)
 * fall through as `undefined`.
 */
export interface BookContributorSubject {
  uri: string;
  name: string;
  identifiers: Array<{ uri: string; resource: string }>;
  createdAt: string;
}

export interface ContributorSubjectRow {
  uri: string;
  name: string;
  identifiers: Array<{ uri: string; resource: string }> | null;
  createdAt: Date;
}

export async function buildBookContributorViews(
  bookUri: string,
  rawContributors: unknown,
): Promise<BookContributorView[]> {
  const entries = parseContributionEntries(rawContributors);
  if (entries.length === 0) return [];
  const uris = [...new Set(entries.map((e) => e.subject.uri))];
  const rows = await db
    .select({
      uri: contributors.uri,
      name: contributors.name,
      identifiers: contributors.identifiers,
      createdAt: contributors.createdAt,
    })
    .from(contributors)
    .where(inArray(contributors.uri, uris));
  const byUri = new Map(rows.map((r) => [r.uri, r]));
  const out: BookContributorView[] = [];
  for (const entry of entries) {
    const row = byUri.get(entry.subject.uri);
    if (!row) continue;
    out.push({
      bookUri,
      role: entry.role,
      contributor: {
        uri: row.uri,
        name: row.name,
        identifiers: row.identifiers ?? [],
        createdAt: row.createdAt.toISOString(),
      },
    });
  }
  return out;
}

interface ParsedContributionEntry {
  subject: { uri: string; cid: string };
  role: string;
}

function parseContributionEntries(raw: unknown): ParsedContributionEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ParsedContributionEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const subject = entry.subject;
    const role = entry.role;
    if (
      !subject || typeof subject !== 'object' ||
      typeof (subject as { uri?: unknown }).uri !== 'string' ||
      typeof role !== 'string'
    ) {
      continue;
    }
    const subjectObj = subject as { uri: string; cid?: unknown };
    out.push({
      subject: { uri: subjectObj.uri, cid: typeof subjectObj.cid === 'string' ? subjectObj.cid : '' },
      role,
    });
  }
  return out;
}
