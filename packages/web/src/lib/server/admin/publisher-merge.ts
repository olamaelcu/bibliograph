/**
 * Merge one publisher row into another.
 *
 * Publisher identity is `(lower(name), identifiers)`, so the same imprint can
 * own several rows whenever a provider supplied a different identifier bag, a
 * different spelling, or no identifiers at all. Merging absorbs one row into a
 * survivor: the survivor keeps its `id`, `at_uri`, `created_at` and name, takes
 * every blank descriptive field and any identifier the absorbed row had, and
 * every identifier link is repointed at it.
 *
 * The link table is the publisher analogue of a contributor credit, but its
 * key is the identifier triple `(edition_uri, issuer, value)` plus a position.
 * One identifier can only credit one publisher once, so an absorbed link on a
 * triple the survivor already holds is dropped instead of duplicated; every
 * other link is repointed with its position untouched.
 *
 * The absorbed row is deleted last, after nothing references it any more
 * (`edition_identifier_publishers.publisher_id` is `ON DELETE RESTRICT`).
 * Publication is left entirely to the existing triggers: a changed link queues
 * that edition, updating the survivor's name or identifiers queues every edition
 * that credits it, and deleting the absorbed row queues its record delete when
 * it has an at-URI.
 *
 * No SvelteKit or environment imports: the route passes `catalogPool()` and the
 * scratch-database tests pass their own pool.
 */

import type { Pool, PoolClient } from 'pg';
import type {
  AdminPublisherRecord,
  PublisherMergeField,
  PublisherMergePlan,
  PublisherMergePreview,
  PublisherMergeResponse
} from '../../admin/types.ts';
import {
  isBlank,
  mergeIdentifierBags,
  rawIdentifiers,
  type RawIdentifier
} from './entity-merge.ts';
import { loadAdminEntity } from './entity-read.ts';

export class PublisherMergeError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code: string) {
    super(message);
    this.name = 'PublisherMergeError';
    this.status = status;
    this.code = code;
  }
}

/** One identifier link, reduced to what the merge decides on. */
type Link = {
  editionUri: string;
  issuer: string;
  value: string;
  position: number;
  publisherId: number;
};

const ABSORBED_FIELDS: ReadonlyArray<{ field: PublisherMergeField; column: string }> = [
  { field: 'description', column: 'description' },
  { field: 'imageUrl', column: 'image_url' },
  { field: 'started', column: 'started' },
  { field: 'ended', column: 'ended' }
];

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** The identifier an edition credits: one publisher per `(edition, issuer, value)`. */
function linkKey(link: Link): string {
  return `${link.editionUri}\u0000${link.issuer}\u0000${link.value}`;
}

type MergePlan = {
  plan: PublisherMergePlan;
  /** Absorbed links repointed at the survivor. */
  move: Link[];
  /** Redundant absorbed links, dropped because the survivor already has the identifier. */
  drop: Link[];
  /** The survivor's identifier bag after the merge. */
  identifiers: RawIdentifier[];
  /** Column values taken from the absorbed row. */
  absorbed: Array<{ column: string; value: string }>;
};

/**
 * Decide what one merge does. Pure: the preview and the write feed it the rows
 * and links they read, so neither can disagree about the outcome.
 */
function planMerge(
  source: AdminPublisherRecord,
  target: AdminPublisherRecord,
  links: Link[],
  rawIdentifiersById: Map<number, RawIdentifier[]>
): MergePlan {
  const linked = new Set<string>();
  for (const link of links) {
    if (link.publisherId === target.id) linked.add(linkKey(link));
  }

  const move: Link[] = [];
  const drop: Link[] = [];
  for (const link of links) {
    if (link.publisherId !== source.id) continue;
    const key = linkKey(link);
    if (linked.has(key)) {
      drop.push(link);
      continue;
    }
    move.push(link);
    // A second absorbed link on the same identifier would otherwise repoint as
    // well and credit the survivor twice on it.
    linked.add(key);
  }

  const { identifiers, added: identifiersAdded } = mergeIdentifierBags(
    rawIdentifiersById.get(target.id) ?? [],
    rawIdentifiersById.get(source.id) ?? []
  );

  const absorbed: Array<{ column: string; value: string }> = [];
  const fields: PublisherMergeField[] = [];
  for (const { field, column } of ABSORBED_FIELDS) {
    const next = source[field];
    if (typeof next !== 'string' || isBlank(next)) continue;
    if (!isBlank(target[field])) continue;
    absorbed.push({ column, value: next });
    fields.push(field);
  }

  return {
    plan: {
      moved: move.length,
      dropped: drop.length,
      identifiersAdded,
      fields
    },
    move,
    drop,
    identifiers,
    absorbed
  };
}

