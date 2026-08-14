#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db/connection.js';
import { logger } from '../logger.js';
import {
  dismissIssue, editField, listForReview, listWithIssues, openIssueCount,
  resolveIssue, setStatus, showRecord, stagedDependents,
} from './service.js';
import { reviewEntityTypes, type ReviewEntityType } from './views.js';
import { importIssues, type ReleaseStatus } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';

const USAGE = 'usage: tsx src/review/cli.ts list|show|edit|approve|reject|issue [args]';

function parseEntity(v: string): ReviewEntityType {
  if (!(reviewEntityTypes as string[]).includes(v)) {
    throw new Error(`unknown entity '${v}'; expected ${reviewEntityTypes.join('|')}`);
  }
  return v as ReviewEntityType;
}

function printTable(rows: Array<Record<string, unknown>>): void {
  const keys = Object.keys(rows[0] ?? {});
  console.log(keys.join('\t'));
  for (const r of rows) console.log(keys.map((k) => String(r[k] ?? '')).join('\t'));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  const [cmd, ...rest] = args;

  if (cmd === 'list') {
    const args = new Map<string, string>();
    for (const a of rest) {
      const [k, v] = a.split('=');
      args.set(k.replace(/^--/, ''), v);
    }
    const entity = parseEntity(args.get('entity') ?? 'book');
    const status = args.get('status');
    const issuesOnly = args.get('issues') === 'true';
    const rows = issuesOnly
      ? listWithIssues(db, entity)
      : listForReview(db, entity, status ? { status: status as ReleaseStatus } : {});
    printTable(rows as unknown as Array<Record<string, unknown>>);
  } else if (cmd === 'show') {
    const entity = parseEntity(rest[0]);
    const pk = rest[1];
    if (!pk) throw new Error('show requires <entity> <pk>');
    const row = showRecord(db, entity, pk);
    if (!row) throw new Error(`not found: ${entity} ${pk}`);
    console.log(JSON.stringify(row, null, 2));
  } else if (cmd === 'edit') {
    const entity = parseEntity(rest[0]);
    const pk = rest[1];
    const args = new Map<string, string>();
    for (const a of rest.slice(2)) {
      const [k, v] = a.replace(/^--/, '').split('=');
      args.set(k, v);
    }
    const field = args.get('field');
    const value = args.get('value');
    if (!field || value === undefined) throw new Error('edit requires --field=NAME --value=VALUE');
    const res = editField(db, entity, pk, field, value);
    logger.info({ entity, pk, ...res }, 'field edited');
  } else if (cmd === 'approve') {
    const entity = parseEntity(rest[0]);
    const pk = rest[1];
    const keepIssues = rest.includes('--keep-issues');
    const yes = rest.includes('--yes');

    const open = openIssueCount(db, entity, pk);
    if (open > 0 && !keepIssues) {
      throw new Error(`${entity} ${pk} has ${open} open issue(s); use --keep-issues to override`);
    }
    if (entity === 'book') {
      const deps = stagedDependents(db, pk);
      if (deps.length > 0 && !yes) {
        throw new Error(`staged dependents: ${deps.join(', ')}; use --yes to approve anyway`);
      }
    }
    setStatus(db, entity, pk, 'released');
    logger.info({ entity, pk }, 'released');
  } else if (cmd === 'reject') {
    const entity = parseEntity(rest[0]);
    const pk = rest[1];
    setStatus(db, entity, pk, 'rejected');
    logger.info({ entity, pk }, 'rejected');
  } else if (cmd === 'issue') {
    const sub = rest[0];
    const issuePk = Number(rest[1]);
    if (sub === 'resolve') {
      resolveIssue(db, issuePk);
      logger.info({ issuePk }, 'issue resolved');
    } else if (sub === 'dismiss') {
      dismissIssue(db, issuePk);
      logger.info({ issuePk }, 'issue dismissed');
    } else {
      const entity = parseEntity(rest[1]);
      const pk = rest[2];
      const rows = db
        .select()
        .from(importIssues)
        .where(
          and(
            eq(importIssues.entityType, entity),
            eq(importIssues.entityPk, pk),
            eq(importIssues.status, 'open'),
          ),
        )
        .all();
      printTable(rows as unknown as Array<Record<string, unknown>>);
    }
  } else {
    console.error(USAGE);
    process.exit(1);
  }
}

export { main };

// Only run the dispatcher when executed directly, so a smoke test can import the
// module without triggering a usage-exit.
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    logger.fatal({ err: (err as Error).message }, 'review command failed');
    process.exit(1);
  });
}
