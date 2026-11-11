import type { Logger } from 'pino';
import type { JobHelpers, Task } from 'graphile-worker';

/** A backfill task that classifies its own outcome instead of returning void. */
export type AuditedTask = (
  payload: unknown,
  helpers: JobHelpers,
) => Promise<BackfillRunResult | void>;
import { db as defaultDb } from '../db/index';
import { backfillEvents } from '../db/schema';

/**
 * Append-only audit of backfill jobs: one row per meaningful execution,
 * hydrated at read time against the catalog. Never blocks a backfill —
 * an audit write that fails is logged and swallowed.
 *
 * Only terminal-interesting outcomes are recorded (see `INTERESTING`); the
 * scan mostly re-asks rows and the "already satisfied" no-ops are noise.
 */

export type BackfillOutcome =
  | 'updated'
  | 'created'
  | 'already'
  | 'miss'
  | 'absent'
  | 'deferred'
  | 'blocked'
  | 'invalid'
  | 'failed';

export type BackfillResourceType = 'edition' | 'contributor' | 'work';
export type BackfillSource = 'scan' | 'on-read' | 'admin' | 'tap' | 'manual';

export interface BackfillRunResult {
  /** Raw module reason (used for the normalized outcome and kept for display). */
  reason?: string;
  detail?: Record<string, unknown>;
}

/** Terminal-interesting outcomes only; `already`/`absent` are the scan's noise floor. */
const INTERESTING: Record<BackfillOutcome, boolean> = {
  updated: true,
  created: true,
  miss: true,
  deferred: true,
  blocked: true,
  invalid: true,
  failed: true,
  already: false,
  absent: false,
};

/** Raw module reasons → normalized outcome. Unknown → `invalid` (kept, visible). */
const REASON_MAPS: Record<string, Record<string, BackfillOutcome>> = {
  'backfill-edition-description': {
    ok: 'updated',
    already_has_description: 'already',
    deferred: 'deferred',
    no_description_found: 'miss',
    not_found: 'absent',
    update_missed: 'absent',
    missing_identifiers: 'invalid',
  },
  'backfill-edition-cover': {
    ok: 'updated',
    already_has_cover: 'already',
    no_cover_found: 'miss',
    not_found: 'absent',
    update_missed: 'absent',
    missing_identifiers: 'invalid',
  },
  'backfill-edition-isbn': {
    ok: 'updated',
    already_has_isbn: 'already',
    found: 'miss',
    shadow: 'miss',
    ambiguous: 'miss',
    none: 'miss',
    not_found: 'absent',
    not_catalog_record: 'invalid',
    missing_identifiers: 'invalid',
    update_missed: 'absent',
  },
  'backfill-edition-format': {
    updated: 'updated',
    no_isbn: 'already',
    already_complete: 'already',
    no_change: 'already',
    not_found: 'miss',
    blocked: 'blocked',
  },
  'backfill-contributor-image': {
    ok: 'updated',
    already_checked: 'already',
    already_has_image: 'already',
    deferred: 'deferred',
    no_image_found: 'miss',
    not_found: 'absent',
  },
  'backfill-contributor-bio': {
    ok: 'updated',
    already_has_bio: 'already',
    no_bio_found: 'miss',
    not_found: 'absent',
    update_missed: 'absent',
  },
  'backfill-shelving-edition': {
    created: 'created',
    already_present: 'already',
    provider_miss: 'miss',
  },
};

export function mapReason(job: string, raw: string | undefined): BackfillOutcome {
  if (raw === undefined) return 'invalid';
  return REASON_MAPS[job]?.[raw] ?? 'invalid';
}

function payloadFields(payload: unknown): { uri: string; rkey: string; source?: BackfillSource } {
  const p = payload as { uri?: unknown; rkey?: unknown; source?: unknown } | undefined;
  const uri = typeof p?.uri === 'string' ? p.uri : '';
  const rkey = typeof p?.rkey === 'string' ? p.rkey : (uri.split('/').pop() ?? '');
  const source = typeof p?.source === 'string' ? (p.source as BackfillSource) : undefined;
  return { uri, rkey, source };
}

async function insertEvent(
  log: Logger,
  event: typeof backfillEvents.$inferInsert,
): Promise<void> {
  try {
    await defaultDb.insert(backfillEvents).values(event);
  } catch (err) {
    // Audit is observability: a lost row must never fail the backfill itself.
    log.error({ err, job: event.job, stage: 'backfill-audit' }, 'backfill audit insert failed');
  }
}

/**
 * Wrap a backfill task so each execution appends one `backfill_events` row.
 * The wrapped task's return value is used only for classification: throw →
 * `failed` (and rethrown for graphile to retry); otherwise the raw `reason`
 * maps through `REASON_MAPS`. Only interesting outcomes are persisted.
 */
export function auditedBackfill(
  job: string,
  resourceType: BackfillResourceType,
  task: (payload: unknown, helpers: JobHelpers) => Promise<BackfillRunResult | void>,
): Task {
  return async (payload: unknown, helpers: JobHelpers) => {
    const log = helpers.logger as unknown as Logger;
    const { uri, rkey, source } = payloadFields(payload);
    const started = Date.now();
    const jobId = helpers.job.id ? Number(helpers.job.id) : undefined;
    const attempt = helpers.job.attempts;
    const maxAttempts = helpers.job.max_attempts;
    const base = {
      job,
      resourceType,
      resourceUri: uri,
      resourceRkey: rkey,
      reason: undefined as string | undefined,
      origin: source,
      attempts: attempt,
      maxAttempts,
      jobId,
      jobKey: helpers.job.key ?? undefined,
      enqueuedAt: helpers.job.created_at,
    };
    let res: BackfillRunResult | void;
    try {
      res = await task(payload, helpers);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await insertEvent(log, {
        ...base,
        outcome: 'failed',
        reason: message.slice(0, 200),
        durationMs: Date.now() - started,
        error: message.slice(0, 500),
      });
      throw err;
    }
    const outcome = mapReason(job, res?.reason);
    if (!INTERESTING[outcome]) return;
    await insertEvent(log, {
      ...base,
      outcome,
      reason: res?.reason,
      detail: res?.detail,
      durationMs: Date.now() - started,
    });
  };
}

/** Test seam: the outcome table, exported for unit coverage. */
export { REASON_MAPS };