async function readLinks(client: PoolClient, ids: [number, number]): Promise<Link[]> {
  const result = await client.query<{
    edition_uri: string;
    issuer: string;
    value: string;
    position: number;
    publisher_id: string;
  }>(
    `SELECT edition_uri, issuer, value, position, publisher_id
       FROM edition_identifier_publishers
      WHERE publisher_id = ANY($1::bigint[])`,
    [[ids[0], ids[1]]]
  );
  return result.rows.map((row) => ({
    editionUri: row.edition_uri,
    issuer: row.issuer,
    value: row.value,
    position: row.position,
    publisherId: Number(row.publisher_id)
  }));
}

async function readRawIdentifiers(
  client: PoolClient,
  ids: [number, number]
): Promise<Map<number, RawIdentifier[]>> {
  const result = await client.query<{ id: string; identifiers: unknown }>(
    'SELECT id, identifiers FROM publishers WHERE id = ANY($1::bigint[])',
    [[ids[0], ids[1]]]
  );
  return new Map(result.rows.map((row) => [Number(row.id), rawIdentifiers(row.identifiers)]));
}

function refsFrom(input: Record<string, unknown>): { source: string; target: string } {
  const source = stringValue(input.source);
  const target = stringValue(input.target);
  if (!source) {
    throw new PublisherMergeError(400, 'source publisher is required', 'InvalidRequest');
  }
  if (!target) {
    throw new PublisherMergeError(400, 'target publisher is required', 'InvalidRequest');
  }
  return { source, target };
}

function revisionFrom(input: Record<string, unknown>, name: string): string {
  const revision = stringValue(input[name]);
  if (!revision) {
    throw new PublisherMergeError(
      400,
      `${name} is required; reload the editor before merging`,
      'InvalidRequest'
    );
  }
  return revision;
}

function assertDistinct(source: AdminPublisherRecord, target: AdminPublisherRecord): void {
  if (source.id === target.id) {
    throw new PublisherMergeError(
      400,
      'source and target are the same publisher',
      'InvalidRequest'
    );
  }
}

/**
 * Load both rows and their links without writing anything, for the page's
 * confirmation step. Errors mirror the merge so a preview cannot promise
 * something the merge would refuse.
 */
export async function previewPublisherMerge(
  pool: Pool,
  input: { source: string; target: string }
): Promise<PublisherMergePreview> {
  const source = await loadAdminEntity(pool, 'publisher', input.source);
  if (!source) {
    throw new PublisherMergeError(404, `publisher not found: ${input.source}`, 'NotFound');
  }
  const target = await loadAdminEntity(pool, 'publisher', input.target);
  if (!target) {
    throw new PublisherMergeError(404, `publisher not found: ${input.target}`, 'NotFound');
  }
  assertDistinct(source, target);

  const client = await pool.connect();
  try {
    const ids: [number, number] = [source.id, target.id];
    const links = await readLinks(client, ids);
    const raw = await readRawIdentifiers(client, ids);
    return { source, target, plan: planMerge(source, target, links, raw).plan };
  } finally {
    client.release();
  }
}

/**
 * Absorb `source` into `target` in one transaction.
 *
 * Both rows must still carry the revisions the operator confirmed: a merge
 * deletes a row and republishes editions, so a concurrent edit is not something
 * to paper over.
 */
