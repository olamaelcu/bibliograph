import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '../db/schema.js';
import { jetstreamCursor, userRecords } from '../db/schema.js';
import { COLLECTION } from '../xrpc/views.js';
import { logger } from '../logger.js';

/**
 * Live-only Jetstream consumer: subscribes to the four biblio collections on
 * the Bluesky-hosted firehose and upserts/deletes into `user_records`, the
 * local index that phase-B user-content reads serve from. No historical
 * backfill — the cursor only ever resumes from the last event this process
 * itself observed.
 */

type Db = NodePgDatabase<typeof schema>;

const CURSOR_NAME = 'default';
const WANTED_COLLECTIONS = [COLLECTION.review, COLLECTION.shelf, COLLECTION.bookShelf, COLLECTION.actor] as const;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

interface JetstreamCommit {
	rev: string;
	operation: 'create' | 'update' | 'delete';
	collection: string;
	rkey: string;
	cid?: string;
	record?: unknown;
}

export interface JetstreamEvent {
	did: string;
	time_us: number;
	kind: string;
	commit?: JetstreamCommit;
}

export async function loadCursor(db: Db): Promise<number | undefined> {
	const row = (await db.select().from(jetstreamCursor).where(eq(jetstreamCursor.name, CURSOR_NAME)))[0];
	return row?.cursor ?? undefined;
}

async function saveCursor(db: Db, cursor: number): Promise<void> {
	const updatedAt = Math.floor(Date.now() / 1000);
	await db
		.insert(jetstreamCursor)
		.values({ name: CURSOR_NAME, cursor, updatedAt })
		.onConflictDoUpdate({ target: jetstreamCursor.name, set: { cursor, updatedAt } });
}

/** Apply one Jetstream event to the local index. Exported for direct unit testing. */
export async function applyJetstreamEvent(db: Db, event: JetstreamEvent): Promise<void> {
	const { commit } = event;
	if (commit && (WANTED_COLLECTIONS as readonly string[]).includes(commit.collection)) {
		if (commit.operation === 'delete') {
			await db
				.delete(userRecords)
				.where(
					and(
						eq(userRecords.did, event.did),
						eq(userRecords.collection, commit.collection),
						eq(userRecords.rkey, commit.rkey),
					),
				);
		} else if (commit.cid && commit.record !== undefined) {
			const indexedAt = Math.floor(Date.now() / 1000);
			await db
				.insert(userRecords)
				.values({
					did: event.did,
					collection: commit.collection,
					rkey: commit.rkey,
					cid: commit.cid,
					record: commit.record,
					indexedAt,
				})
				.onConflictDoUpdate({
					target: [userRecords.did, userRecords.collection, userRecords.rkey],
					set: { cid: commit.cid, record: commit.record, indexedAt },
				});
		}
	}
	await saveCursor(db, event.time_us);
}

function buildSubscribeUrl(host: string, cursor: number | undefined): string {
	const params = new URLSearchParams();
	for (const collection of WANTED_COLLECTIONS) params.append('wantedCollections', collection);
	if (cursor != null) params.set('cursor', String(cursor));
	return `wss://${host}/subscribe?${params.toString()}`;
}

export interface JetstreamIngestOpts {
	/** Jetstream host; defaults to `JETSTREAM_HOST` env or the US-East public instance. */
	host?: string;
	/** Override the WebSocket constructor — used by tests. */
	createSocket?: (url: string) => WebSocket;
}

export interface JetstreamIngestor {
	start(): void;
	stop(): void;
}

export function createJetstreamIngestor(db: Db, opts: JetstreamIngestOpts = {}): JetstreamIngestor {
	const host = opts.host ?? process.env.JETSTREAM_HOST ?? 'jetstream.us-east.bsky.network';
	const createSocket = opts.createSocket ?? ((url: string) => new WebSocket(url));

	let socket: WebSocket | undefined;
	let stopped = true;
	let backoffMs = MIN_BACKOFF_MS;
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

	async function connect(): Promise<void> {
		if (stopped) return;
		const cursor = await loadCursor(db);
		const url = buildSubscribeUrl(host, cursor);
		logger.info({ url }, 'jetstream: connecting');

		const ws = createSocket(url);
		socket = ws;

		ws.addEventListener('open', () => {
			backoffMs = MIN_BACKOFF_MS;
			logger.info('jetstream: connected');
		});

		ws.addEventListener('message', (ev) => {
			let event: JetstreamEvent;
			try {
				event = JSON.parse(String(ev.data)) as JetstreamEvent;
			} catch (err) {
				logger.warn({ err }, 'jetstream: malformed event, skipping');
				return;
			}
			void applyJetstreamEvent(db, event).catch((err) => {
				logger.error({ err, event }, 'jetstream: failed to apply event');
			});
		});

		ws.addEventListener('close', (ev) => {
			socket = undefined;
			logger.warn({ code: ev.code, reason: ev.reason }, 'jetstream: connection closed');
			scheduleReconnect();
		});

		ws.addEventListener('error', (err) => {
			logger.warn({ err }, 'jetstream: socket error');
		});
	}

	function scheduleReconnect(): void {
		if (stopped) return;
		const delay = backoffMs;
		backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
		logger.info({ delayMs: delay }, 'jetstream: reconnecting');
		reconnectTimer = setTimeout(connect, delay);
	}

	return {
		start() {
			if (!stopped) return;
			stopped = false;
			backoffMs = MIN_BACKOFF_MS;
			void connect();
		},
		stop() {
			stopped = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			reconnectTimer = undefined;
			socket?.close();
			socket = undefined;
		},
	};
}
