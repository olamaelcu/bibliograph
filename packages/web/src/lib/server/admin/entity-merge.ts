/**
 * Merge one contributor row into another.
 *
 * Contributor identity is `(lower(name), identifiers)`, so the same person can
 * legitimately own several rows whenever a provider supplied a different
 * identifier bag, a different name spelling, or no identifiers at all. Merging
 * absorbs one row into a survivor: the survivor keeps its `id`, `at_uri`,
 * `created_at` and name, takes every blank descriptive field and any identifier
 * the absorbed row had, and every edition credit is repointed at it.
 *
 * The absorbed row is deleted last, after nothing references it any more
 * (`edition_contributors.contributor_id` is `ON DELETE RESTRICT`). Publication
 * is left entirely to the existing triggers: repointing or dropping a credit
 * queues that edition, updating the survivor queues its record and every
 * edition that credits it, and deleting the absorbed row queues its record
 * delete when it has an at-URI.
 *
 * Deliberate limits: an edition that already credits the survivor with the same
 * normalized role drops the absorbed row's credit instead of crediting the same
 * person twice. A credit with a different role is repointed, because one person
 * can legitimately be both author and translator on one edition. An edge `ref`
 * that points at the absorbed row's at-URI is cleared so the read model falls
 * back to the survivor's URI instead of a deleted record.
 *
 * No SvelteKit or environment imports: the route passes `catalogPool()` and the
 * scratch-database tests pass their own pool.
 */

import type { Pool, PoolClient } from 'pg';
import type {
  AdminContributorRecord,
  ContributorMergeField,
  ContributorMergePlan,
  ContributorMergePreview,
  ContributorMergeResponse
} from '../../admin/types.ts';
import { normalizeContributorRole } from '../../contributor-roles.ts';
import { loadAdminEntity } from './entity-read.ts';

export class ContributorMergeError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code: string) {
    super(message);
    this.name = 'ContributorMergeError';
    this.status = status;
    this.code = code;
  }
}

/** Stored identifiers are jsonb; this is the shape the merge preserves. */
type RawIdentifier = { issuer: string; value: string; url?: string };

/** One edition credit, reduced to what the merge decides on. */
type Credit = { editionUri: string; position: number; contributorId: number; role: string };

/** One credit the merge removes or repoints. */
type CreditRef = { editionUri: string; position: number };

const ABSORBED_FIELDS: ReadonlyArray<{ field: ContributorMergeField; column: string }> = [
  { field: 'description', column: 'description' },
  { field: 'nameInverted', column: 'name_inverted' },
  { field: 'imageUrl', column: 'image_url' },
  { field: 'born', column: 'born' },
  { field: 'died', column: 'died' }
];

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function rawIdentifiers(value: unknown): RawIdentifier[] {
  if (!Array.isArray(value)) return [];
  const identifiers: RawIdentifier[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const issuer = 'issuer' in entry ? entry.issuer : undefined;
    const id = 'value' in entry ? entry.value : undefined;
    if (typeof issuer !== 'string' || issuer === '') continue;
    if (typeof id !== 'string' || id === '') continue;
    const url = 'url' in entry ? entry.url : undefined;
    identifiers.push(
      typeof url === 'string' && url !== '' ? { issuer, value: id, url } : { issuer, value: id }
    );
  }
  return identifiers;
}

function isBlank(value: string | null): boolean {
  return value === null || value.trim() === '';
}

type MergePlan = {
  plan: ContributorMergePlan;
  /** Absorbed credits repointed at the survivor, by (edition, position). */
  move: CreditRef[];
  /** Redundant absorbed credits, by (edition, position). */
  drop: CreditRef[];
  /** The survivor's identifier bag after the merge. */
  identifiers: RawIdentifier[];
  /** Column values taken from the absorbed row. */
  absorbed: Array<{ column: string; value: string }>;
};

/**
 * Decide what one merge does. Pure: the preview and the write feed it the rows
 * and credits they read, so neither can disagree about the outcome.
 */
