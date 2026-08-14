import type { Hono } from 'hono';
import type { Context } from 'hono';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { and, eq } from 'drizzle-orm';
import { books, catalogBlobs, contributors } from '../db/schema.js';

export function registerBlobProxy(
	app: Hono,
	db: BetterSQLite3Database,
	store: { get: (key: string) => Promise<Uint8Array> },
) {
	app.get('/catalog-blobs/*', async (c: Context) => {
		const key = c.req.path.replace(/^\/catalog-blobs\//, '');
		const row = db.select().from(catalogBlobs).where(eq(catalogBlobs.objectKey, key)).get();
		if (!row) return c.json({ error: 'NotFound' }, 404);

		// Release gate: entity must be released.
		const entityTable = row.entityType === 'book' ? books : contributors;
		const entity = db
			.select()
			.from(entityTable)
			.where(
				and(
					eq(entityTable.pk as never, row.entityPk as never),
					eq(entityTable.releaseStatus as never, 'released' as never),
				),
			)
			.get();
		if (!entity) return c.json({ error: 'NotFound' }, 404);

		try {
			const bytes = await store.get(key);
			return c.body(Buffer.from(bytes), 200, {
				'content-type': row.mimeType ?? 'application/octet-stream',
				'cache-control': 'public, max-age=31536000, immutable',
			});
		} catch {
			return c.json({ error: 'NotFound' }, 404);
		}
	});
}
