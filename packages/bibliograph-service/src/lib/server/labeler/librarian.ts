// Librarian access: applications, review, and label issuance.
//
// Signing in does not grant the `librarian` label. An account requests access,
// an admin reviews the queue, and approval emits a real ATProto label into this
// labeler's stream. The label is the single source of truth for the gate — the
// application row only records how it got there.

import { asc, eq } from 'drizzle-orm';
import { db as defaultDb } from '../db/index';
import { librarianApplications } from '../db/schema';
import type { LibrarianApplicationRow } from '../db/schema';
import type { DbExecutor } from '../stats';
import { clearLabel, grantLabel, hasLabel, isLibrarian } from './labels';
import { ADMINISTRATOR_LABEL, LIBRARIAN_LABEL } from './vocabulary';

/**
 * Bootstrap allowlist for the admin queue.
 *
 * The durable source of truth is the `administrator` label; this env list exists
 * so a fresh deployment can grant the first one (and so a lost label cannot lock
 * every human out). Once an account holds the label it stays an admin even after
 * it is removed from this list.
 */
export function adminDids(raw: string | undefined = process.env.ADMIN_DIDS): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((did) => did.trim())
      .filter(Boolean),
  );
}

export function isBootstrapAdmin(did: string | null | undefined, raw?: string): boolean {
  if (!did) return false;
  return adminDids(raw).has(did);
}

/**
 * Administrators are accounts holding the `administrator` label, plus the
 * bootstrap allowlist. Label-first, because the label is the same mechanism the
 * rest of the catalog gates on.
 */
export async function isAdministrator(
  did: string | null | undefined,
  db: DbExecutor = defaultDb,
): Promise<boolean> {
  if (!did) return false;
  if (isBootstrapAdmin(did)) return true;
  return hasLabel(did, ADMINISTRATOR_LABEL, db);
}

export type ApplicationStatus = LibrarianApplicationRow['status'];

export async function applicationFor(
  did: string,
  db: DbExecutor = defaultDb,
): Promise<LibrarianApplicationRow | null> {
  const [row] = await db
    .select()
    .from(librarianApplications)
    .where(eq(librarianApplications.did, did));
  return row ?? null;
}

/**
 * Record an access request. Idempotent: a second click refreshes the note but
 * never resets a decision an admin already made.
 */
export async function requestLibrarianAccess(
  did: string,
  handle: string | null,
  note: string | null,
  db: DbExecutor = defaultDb,
): Promise<LibrarianApplicationRow> {
  if (!(await isLibrarian(did, db))) {
    throw new Error('Only accounts holding the librarian label can request access (403).');
  }
  const existing = await applicationFor(did, db);
  if (existing && (existing.status === 'approved' || existing.status === 'revoked')) {
    return existing;
  }

  const [row] = await db
    .insert(librarianApplications)
    .values({ did, handle, note, status: 'pending', requestedAt: new Date() })
    .onConflictDoUpdate({
      target: librarianApplications.did,
      set: { handle, note, status: 'pending', requestedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error('librarian application upsert returned no row');
  return row;
}

export async function listApplications(
  status: ApplicationStatus | 'all' = 'pending',
  db: DbExecutor = defaultDb,
): Promise<LibrarianApplicationRow[]> {
  const query = db.select().from(librarianApplications);
  const rows =
    status === 'all'
      ? await query.orderBy(asc(librarianApplications.requestedAt))
      : await query.where(eq(librarianApplications.status, status)).orderBy(asc(librarianApplications.requestedAt));
  return rows;
}

/**
 * Approve a request: emit the label, then record the decision. If signing fails
 * the application stays pending, so the queue never claims a label that was not
 * actually issued.
 */
export async function approveApplication(
  did: string,
  adminDid: string,
  db: DbExecutor = defaultDb,
): Promise<LibrarianApplicationRow> {
  const label = await grantLabel(did, LIBRARIAN_LABEL, db);
  const [row] = await db
    .update(librarianApplications)
    .set({ status: 'approved', decidedAt: new Date(), decidedBy: adminDid })
    .where(eq(librarianApplications.did, did))
    .returning();
  if (!row) {
    throw new Error(`approved ${did} (label seq ${label.seq}) but no application row exists`);
  }
  return row;
}

export async function rejectApplication(
  did: string,
  adminDid: string,
  db: DbExecutor = defaultDb,
): Promise<LibrarianApplicationRow> {
  const [row] = await db
    .update(librarianApplications)
    .set({ status: 'rejected', decidedAt: new Date(), decidedBy: adminDid })
    .where(eq(librarianApplications.did, did))
    .returning();
  if (!row) throw new Error(`no application to reject for ${did}`);
  return row;
}

/** Retract the label (spec: negation) and mark the application revoked. */
export async function revokeLibrarian(
  did: string,
  adminDid: string,
  db: DbExecutor = defaultDb,
): Promise<LibrarianApplicationRow> {
  await clearLabel(did, LIBRARIAN_LABEL, db);
  const [row] = await db
    .update(librarianApplications)
    .set({ status: 'revoked', decidedAt: new Date(), decidedBy: adminDid })
    .where(eq(librarianApplications.did, did))
    .returning();
  if (!row) throw new Error(`revoked ${did} but no application row exists`);
  return row;
}
