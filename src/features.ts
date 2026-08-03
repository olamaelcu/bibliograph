import { eq } from 'drizzle-orm';
import { db, schema } from './db/connection.js';

export function isFeatureEnabled(name: string): boolean {
  const row = db.select().from(schema.features).where(eq(schema.features.name, name)).get();
  return row?.enabled === 1;
}
