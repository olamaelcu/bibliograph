// `senior-librarian`: recognition for librarians who have actually been around.
//
// Tenure alone is gameable (apply, leave, come back in a year), so eligibility
// requires both a minimum time since the FIRST librarian label was issued and a
// minimum number of votes cast. Both thresholds are configurable because the
// right numbers are a policy call, not a protocol one.
//
// This runs as a one-shot job (scripts/issue-tenure-labels.ts) rather than on the
// request path: it scans every label and is idempotent, so running it daily is
// cheap and safe.

import { count, desc, eq } from 'drizzle-orm';
import { db as defaultDb } from '../db/index';
import { editionWorkVotes, labels } from '../db/schema';
import type { DbExecutor } from '../stats';
import { grantLabel, hasLabel } from './labels';
import { SENIOR_LIBRARIAN_LABEL } from './vocabulary';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SeniorityPolicy {
  minDays: number;
  minVotes: number;
}

export function seniorityPolicy(
  minDaysRaw: string | undefined = process.env.SENIOR_LIBRARIAN_MIN_DAYS,
  minVotesRaw: string | undefined = process.env.SENIOR_LIBRARIAN_MIN_VOTES,
): SeniorityPolicy {
  const minDays = Number(minDaysRaw);
  const minVotes = Number(minVotesRaw);
  return {
    minDays: Number.isFinite(minDays) && minDays >= 0 ? Math.floor(minDays) : 365,
    minVotes: Number.isFinite(minVotes) && minVotes >= 0 ? Math.floor(minVotes) : 10,
  };
}

export interface SeniorityReport {
  did: string;
  tenureDays: number;
  votes: number;
  eligible: boolean;
  alreadySenior: boolean;
}

/**
 * Compute who qualifies, without writing anything. Exposed separately so the
 * decision is testable and an operator can dry-run it.
 */
export async function evaluateSeniority(
  policy: SeniorityPolicy = seniorityPolicy(),
  now: Date = new Date(),
  db: DbExecutor = defaultDb,
): Promise<SeniorityReport[]> {
  const rows = await db
    .select({ uri: labels.uri, val: labels.val, cts: labels.cts, neg: labels.neg, seq: labels.seq })
    .from(labels)
    .where(eq(labels.val, 'librarian'))
    .orderBy(labels.uri, desc(labels.cts), desc(labels.seq));

  // First issuance and current standing, per account.
  const firstIssued = new Map<string, Date>();
  const currentlyActive = new Map<string, boolean>();
  for (const row of rows) {
    if (row.neg) continue;
    const seen = firstIssued.get(row.uri);
    if (!seen || row.cts < seen) firstIssued.set(row.uri, row.cts);
  }
  // `rows` is ordered newest-first per account, so the first non-negated row we
  // meet for an account is its current state.
  for (const row of rows) {
    if (!currentlyActive.has(row.uri)) currentlyActive.set(row.uri, !row.neg);
  }

  const activeDids = [...currentlyActive.entries()]
    .filter(([, active]) => active)
    .map(([did]) => did)
    .filter((did) => firstIssued.has(did));

  if (activeDids.length === 0) return [];

  const voteCounts = new Map<string, number>();
  const counts = await db
    .select({ did: editionWorkVotes.voterDid, c: count() })
    .from(editionWorkVotes)
    .groupBy(editionWorkVotes.voterDid);
  for (const row of counts) voteCounts.set(row.did, Number(row.c));

  const reports: SeniorityReport[] = [];
  for (const did of activeDids) {
    const issued = firstIssued.get(did)!;
    const tenureDays = Math.floor((now.getTime() - issued.getTime()) / DAY_MS);
    const votes = voteCounts.get(did) ?? 0;
    reports.push({
      did,
      tenureDays,
      votes,
      eligible: tenureDays >= policy.minDays && votes >= policy.minVotes,
      alreadySenior: await hasLabel(did, SENIOR_LIBRARIAN_LABEL, db),
    });
  }
  return reports;
}

export interface SeniorityRunSummary extends SeniorityPolicy {
  evaluated: number;
  issued: number;
  eligible: number;
  alreadySenior: number;
}

/** Issue `senior-librarian` to everyone who now qualifies. Idempotent. */
export async function issueSeniorLibrarianLabels(
  policy: SeniorityPolicy = seniorityPolicy(),
  now: Date = new Date(),
  db: DbExecutor = defaultDb,
): Promise<SeniorityRunSummary> {
  const reports = await evaluateSeniority(policy, now, db);
  let issued = 0;
  for (const report of reports) {
    if (!report.eligible || report.alreadySenior) continue;
    await grantLabel(report.did, SENIOR_LIBRARIAN_LABEL, db);
    issued++;
  }
  return {
    ...policy,
    evaluated: reports.length,
    eligible: reports.filter((r) => r.eligible).length,
    alreadySenior: reports.filter((r) => r.alreadySenior).length,
    issued,
  };
}
