#!/usr/bin/env tsx
//
// Issue `senior-librarian` to librarians who have been contributing long enough.
//
// Idempotent — accounts already holding the label are skipped, so this is safe to
// schedule daily:
//
//   pnpm --filter bibliograph-service labels:seniority
//
// Thresholds: SENIOR_LIBRARIAN_MIN_DAYS (default 365),
//             SENIOR_LIBRARIAN_MIN_VOTES (default 10).
//
// Pass --dry-run to print the evaluation without writing labels.

import { createLogger } from '../src/lib/server/logger';
import {
  evaluateSeniority,
  issueSeniorLibrarianLabels,
  seniorityPolicy,
} from '../src/lib/server/labeler/seniority';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }
  if (!process.env.ATP_LABEL_SIGNING_KEY) {
    console.error('ATP_LABEL_SIGNING_KEY is required to sign labels');
    process.exit(2);
  }

  const dryRun = process.argv.includes('--dry-run');
  const log = createLogger('worker');
  const policy = seniorityPolicy();

  if (dryRun) {
    const reports = await evaluateSeniority(policy);
    console.log(JSON.stringify({ stage: 'seniority:dry-run', policy, reports }, null, 2));
    return;
  }

  const summary = await issueSeniorLibrarianLabels(policy);
  log.info({ stage: 'seniority', ...summary }, 'senior librarian labels issued');
  // Machine-readable single line, matching the backfill scripts.
  console.log(JSON.stringify({ stage: 'seniority:summary', ...summary }));
}

main()
  .then(() => {
    setImmediate(() => process.exit(0));
  })
  .catch((err) => {
    console.error('seniority run crashed:', err);
    process.exit(2);
  });
