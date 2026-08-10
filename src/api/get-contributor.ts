import type { Context } from 'hono';
import { desc, eq, like, or, sql } from 'drizzle-orm';
import { db, schema } from '../db/connection.js';
import { parsePagination, nextCursor } from '../pagination.js';
import {
  serializeContributor,
  serializeContributorType,
} from './contributor.js';
import type {
  ListContributorsParams,
  ListContributorsOutput,
  ListContributorTypesParams,
  ListContributorTypesOutput,
  SearchContributorsParams,
  SearchContributorsOutput,
} from '../types.js';

const { contributors, contributorTypes } = schema;

const SERVICE_DID = process.env.ATP_SERVICE_DID ?? 'did:web:localhost';

export async function listContributors(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const { limit = '50', cursor } = c.req.query();
  const { limit: lim, offset } = parsePagination(limit, cursor, 50, 100);

  log.info({ limit: lim }, 'handling listContributors');

  const rows = await db
    .select()
    .from(contributors)
    .orderBy(desc(contributors.createdAt))
    .limit(lim)
    .offset(offset)
    .all();

  const cursorOut = nextCursor(rows.length, offset, lim);

  log.info({ found: rows.length, hasCursor: !!cursorOut }, 'listContributors complete');

  const out: ListContributorsOutput = {
    contributors: rows.map((r) => ({
      uri: r.uri,
      did: r.did,
      record: serializeContributor(r),
    })),
  };
  if (cursorOut) out.cursor = cursorOut;
  out.total = rows.length;
  return c.json(out);
}

export async function searchContributors(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const { q, limit = '20', cursor } = c.req.query() as {
    q?: string;
    limit?: string;
    cursor?: string;
  } as SearchContributorsParams & { limit?: string };
  if (!q || !q.trim()) {
    log.warn('searchContributors rejected: missing q');
    return c.json({ error: 'InvalidRequest', message: 'q is required' }, 400);
  }

  const { limit: lim, offset } = parsePagination(limit, cursor, 20, 100);

  const sanitized = q.replace(/['"]/g, '').trim();
  log.info({ q: sanitized, limit: lim }, 'handling searchContributors');

  const pattern = `%${sanitized}%`;
  const rows = await db
    .select()
    .from(contributors)
    .where(
      or(
        like(sql`lower(${contributors.name})`, sql`lower(${pattern})`),
        sql`EXISTS (SELECT 1 FROM json_each(${contributors.altNames}) je WHERE lower(je.value) LIKE lower(${pattern}))`,
      ),
    )
    .orderBy(desc(contributors.createdAt))
    .limit(lim)
    .offset(offset)
    .all();

  const cursorOut = nextCursor(rows.length, offset, lim);

  log.info({ found: rows.length, hasCursor: !!cursorOut }, 'searchContributors complete');

  const out: SearchContributorsOutput = {
    contributors: rows.map((r) => ({
      uri: r.uri,
      did: r.did,
      record: serializeContributor(r),
    })),
    total: rows.length,
  };
  if (cursorOut) out.cursor = cursorOut;
  return c.json(out);
}

export async function listContributorTypes(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const { limit = '50', cursor } = c.req.query();
  const { limit: lim, offset } = parsePagination(limit, cursor, 50, 100);

  log.info({ limit: lim }, 'handling listContributorTypes');

  const rows = await db
    .select()
    .from(contributorTypes)
    .where(eq(contributorTypes.did, SERVICE_DID))
    .orderBy(contributorTypes.name)
    .limit(lim)
    .offset(offset)
    .all();

  const cursorOut = nextCursor(rows.length, offset, lim);

  log.info({ found: rows.length, hasCursor: !!cursorOut }, 'listContributorTypes complete');

  const out: ListContributorTypesOutput = {
    types: rows.map((r) => ({
      uri: r.uri,
      did: r.did,
      record: serializeContributorType(r),
    })),
  };
  if (cursorOut) out.cursor = cursorOut;
  out.total = rows.length;
  return c.json(out);
}