export async function mergePublishers(
  pool: Pool,
  input: unknown
): Promise<PublisherMergeResponse> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new PublisherMergeError(400, 'merge body must be an object', 'InvalidRequest');
  }
  const body = input as Record<string, unknown>;
  const { source: sourceRef, target: targetRef } = refsFrom(body);
  const sourceRevision = revisionFrom(body, 'sourceRevision');
  const targetRevision = revisionFrom(body, 'targetRevision');

  let committed:
    | {
        targetId: number;
        absorbedId: number;
        absorbedAtUri: string | null;
        plan: PublisherMergePlan;
      }
    | undefined;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Resolve first, then lock by ascending id: two merges of the same pair in
    // opposite directions would otherwise deadlock.
    const sourceProbe = await loadAdminEntity(client, 'publisher', sourceRef);
    const targetProbe = await loadAdminEntity(client, 'publisher', targetRef);
    if (!sourceProbe) {
      throw new PublisherMergeError(404, `publisher not found: ${sourceRef}`, 'NotFound');
    }
    if (!targetProbe) {
      throw new PublisherMergeError(404, `publisher not found: ${targetRef}`, 'NotFound');
    }
    assertDistinct(sourceProbe, targetProbe);

    const [firstId, secondId] = [sourceProbe.id, targetProbe.id].sort(
      (left, right) => left - right
    );
    const locked = new Map<number, AdminPublisherRecord>();
    for (const id of [firstId, secondId]) {
      const record = await loadAdminEntity(client, 'publisher', String(id), { forUpdate: true });
      if (record) locked.set(record.id, record);
    }
    const source = locked.get(sourceProbe.id);
    const target = locked.get(targetProbe.id);
    if (!source || !target) {
      throw new PublisherMergeError(
        409,
        'a publisher changed while merging; nothing was written',
        'EntityChanged'
      );
    }

    if (source.revision !== sourceRevision) {
      throw new PublisherMergeError(
        409,
        'the absorbed publisher changed since it was loaded; reload before merging',
        'EntityChanged'
      );
    }
    if (target.revision !== targetRevision) {
      throw new PublisherMergeError(
        409,
        'the survivor changed since it was loaded; reload before merging',
        'EntityChanged'
      );
    }

    const ids: [number, number] = [source.id, target.id];
    const links = await readLinks(client, ids);
    const raw = await readRawIdentifiers(client, ids);
    const decided = planMerge(source, target, links, raw);

    // Nothing may reference the absorbed row when it is deleted, so every link
    // is repointed or removed first.
    if (decided.drop.length > 0) {
      await client.query(
        `DELETE FROM edition_identifier_publishers
          WHERE publisher_id = $1
            AND (edition_uri, issuer, value) IN (
              SELECT * FROM unnest($2::text[], $3::text[], $4::text[])
            )`,
        [
          source.id,
          decided.drop.map((link) => link.editionUri),
          decided.drop.map((link) => link.issuer),
          decided.drop.map((link) => link.value)
        ]
      );
    }
    if (decided.move.length > 0) {
      await client.query(
        `UPDATE edition_identifier_publishers
            SET publisher_id = $2
          WHERE publisher_id = $1
            AND (edition_uri, issuer, value) IN (
              SELECT * FROM unnest($3::text[], $4::text[], $5::text[])
            )`,
        [
          source.id,
          target.id,
          decided.move.map((link) => link.editionUri),
          decided.move.map((link) => link.issuer),
          decided.move.map((link) => link.value)
        ]
      );
    }

    const removed = await client.query<{ id: string; at_uri: string | null }>(
      'DELETE FROM publishers WHERE id = $1 RETURNING id, at_uri',
      [source.id]
    );
    const removedRow = removed.rows[0];
    if (!removedRow) {
      throw new PublisherMergeError(
        409,
        'the absorbed publisher changed while merging; nothing was written',
        'EntityChanged'
      );
    }

    // The survivor is updated after the absorbed row is gone: the two bags can
    // be identical after the merge, and `publishers_identity_idx` would
    // otherwise reject the update against the row being deleted.
    const assignments: string[] = [];
    const params: unknown[] = [target.id];
    const set = (column: string, value: unknown): void => {
      params.push(value);
      assignments.push(`${column} = $${params.length}`);
    };
    for (const { column, value } of decided.absorbed) set(column, value);
    const targetBag = raw.get(target.id) ?? [];
    if (decided.identifiers.length !== targetBag.length) {
      params.push(JSON.stringify(decided.identifiers));
      assignments.push(`identifiers = $${params.length}::jsonb`);
    }
    if (assignments.length > 0) {
      await client.query(`UPDATE publishers SET ${assignments.join(', ')} WHERE id = $1`, params);
    }

    await client.query('COMMIT');
    committed = {
      targetId: target.id,
      absorbedId: Number(removedRow.id),
      absorbedAtUri: removedRow.at_uri,
      plan: decided.plan
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error instanceof PublisherMergeError) throw error;
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === '23505') {
      throw new PublisherMergeError(
        409,
        'another publisher already has this name and identifier set; merge into that row instead',
        'DuplicateEntity'
      );
    }
    throw error;
  } finally {
    client.release();
  }

  if (!committed) {
    throw new PublisherMergeError(409, 'the merge did not commit', 'EntityChanged');
  }
  const target = await loadAdminEntity(pool, 'publisher', String(committed.targetId));
  if (!target) {
    throw new PublisherMergeError(409, 'the survivor disappeared while merging', 'EntityChanged');
  }
  return {
    target,
    absorbedId: committed.absorbedId,
    absorbedAtUri: committed.absorbedAtUri,
    plan: committed.plan
  };
}
