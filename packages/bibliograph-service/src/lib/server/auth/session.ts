// Browser session for Bibliograph's storefront.
//
// The cookie holds an opaque random id, never a DID: the session row is what maps
// a browser to an ATProto identity, so a tampered cookie cannot claim someone
// else's OAuth session (which lives server-side keyed by DID).

import { randomBytes } from 'node:crypto';
import { and, eq, gt, lt } from 'drizzle-orm';
import type { Cookies } from '@sveltejs/kit';
import { db as defaultDb } from '$lib/server/db';
import { webSessions } from '$lib/server/db/schema';
import type { DbExecutor } from '$lib/server/stats';

export const SESSION_COOKIE = 'bib_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface Viewer {
  did: string;
  handle: string | null;
}

export async function createWebSession(
  did: string,
  handle: string | null,
  db: DbExecutor = defaultDb,
): Promise<{ id: string; expiresAt: Date }> {
  const id = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(webSessions).values({ id, did, handle, expiresAt });
  await db.delete(webSessions).where(lt(webSessions.expiresAt, new Date()));
  return { id, expiresAt };
}

export async function readWebSession(
  id: string | undefined,
  db: DbExecutor = defaultDb,
): Promise<Viewer | null> {
  if (!id) return null;
  const [row] = await db
    .select({ did: webSessions.did, handle: webSessions.handle })
    .from(webSessions)
    .where(and(eq(webSessions.id, id), gt(webSessions.expiresAt, new Date())));
  return row ?? null;
}

export async function destroyWebSession(sessionId: string, db: DbExecutor = defaultDb): Promise<void> {
  await db.delete(webSessions).where(eq(webSessions.id, sessionId));
}

export function setSessionCookie(cookies: Cookies, id: string, expiresAt: Date, secure: boolean): void {
  cookies.set(SESSION_COOKIE, id, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    expires: expiresAt,
  });
}

export function clearSessionCookie(cookies: Cookies): void {
  cookies.delete(SESSION_COOKIE, { path: '/' });
}
