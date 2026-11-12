/**
 * Atomic writes for the dedicated admin contributor and publisher editors.
 *
 * The browser sends the whole editable row; this module validates it once,
 * locks the row and updates only the columns that differ, in one transaction.
 * `id`, `at_uri` and `created_at` are never written. The catalog triggers do the
 * publication work: an entity trigger queues the row's own record, and the
 * `AFTER UPDATE OF name, identifiers` triggers (0001) queue every edition that
 * credits the row. The editor never writes `pds_outbox` and never deletes an
 * entity.
 *
 * No SvelteKit or environment imports: the route passes `catalogPool()` and the
 * scratch-database tests pass their own pool.
 */

import type { Pool } from 'pg';
import type {
  AdminContributorRecord,
  AdminPublisherRecord,
  Identifier
} from '../../admin/types.ts';
import {
  parseEntityEdit,
  type ContributorEditInput,
  type EntityKind,
  type PublisherEditInput
} from '../../admin/entity-edit.ts';
import {
  loadAdminEntity,
  mergeIdentifierUrls
} from './entity-read.ts';

const TABLES: Record<EntityKind, string> = {
  contributor: 'contributors',
  publisher: 'publishers'
};

export class EntityEditError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field?: string;

  constructor(status: number, message: string, code: string, field?: string) {
    super(message);
    this.name = 'EntityEditError';
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

/** The identity is `(lower(name), identifiers)`; order does not change it. */
function sameIdentifierBag(
  current: Identifier[],
  next: Array<{ issuer: string; value: string }>
): boolean {
  if (current.length !== next.length) return false;
  const stored = new Set(
    current.map((identifier) => `${identifier.issuer}\u0000${identifier.value}`)
  );
  return next.every((identifier) => stored.has(`${identifier.issuer}\u0000${identifier.value}`));
}

export async function updateAdminEntity(
  pool: Pool,
  kind: 'contributor',
  ref: string,
  body: unknown
): Promise<AdminContributorRecord>;
export async function updateAdminEntity(
  pool: Pool,
  kind: 'publisher',
  ref: string,
  body: unknown
): Promise<AdminPublisherRecord>;
export async function updateAdminEntity(
  pool: Pool,
  kind: EntityKind,
  ref: string,
  body: unknown
): Promise<AdminContributorRecord | AdminPublisherRecord> {
  const parsed = parseEntityEdit(kind, body);
  if (parsed.value === null) {
    const first = parsed.errors[0];
    throw new EntityEditError(
      400,
      first?.path ? `${first.path}: ${first.message}` : (first?.message ?? `invalid ${kind}`),
      'InvalidEntity',
      first?.path
    );
  }
  const input = parsed.value;
  const table = TABLES[kind];

  const client = await pool.connect();
  let id: number | null = null;
  try {
    await client.query('BEGIN');

    const current = await loadAdminEntity(client, kind, ref, { forUpdate: true });
    if (!current) {
      throw new EntityEditError(404, `${kind} not found`, 'NotFound');
    }
    id = current.id;

    if (input.expectedRevision !== null && input.expectedRevision !== current.revision) {
      throw new EntityEditError(
        409,
        `this ${kind} changed since it was loaded; reload before saving`,
        'EntityChanged'
      );
    }

    const assignments: string[] = [];
    const params: unknown[] = [];
    const set = (column: string, value: unknown): void => {
      params.push(value);
      assignments.push(`${column} = $${params.length}`);
    };
    const setJson = (column: string, value: unknown): void => {
      params.push(JSON.stringify(value));
      assignments.push(`${column} = $${params.length}::jsonb`);
    };

    if (input.name !== current.name) set('name', input.name);
    if (input.description !== current.description) set('description', input.description);
    if (input.imageUrl !== current.imageUrl) set('image_url', input.imageUrl);

    if (kind === 'contributor') {
      const contributor = input as ContributorEditInput;
      const record = current as AdminContributorRecord;
      if (contributor.nameInverted !== record.nameInverted) {
        set('name_inverted', contributor.nameInverted);
      }
      if (contributor.born !== record.born) set('born', contributor.born);
      if (contributor.died !== record.died) set('died', contributor.died);
    } else {
      const publisher = input as PublisherEditInput;
      const record = current as AdminPublisherRecord;
      if (publisher.started !== record.started) set('started', publisher.started);
      if (publisher.ended !== record.ended) set('ended', publisher.ended);
    }

    if (!sameIdentifierBag(current.identifiers, input.identifiers)) {
      // Read the raw bag so provider-supplied `url` values survive the rewrite
      // for every pair the editor kept.
      const stored = await client.query<{ identifiers: unknown }>(
        `SELECT identifiers FROM ${table} WHERE id = $1`,
        [current.id]
      );
      setJson(
        'identifiers',
        mergeIdentifierUrls(stored.rows[0]?.identifiers, input.identifiers)
      );
    }

    if (assignments.length > 0) {
      params.push(current.id);
      await client.query(
        `UPDATE ${table} SET ${assignments.join(', ')} WHERE id = $${params.length}`,
        params
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error instanceof EntityEditError) throw error;
    if (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === '23505'
    ) {
      throw new EntityEditError(
        409,
        `another ${kind} already uses this normalized name and identifier set; ` +
          'merge the rows instead of renaming this one',
        'DuplicateEntity',
        'name'
      );
    }
    throw error;
  } finally {
    client.release();
  }

  if (id === null) throw new EntityEditError(404, `${kind} not found`, 'NotFound');
  const saved = await loadAdminEntity(pool, kind, String(id));
  if (!saved) throw new EntityEditError(404, `${kind} not found after saving`, 'NotFound');
  return saved;
}
