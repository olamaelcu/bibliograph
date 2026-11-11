import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

// Bounded pool: production Postgres caps `max_connections` at 50 and the
// worker, enqueue utils and the tap consumer share the budget. An unbounded
// default (10) let one process take slots another needed and every request
// that could not get a connection answered 500 with SQLSTATE 53300.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? 5),
});
// A pg Pool emits 'error' for a client that dies while idle (server restart,
// network reset). Node treats an unhandled 'error' event as fatal, so one
// dropped connection would take the whole process down.
pool.on('error', (err) => {
  console.error('[db] idle client error', err);
});
export const db = drizzle(pool, { schema });
