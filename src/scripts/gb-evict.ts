#!/usr/bin/env tsx
import { db, closeDb } from '../db/connection.js';
import { pruneExpired } from '../google-books/cache.js';
import { logger } from '../logger.js';

async function main(): Promise<void> {
	const removed = await pruneExpired(db);
	logger.info({ removed }, 'gb_cache: pruned expired rows');
	await closeDb();
}

main().catch((err) => {
	logger.fatal({ err }, 'gb-evict failed');
	process.exit(1);
});
