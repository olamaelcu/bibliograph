import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../test-utils/db.js';
import { userRecords } from '../db/schema.js';
import { COLLECTION } from '../xrpc/views.js';
import { applyJetstreamEvent, createJetstreamIngestor, loadCursor, type JetstreamEvent } from './ingest.js';

function testDb(): ReturnType<typeof createTestDb>['db'] {
	return createTestDb().db;
}

const DID = 'did:web:alice.example.com';

function commitEvent(overrides: Partial<JetstreamEvent> & { commit?: Partial<NonNullable<JetstreamEvent['commit']>> } = {}): JetstreamEvent {
	return {
		did: DID,
		time_us: 1_000,
		kind: 'commit',
		...overrides,
		commit: overrides.commit && {
			rev: 'rev-1',
			operation: 'create',
			collection: COLLECTION.review,
			rkey: 'rev-1',
			cid: 'bafyreicid1',
			record: { $type: COLLECTION.review, status: 'read' },
			...overrides.commit,
		},
	} as JetstreamEvent;
}

describe('applyJetstreamEvent', () => {
	it('upserts a create commit into user_records', () => {
		const db = testDb();
		applyJetstreamEvent(db, commitEvent({ commit: {} }));
		const row = db.select().from(userRecords).get();
		expect(row?.did).toBe(DID);
		expect(row?.collection).toBe(COLLECTION.review);
		expect(row?.rkey).toBe('rev-1');
		expect(row?.cid).toBe('bafyreicid1');
		expect((row?.record as { status: string }).status).toBe('read');
	});

	it('overwrites the record on an update commit for the same identity', () => {
		const db = testDb();
		applyJetstreamEvent(db, commitEvent({ commit: {} }));
		applyJetstreamEvent(
			db,
			commitEvent({
				time_us: 2_000,
				commit: { operation: 'update', cid: 'bafyreicid2', record: { $type: COLLECTION.review, status: 'reading' } },
			}),
		);
		const rows = db.select().from(userRecords).all();
		expect(rows).toHaveLength(1);
		expect(rows[0].cid).toBe('bafyreicid2');
		expect((rows[0].record as { status: string }).status).toBe('reading');
	});

	it('removes the record on a delete commit', () => {
		const db = testDb();
		applyJetstreamEvent(db, commitEvent({ commit: {} }));
		applyJetstreamEvent(db, commitEvent({ time_us: 2_000, commit: { operation: 'delete' } }));
		expect(db.select().from(userRecords).all()).toHaveLength(0);
	});

	it('ignores commits for collections outside the wanted set, but still advances the cursor', () => {
		const db = testDb();
		applyJetstreamEvent(
			db,
			commitEvent({ time_us: 42, commit: { collection: 'net.olamaelcu.livtet.biblio.book', rkey: 'book-dune' } }),
		);
		expect(db.select().from(userRecords).all()).toHaveLength(0);
		expect(loadCursor(db)).toBe(42);
	});

	it('persists the cursor from every event, including non-commit kinds', () => {
		const db = testDb();
		expect(loadCursor(db)).toBeUndefined();
		applyJetstreamEvent(db, { did: DID, time_us: 100, kind: 'identity' });
		expect(loadCursor(db)).toBe(100);
		applyJetstreamEvent(db, { did: DID, time_us: 200, kind: 'identity' });
		expect(loadCursor(db)).toBe(200);
	});
});

class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	readonly url: string;
	readonly readyState = 1;
	closed = false;
	private listeners: Record<string, Array<(ev?: unknown) => void>> = {};

	constructor(url: string) {
		this.url = url;
		FakeWebSocket.instances.push(this);
	}

	addEventListener(type: string, listener: (ev?: unknown) => void): void {
		(this.listeners[type] ??= []).push(listener);
	}

	close(): void {
		this.closed = true;
	}

	emit(type: string, ev?: unknown): void {
		for (const listener of this.listeners[type] ?? []) listener(ev);
	}
}

function fakeSocketFactory(): (url: string) => WebSocket {
	return (url: string) => new FakeWebSocket(url) as unknown as WebSocket;
}

beforeEach(() => {
	FakeWebSocket.instances.length = 0;
});

describe('createJetstreamIngestor', () => {
	it('subscribes with the wanted collections and resumes from the persisted cursor', () => {
		const db = testDb();
		applyJetstreamEvent(db, { did: DID, time_us: 555, kind: 'identity' });

		const ingestor = createJetstreamIngestor(db, { host: 'jetstream.test', createSocket: fakeSocketFactory() });
		ingestor.start();

		expect(FakeWebSocket.instances).toHaveLength(1);
		const url = new URL(FakeWebSocket.instances[0].url.replace(/^wss:/, 'https:'));
		expect(url.host).toBe('jetstream.test');
		expect(url.pathname).toBe('/subscribe');
		expect(url.searchParams.getAll('wantedCollections')).toEqual([
			COLLECTION.review,
			COLLECTION.shelf,
			COLLECTION.bookShelf,
			COLLECTION.actor,
		]);
		expect(url.searchParams.get('cursor')).toBe('555');

		ingestor.stop();
	});

	it('applies incoming messages to the local index', () => {
		const db = testDb();
		const ingestor = createJetstreamIngestor(db, { createSocket: fakeSocketFactory() });
		ingestor.start();

		const ws = FakeWebSocket.instances[0];
		ws.emit('message', {
			data: JSON.stringify(
				commitEvent({
					time_us: 10,
					commit: { collection: COLLECTION.shelf, rkey: 'shelf-1', record: { $type: COLLECTION.shelf, name: 'Faves' } },
				}),
			),
		});

		const row = db.select().from(userRecords).get();
		expect(row?.rkey).toBe('shelf-1');
		expect((row?.record as { name: string }).name).toBe('Faves');

		ingestor.stop();
	});

	it('ignores a malformed message without crashing', () => {
		const db = testDb();
		const ingestor = createJetstreamIngestor(db, { createSocket: fakeSocketFactory() });
		ingestor.start();
		expect(() => FakeWebSocket.instances[0].emit('message', { data: 'not json' })).not.toThrow();
		ingestor.stop();
	});

	it('reconnects with backoff after the socket closes', () => {
		vi.useFakeTimers();
		try {
			const db = testDb();
			const ingestor = createJetstreamIngestor(db, { createSocket: fakeSocketFactory() });
			ingestor.start();
			expect(FakeWebSocket.instances).toHaveLength(1);

			FakeWebSocket.instances[0].emit('close', { code: 1006, reason: 'abnormal' });
			vi.advanceTimersByTime(1_000);
			expect(FakeWebSocket.instances).toHaveLength(2);

			ingestor.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it('stop() prevents further reconnects', () => {
		vi.useFakeTimers();
		try {
			const db = testDb();
			const ingestor = createJetstreamIngestor(db, { createSocket: fakeSocketFactory() });
			ingestor.start();
			ingestor.stop();

			FakeWebSocket.instances[0].emit('close', { code: 1000, reason: 'normal' });
			vi.advanceTimersByTime(60_000);
			expect(FakeWebSocket.instances).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
