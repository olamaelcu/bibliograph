/**
 * Postgres-backed stores for `@atproto/oauth-client-node`.
 *
 * The two interfaces are trivial (`get`/`set`/`del`), and the tables are what
 * make a librarian's sign-in survive a deploy: the DPoP key and token set live in
 * `librarian_sessions`, keyed by DID. Both tables are created by
 * `packages/worker/sql/0031-contributor-identity.sql`.
 *
 * Only the edge writes them, so the rows are not something an operator edits.
 */

import type { NodeSavedSession, NodeSavedSessionStore, NodeSavedState, NodeSavedStateStore } from '@atproto/oauth-client-node';
import type { EntityQueryable } from '../catalog/entities.ts';

export function librarianStateStore(pool: EntityQueryable): NodeSavedStateStore {
  return {
    async get(key: string): Promise<NodeSavedState | undefined> {
      const result = await pool.query(
        `SELECT value FROM librarian_oauth_state
          WHERE key = $1 AND (expires_at IS NULL OR expires_at > now())`,
        [key]
      );
      const stored = result.rows[0]?.value;
      if (typeof stored !== 'string') return undefined;
      return JSON.parse(stored) as NodeSavedState;
    },
    async set(key: string, value: NodeSavedState): Promise<void> {
      await pool.query(
        `INSERT INTO librarian_oauth_state (key, value, expires_at)
         VALUES ($1, $2, now() + interval '30 minutes')
         ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value,
                expires_at = EXCLUDED.expires_at`,
        [key, JSON.stringify(value)]
      );
    },
    async del(key: string): Promise<void> {
      await pool.query('DELETE FROM librarian_oauth_state WHERE key = $1', [key]);
    }
  };
}

export function librarianSessionStore(pool: EntityQueryable): NodeSavedSessionStore {
  return {
    async get(key: string): Promise<NodeSavedSession | undefined> {
      const result = await pool.query(
        'SELECT token_set FROM librarian_sessions WHERE did = $1',
        [key]
      );
      const stored = result.rows[0]?.token_set;
      if (stored === undefined || stored === null) return undefined;
      return (typeof stored === 'string' ? JSON.parse(stored) : stored) as NodeSavedSession;
    },
    async set(key: string, value: NodeSavedSession): Promise<void> {
      await pool.query(
        `INSERT INTO librarian_sessions (did, token_set, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (did) DO UPDATE
            SET token_set = EXCLUDED.token_set,
                updated_at = now()`,
        [key, JSON.stringify(value)]
      );
    },
    async del(key: string): Promise<void> {
      await pool.query('DELETE FROM librarian_sessions WHERE did = $1', [key]);
    }
  };
}