function planMerge(
  source: AdminContributorRecord,
  target: AdminContributorRecord,
  credits: Credit[],
  rawIdentifiersById: Map<number, RawIdentifier[]>
): MergePlan {
  const rolesByEdition = new Map<string, Set<string>>();
  for (const credit of credits) {
    if (credit.contributorId !== target.id) continue;
    const roles = rolesByEdition.get(credit.editionUri) ?? new Set<string>();
    roles.add(normalizeContributorRole(credit.role));
    rolesByEdition.set(credit.editionUri, roles);
  }

  const move: CreditRef[] = [];
  const drop: CreditRef[] = [];
  for (const credit of credits) {
    if (credit.contributorId !== source.id) continue;
    const role = normalizeContributorRole(credit.role);
    const roles = rolesByEdition.get(credit.editionUri) ?? new Set<string>();
    const ref = { editionUri: credit.editionUri, position: credit.position };
    if (roles.has(role)) {
      drop.push(ref);
      continue;
    }
    move.push(ref);
    // A second absorbed credit on the same edition with the same role would
    // otherwise repoint as well and credit the survivor twice.
    roles.add(role);
    rolesByEdition.set(credit.editionUri, roles);
  }

  const identifierBag = new Map<string, RawIdentifier>();
  for (const identifier of rawIdentifiersById.get(target.id) ?? []) {
    identifierBag.set(`${identifier.issuer}\u0000${identifier.value}`, identifier);
  }
  const targetCount = identifierBag.size;
  for (const identifier of rawIdentifiersById.get(source.id) ?? []) {
    const key = `${identifier.issuer}\u0000${identifier.value}`;
    const existing = identifierBag.get(key);
    if (!existing) {
      identifierBag.set(key, identifier);
      continue;
    }
    // The survivor's pair wins, but a provider URL it lacks is worth keeping.
    if (!existing.url && identifier.url) identifierBag.set(key, { ...existing, url: identifier.url });
  }
  const identifiers = [...identifierBag.values()];

  const absorbed: Array<{ column: string; value: string }> = [];
  const fields: ContributorMergeField[] = [];
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
      identifiersAdded: Math.max(identifiers.length - targetCount, 0),
      fields
    },
    move,
    drop,
    identifiers,
    absorbed
  };
}

async function readCredits(client: PoolClient, ids: [number, number]): Promise<Credit[]> {
  const result = await client.query<{
    edition_uri: string;
    position: number;
    contributor_id: string;
    role: string;
  }>(
    `SELECT edition_uri, position, contributor_id, role
       FROM edition_contributors
      WHERE contributor_id = ANY($1::bigint[])`,
    [[ids[0], ids[1]]]
  );
  return result.rows.map((row) => ({
    editionUri: row.edition_uri,
    position: row.position,
    contributorId: Number(row.contributor_id),
    role: row.role
  }));
}

async function readRawIdentifiers(
  client: PoolClient,
  ids: [number, number]
): Promise<Map<number, RawIdentifier[]>> {
  const result = await client.query<{ id: string; identifiers: unknown }>(
    'SELECT id, identifiers FROM contributors WHERE id = ANY($1::bigint[])',
    [[ids[0], ids[1]]]
  );
  return new Map(result.rows.map((row) => [Number(row.id), rawIdentifiers(row.identifiers)]));
}

function refsFrom(input: Record<string, unknown>): { source: string; target: string } {
  const source = stringValue(input.source);
  const target = stringValue(input.target);
  if (!source) {
    throw new ContributorMergeError(400, 'source contributor is required', 'InvalidRequest');
  }
  if (!target) {
    throw new ContributorMergeError(400, 'target contributor is required', 'InvalidRequest');
  }
  return { source, target };
}

function revisionFrom(input: Record<string, unknown>, name: string): string {
  const revision = stringValue(input[name]);
  if (!revision) {
    throw new ContributorMergeError(
      400,
      `${name} is required; reload the editor before merging`,
      'InvalidRequest'
    );
  }
  return revision;
}

function assertDistinct(
  source: AdminContributorRecord,
  target: AdminContributorRecord
): void {
  if (source.id === target.id) {
    throw new ContributorMergeError(
      400,
      'source and target are the same contributor',
      'InvalidRequest'
    );
  }
}

/**
 * Load both rows and their credits without writing anything, for the page's
 * confirmation step. Errors mirror the merge so a preview cannot promise
 * something the merge would refuse.
 */
