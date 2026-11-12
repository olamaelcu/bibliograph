/**
 * Admin contributor and publisher rows, with the canonical at-URI and the
 * content revision the dedicated editors use as an optimistic concurrency
 * token.
 *
 * This module has no SvelteKit or environment imports so node tests can drive
 * it with a scratch pool. The route passes `catalogPool()`; the update path
 * passes its own transaction client.
 */

import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  AdminContributorRecord,
  AdminPublisherRecord,
  Identifier
} from '../../admin/types.ts';
import type { EntityKind } from '../../admin/entity-edit.ts';

export type Queryable = Pool | PoolClient;

export type EntityRow = {
  id: string;
  at_uri: string | null;
  name: string;
  identifiers: Identifier[] | null;
  description: string | null;
  image_url: string | null;
  created_at: Date;
  name_inverted?: string | null;
  born?: string | null;
  died?: string | null;
  started?: string | null;
  ended?: string | null;
};

const TABLES: Record<EntityKind, string> = {
  contributor: 'contributors',
  publisher: 'publishers'
};

const COLUMNS: Record<EntityKind, string> = {
  contributor: `
    id, at_uri, name, name_inverted, identifiers, description, image_url,
    born, died, created_at`,
  publisher: `
    id, at_uri, name, identifiers, description, image_url,
    started, ended, created_at`
};

/** Stored identifiers are jsonb; keep the issuer/value pairs the editors use. */
function asIdentifiers(value: unknown): Identifier[] {
  if (!Array.isArray(value)) return [];
  const identifiers: Identifier[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const issuer = 'issuer' in entry ? entry.issuer : undefined;
    const id = 'value' in entry ? entry.value : undefined;
    if (typeof issuer !== 'string' || issuer === '') continue;
    if (typeof id !== 'string' || id === '') continue;
    identifiers.push({ issuer, value: id });
  }
  return identifiers;
}

function nullableText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  return value === '' ? null : value;
}

/**
 * Content revision used by the editor as an optimistic concurrency token.
 *
 * Only values an edit can change participate, and identifiers keep their stored
 * order because the editor shows them as a list. `id`, `at_uri` and `createdAt`
 * never participate: an upload can mint an at-URI without the editor's row
 * changing, and that must not look like a concurrent edit.
 */
export function entityRevision(kind: EntityKind, record: AdminContributorRecord | AdminPublisherRecord): string {
  const shared = {
    name: record.name,
    identifiers: record.identifiers.map((identifier) => ({
      issuer: identifier.issuer,
      value: identifier.value
    })),
    description: record.description,
    imageUrl: record.imageUrl
  };
  const fields =
    kind === 'contributor'
      ? {
          ...shared,
          nameInverted: (record as AdminContributorRecord).nameInverted,
          born: (record as AdminContributorRecord).born,
          died: (record as AdminContributorRecord).died
        }
      : {
          ...shared,
          started: (record as AdminPublisherRecord).started,
          ended: (record as AdminPublisherRecord).ended
        };
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

export function entityRecord(
  kind: 'contributor',
  row: EntityRow
): AdminContributorRecord;
export function entityRecord(kind: 'publisher', row: EntityRow): AdminPublisherRecord;
export function entityRecord(
  kind: EntityKind,
  row: EntityRow
): AdminContributorRecord | AdminPublisherRecord;
export function entityRecord(
  kind: EntityKind,
  row: EntityRow
): AdminContributorRecord | AdminPublisherRecord {
  const shared = {
    id: Number(row.id),
    atUri: row.at_uri,
    name: row.name,
    identifiers: asIdentifiers(row.identifiers),
    description: nullableText(row.description),
    imageUrl: nullableText(row.image_url),
    createdAt: new Date(row.created_at).toISOString(),
    revision: ''
  };

  if (kind === 'contributor') {
    const record: AdminContributorRecord = {
      ...shared,
      nameInverted: nullableText(row.name_inverted),
      born: nullableText(row.born),
      died: nullableText(row.died)
    };
    record.revision = entityRevision('contributor', record);
    return record;
  }

  const record: AdminPublisherRecord = {
    ...shared,
    started: nullableText(row.started),
    ended: nullableText(row.ended)
  };
  record.revision = entityRevision('publisher', record);
  return record;
}

/** Accept a numeric row id, or an at-URI left percent-encoded by a proxy. */
function normalizeRef(raw: string): string {
  const ref = raw.trim();
  if (ref.startsWith('at://')) return ref;
  if (/%3A/i.test(ref)) {
    try {
      const decoded = decodeURIComponent(ref);
      if (decoded.startsWith('at://')) return decoded;
    } catch {
      // Keep the raw value; the lookup below turns it into a 404.
    }
  }
  return ref;
}

function rowId(ref: string): number | null {
  if (!/^\d+$/.test(ref)) return null;
  const id = Number(ref);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Load one contributor or publisher by row id or canonical at-URI. Unknown
 * refs and the other entity's at-URI answer null (the route maps that to 404).
 */
export async function loadAdminEntity(
  client: Queryable,
  kind: 'contributor',
  ref: string,
  options?: { forUpdate?: boolean }
): Promise<AdminContributorRecord | null>;
export async function loadAdminEntity(
  client: Queryable,
  kind: 'publisher',
  ref: string,
  options?: { forUpdate?: boolean }
): Promise<AdminPublisherRecord | null>;
export async function loadAdminEntity(
  client: Queryable,
  kind: EntityKind,
  ref: string,
  options?: { forUpdate?: boolean }
): Promise<AdminContributorRecord | AdminPublisherRecord | null>;
export async function loadAdminEntity(
  client: Queryable,
  kind: EntityKind,
  ref: string,
  options: { forUpdate?: boolean } = {}
): Promise<AdminContributorRecord | AdminPublisherRecord | null> {
  const normalized = normalizeRef(ref);
  const id = rowId(normalized);
  const lock = options.forUpdate ? 'FOR UPDATE' : '';
  const result =
    id === null
      ? await client.query<EntityRow>(
          `SELECT ${COLUMNS[kind]}
             FROM ${TABLES[kind]}
            WHERE at_uri = $1 ${lock}`,
          [normalized]
        )
      : await client.query<EntityRow>(
          `SELECT ${COLUMNS[kind]}
             FROM ${TABLES[kind]}
            WHERE id = $1 ${lock}`,
          [id]
        );
  const row = result.rows[0];
  if (!row) return null;
  return entityRecord(kind, row);
}

/**
 * Stored identifiers may carry a `url` the admin form does not edit. Keep it
 * for pairs that survive an identifier replacement, so a rename does not drop
 * provider links.
 */
export function mergeIdentifierUrls(
  stored: unknown,
  next: Array<{ issuer: string; value: string }>
): Array<{ issuer: string; value: string; url?: string }> {
  const urls = new Map<string, string>();
  if (Array.isArray(stored)) {
    for (const entry of stored) {
      if (entry === null || typeof entry !== 'object') continue;
      const issuer = 'issuer' in entry ? entry.issuer : undefined;
      const value = 'value' in entry ? entry.value : undefined;
      const url = 'url' in entry ? entry.url : undefined;
      if (typeof issuer !== 'string' || typeof value !== 'string') continue;
      if (typeof url !== 'string' || url === '') continue;
      urls.set(`${issuer}\u0000${value}`, url);
    }
  }
  return next.map((identifier) => {
    const url = urls.get(`${identifier.issuer}\u0000${identifier.value}`);
    return url ? { ...identifier, url } : { ...identifier };
  });
}
