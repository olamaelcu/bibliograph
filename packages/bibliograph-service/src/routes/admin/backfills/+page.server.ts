import type { PageServerLoad } from './$types';
import { requireAdmin } from '$lib/server/admin';
import { db } from '$lib/server/db';
import { sql } from 'drizzle-orm';

const PAGE = 50;

const JOBS = [
  'backfill-edition-cover',
  'backfill-edition-description',
  'backfill-edition-isbn',
  'backfill-edition-format',
  'backfill-contributor-image',
  'backfill-contributor-bio',
  'backfill-shelving-edition',
] as const;

const OUTCOMES = [
  'updated',
  'created',
  'miss',
  'deferred',
  'blocked',
  'invalid',
  'failed',
] as const;

const TYPES = ['edition', 'contributor', 'work'] as const;

export interface BackfillEventView {
  id: number;
  occurredAt: string;
  job: string;
  resourceType: string;
  resourceUri: string;
  resourceRkey: string;
  outcome: string;
  reason: string | null;
  origin: string | null;
  attempts: number;
  maxAttempts: number;
  durationMs: number | null;
  error: string | null;
  label: string | null;
  thumb: string | null;
  linkRkey: string;
}

export const load: PageServerLoad = async ({ url, locals }) => {
  await requireAdmin(locals.viewer, '/admin/backfills');

  const job = url.searchParams.get('job') ?? '';
  const resourceType = url.searchParams.get('type') ?? '';
  const outcome = url.searchParams.get('outcome') ?? '';
  const q = (url.searchParams.get('q') ?? '').trim();
  const cursorRaw = url.searchParams.get('cursor') ?? '';
  const [cursorTs, cursorId] = cursorRaw.split('|', 2);
  const cursorAt = cursorTs ? new Date(cursorTs) : null;
  const cursorIdNum = cursorId ? Number(cursorId) : null;

  // Keyset pagination on (occurred_at, id): stable under concurrent writes.
  const pattern = q === '' ? '' : `%${q}%`;
  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT e.id, e.occurred_at, e.job, e.resource_type, e.resource_uri, e.resource_rkey,
           e.outcome, e.reason, e.origin, e.attempts, e.max_attempts, e.duration_ms, e.error,
           COALESCE(ed.title, sur.title, c.name, w.title) AS label,
           COALESCE(ed.cover_image_url, c.image_url) AS thumb,
           COALESCE(ed.rkey, sur.rkey, c.rkey, w.rkey, e.resource_rkey) AS link_rkey
    FROM backfill_events e
    LEFT JOIN editions ed
      ON ed.uri = e.resource_uri AND e.resource_type = 'edition'
    LEFT JOIN edition_aliases al
      ON al.uri = e.resource_uri AND e.resource_type = 'edition'
    LEFT JOIN editions sur ON sur.tid = al.tid
    LEFT JOIN contributors c
      ON c.uri = e.resource_uri AND e.resource_type = 'contributor'
    LEFT JOIN works w
      ON w.uri = e.resource_uri AND e.resource_type = 'work'
    WHERE (${job} = '' OR e.job = ${job})
      AND (${resourceType} = '' OR e.resource_type = ${resourceType})
      AND (${outcome} = '' OR e.outcome = ${outcome})
      AND (${pattern} = '' OR e.resource_uri ILIKE ${pattern}
           OR COALESCE(ed.title, sur.title, c.name, w.title) ILIKE ${pattern})
      AND (${cursorAt}::timestamptz IS NULL
           OR (e.occurred_at, e.id) < (${cursorAt}, ${cursorIdNum}::bigint))
    ORDER BY e.occurred_at DESC, e.id DESC
    LIMIT ${PAGE + 1}
  `);

  const raw = rows.rows as Array<Record<string, unknown>>;
  const hasMore = raw.length > PAGE;
  const page = hasMore ? raw.slice(0, PAGE) : raw;
  const events: BackfillEventView[] = page.map((row) => {
    const occurred = row.occurred_at;
    return {
      id: Number(row.id),
      occurredAt:
        occurred instanceof Date ? occurred.toISOString() : String(occurred ?? ''),
      job: String(row.job),
      resourceType: String(row.resource_type),
      resourceUri: String(row.resource_uri),
      resourceRkey: String(row.resource_rkey),
      outcome: String(row.outcome),
      reason: (row.reason as string | null) ?? null,
      origin: (row.origin as string | null) ?? null,
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
      error: (row.error as string | null) ?? null,
      label: (row.label as string | null) ?? null,
      thumb: (row.thumb as string | null) ?? null,
      linkRkey: String(row.link_rkey),
    };
  });

  const last = events.at(-1);
  const nextCursor = hasMore && last ? `${last.occurredAt}|${last.id}` : null;

  return {
    events,
    nextCursor,
    filters: { job, type: resourceType, outcome, q },
    jobs: JOBS,
    outcomes: OUTCOMES,
    types: TYPES,
  };
};