export async function previewContributorMerge(
  pool: Pool,
  input: { source: string; target: string }
): Promise<ContributorMergePreview> {
  const source = await loadAdminEntity(pool, 'contributor', input.source);
  if (!source) {
    throw new ContributorMergeError(404, `contributor not found: ${input.source}`, 'NotFound');
  }
  const target = await loadAdminEntity(pool, 'contributor', input.target);
  if (!target) {
    throw new ContributorMergeError(404, `contributor not found: ${input.target}`, 'NotFound');
  }
  assertDistinct(source, target);

  const client = await pool.connect();
  try {
    const ids: [number, number] = [source.id, target.id];
    const credits = await readCredits(client, ids);
    const raw = await readRawIdentifiers(client, ids);
    return { source, target, plan: planMerge(source, target, credits, raw).plan };
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
export async function mergeContributors(
  pool: Pool,
  input: unknown
): Promise<ContributorMergeResponse> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ContributorMergeError(400, 'merge body must be an object', 'InvalidRequest');
  }
  const body = input as Record<string, unknown>;
  const { source: sourceRef, target: targetRef } = refsFrom(body);
  const sourceRevision = revisionFrom(body, 'sourceRevision');
  const targetRevision = revisionFrom(body, 'targetRevision');

  let committed:
    | { targetId: number; absorbedId: number; absorbedAtUri: string | null; plan: ContributorMergePlan }
    | undefined;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Resolve first, then lock by ascending id: two merges of the same pair in
    // opposite directions would otherwise deadlock.
    const sourceProbe = await loadAdminEntity(client, 'contributor', sourceRef);
    const targetProbe = await loadAdminEntity(client, 'contributor', targetRef);
    if (!sourceProbe) {
      throw new ContributorMergeError(404, `contributor not found: ${sourceRef}`, 'NotFound');
    }
    if (!targetProbe) {
      throw new ContributorMergeError(404, `contributor not found: ${targetRef}`, 'NotFound');
    }
    assertDistinct(sourceProbe, targetProbe);

    const [firstId, secondId] = [sourceProbe.id, targetProbe.id].sort(
      (left, right) => left - right
    );
    const locked = new Map<number, AdminContributorRecord>();
    for (const id of [firstId, secondId]) {
      const record = await loadAdminEntity(client, 'contributor', String(id), { forUpdate: true });
      if (record) locked.set(record.id, record);
    }
    const source = locked.get(sourceProbe.id);
    const target = locked.get(targetProbe.id);
    if (!source || !target) {
      throw new ContributorMergeError(
        409,
        'a contributor changed while merging; nothing was written',
        'EntityChanged'
      );
    }

    if (source.revision !== sourceRevision) {
      throw new ContributorMergeError(
        409,
        'the absorbed contributor changed since it was loaded; reload before merging',
        'EntityChanged'
      );
    }
    if (target.revision !== targetRevision) {
      throw new ContributorMergeError(
        409,
        'the survivor changed since it was loaded; reload before merging',
        'EntityChanged'
      );
    }

    const ids: [number, number] = [source.id, target.id];
    const credits = await readCredits(client, ids);
    const raw = await readRawIdentifiers(client, ids);
    const decided = planMerge(source, target, credits, raw);

    // Nothing may reference the absorbed row when it is deleted, so every
    // credit is repointed or removed first. Both lists are keyed by
    // (edition, position) because one edition can hold several absorbed credits.
    if (decided.drop.length > 0) {
      await client.query(
        `DELETE FROM edition_contributors
          WHERE contributor_id = $1
            AND (edition_uri, position) IN (
              SELECT * FROM unnest($2::text[], $3::int[])
            )`,
        [
          source.id,
          decided.drop.map((ref) => ref.editionUri),
          decided.drop.map((ref) => ref.position)
        ]
      );
    }
    if (decided.move.length > 0) {
      await client.query(
        `UPDATE edition_contributors
            SET contributor_id = $2,
                ref = CASE WHEN $3::text IS NOT NULL AND ref = $3 THEN NULL ELSE ref END
          WHERE contributor_id = $1
            AND (edition_uri, position) IN (
              SELECT * FROM unnest($4::text[], $5::int[])
            )`,
        [
          source.id,
          target.id,
          source.atUri,
          decided.move.map((ref) => ref.editionUri),
          decided.move.map((ref) => ref.position)
        ]
      );
    }

    const removed = await client.query<{ id: string; at_uri: string | null }>(
      'DELETE FROM contributors WHERE id = $1 RETURNING id, at_uri',
      [source.id]
    );
    const removedRow = removed.rows[0];
    if (!removedRow) {
      throw new ContributorMergeError(
        409,
        'the absorbed contributor changed while merging; nothing was written',
        'EntityChanged'
      );
    }

    // The survivor is updated after the absorbed row is gone: the two bags can
    // be identical after the merge, and `contributors_identity_idx` would
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
      await client.query(`UPDATE contributors SET ${assignments.join(', ')} WHERE id = $1`, params);
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
    if (error instanceof ContributorMergeError) throw error;
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === '23505') {
      throw new ContributorMergeError(
        409,
        'another contributor already has this name and identifier set; merge into that row instead',
        'DuplicateEntity'
      );
    }
    throw error;
  } finally {
    client.release();
  }

  if (!committed) {
    throw new ContributorMergeError(409, 'the merge did not commit', 'EntityChanged');
  }
  const target = await loadAdminEntity(pool, 'contributor', String(committed.targetId));
  if (!target) {
    throw new ContributorMergeError(409, 'the survivor disappeared while merging', 'EntityChanged');
  }
  return {
    target,
    absorbedId: committed.absorbedId,
    absorbedAtUri: committed.absorbedAtUri,
    plan: committed.plan
  };
}
