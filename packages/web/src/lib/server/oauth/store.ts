import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { env } from '$env/dynamic/private';
import type { DpopPrivateJwk } from './dpop';

/**
 * Server-side session store: a single JSON file, read once and rewritten
 * atomically on every change.
 *
 * The browser never holds a secret. `.data/sessions.json` keeps the DPoP
 * private key, the access token, and the refresh token; the cookie carries an
 * opaque random id only. It lives on disk rather than in memory because the
 * dev server reloads modules (and the process restarts) far more often than a
 * login expires, and re-authorising on every restart makes the flow unusable.
 *
 * The file is a deliberate dev-scale choice: one node, one writer, no
 * transactions. A multi-node deployment must swap `StoredSession` for a table
 * (or Redis) — the exported API is the seam, nothing else reads the file.
 *
 * `WEB_DATA_DIR` overrides the directory; the default is resolved against the
 * server's working directory (`packages/web` under `pnpm --filter web dev`).
 */
const DATA_DIR = env.WEB_DATA_DIR ?? '.data';
const DATA_FILE = join(DATA_DIR, 'sessions.json');

/** How long a started-but-unfinished login may take to come back. */
const PENDING_TTL_MS = 10 * 60 * 1000;
/** How long a signed-in browser stays signed in without re-authorising. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface StoredSession {
  id: string;
  did: string;
  handle: string | undefined;
  /** The token the edge presents as `Authorization: DPoP`; also the `ath` input. */
  accessToken: string;
  refreshToken: string | undefined;
  expiresAt: string | undefined;
  scopes: string;
  /** Shared with HappyView: the same key signs proofs for both. */
  dpopKey: DpopPrivateJwk;
  provisionId: string;
  issuer: string;
  pdsUrl: string;
  /** Last `DPoP-Nonce` HappyView issued for this key, if it issues them. */
  nonce?: string;
  createdAt: string;
}

/** A login between `/login` and `/oauth/callback`. */
export interface PendingLogin {
  state: string;
  verifier: string;
  provisionId: string;
  dpopKey: DpopPrivateJwk;
  issuer: string;
  /** Last `DPoP-Nonce` the authorization server issued during this login. */
  nonce?: string;
  /** Exactly the `redirect_uri` sent to PAR; the token exchange must repeat it. */
  redirectUri: string;
  createdAt: string;
}

interface Data {
  sessions: Record<string, StoredSession>;
  pending: Record<string, PendingLogin>;
}

let cache: Data | undefined;

function load(): Data {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(readFileSync(DATA_FILE, 'utf8')) as Partial<Data>;
    cache = { sessions: parsed.sessions ?? {}, pending: parsed.pending ?? {} };
  } catch {
    cache = { sessions: {}, pending: {} };
  }
  return cache;
}

function persist(data: Data): void {
  mkdirSync(dirname(DATA_FILE), { recursive: true });
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, DATA_FILE);
}

function prune(data: Data): void {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [state, pending] of Object.entries(data.pending)) {
    if (Date.parse(pending.createdAt) < cutoff) delete data.pending[state];
  }
  const expiry = Date.now() - SESSION_TTL_MS;
  for (const [id, session] of Object.entries(data.sessions)) {
    if (Date.parse(session.createdAt) < expiry) delete data.sessions[id];
  }
}

export function createSession(
  session: Omit<StoredSession, 'id' | 'createdAt'>
): StoredSession {
  const data = load();
  prune(data);
  const stored: StoredSession = {
    ...session,
    id: randomBytes(32).toString('base64url'),
    createdAt: new Date().toISOString()
  };
  data.sessions[stored.id] = stored;
  persist(data);
  return stored;
}

export function getSession(id: string | undefined): StoredSession | undefined {
  if (!id) return undefined;
  const data = load();
  const session = data.sessions[id];
  if (!session) return undefined;
  if (Date.parse(session.createdAt) < Date.now() - SESSION_TTL_MS) {
    delete data.sessions[id];
    persist(data);
    return undefined;
  }
  return session;
}

export function deleteSession(id: string | undefined): StoredSession | undefined {
  if (!id) return undefined;
  const data = load();
  const session = data.sessions[id];
  if (!session) return undefined;
  delete data.sessions[id];
  persist(data);
  return session;
}

export function savePending(pending: PendingLogin): void {
  const data = load();
  prune(data);
  data.pending[pending.state] = pending;
  persist(data);
}

/** Read and forget a pending login: a `state` value is single-use. */
export function takePending(state: string | null | undefined): PendingLogin | undefined {
  if (!state) return undefined;
  const data = load();
  const pending = data.pending[state];
  if (!pending) return undefined;
  delete data.pending[state];
  persist(data);
  if (Date.parse(pending.createdAt) < Date.now() - PENDING_TTL_MS) return undefined;
  return pending;
}

/**
 * Record the latest `DPoP-Nonce` HappyView issued to a session.
 *
 * Not a secret, and not load-bearing: the next request that needs it also
 * retries on `use_dpop_nonce`. Storing it only saves that extra round trip
 * after a restart.
 */
export function updateSessionNonce(id: string, nonce: string): void {
  const data = load();
  const session = data.sessions[id];
  if (!session || session.nonce === nonce) return;
  session.nonce = nonce;
  persist(data);
}
