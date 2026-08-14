import { Hono, type Context } from 'hono';
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { cidForRecord } from '../pds/cid.js';
import type { PdsClientOptions } from '../pds/client.js';

export interface FakePdsRecord {
	value: unknown;
	cid: string;
}

export interface FakePdsRequest {
	method: string;
	pathname: string;
	headers: Record<string, string>;
}

export interface FakePds {
	/** Hono app implementing the `com.atproto.repo.*` procedures. */
	app: Hono;
	/**
	 * Client options for the fake PDS. `pdsUrl` is a placeholder — combine
	 * `serveFakePds(...).baseUrl` with `token` when constructing a client.
	 */
	client: PdsClientOptions;
	/** Records keyed by `${collection}/${rkey}`. */
	records: Map<string, FakePdsRecord>;
	/** Every request the fake has received (used to assert on headers). */
	requests: FakePdsRequest[];
}

export interface FakePdsOptions {
	/** repo DID used in record URIs; defaults to `did:example:alice`. */
	repo?: string;
}

const DEFAULT_REPO = 'did:example:alice';
const DEFAULT_TOKEN = 'fake-pds-token';
/** Deterministic, schema-valid DASL CIDv1 echoed back by `uploadBlob`. */
const FIXED_BLOB_CID = 'bafyreiadsbmmn4waznesyuz3bjgrj33xzqhxrk6mz3ksq7meugrachh3qe';

let tidCounter = 0;

/** Generate a TID-like, time-ordered, unique record key. */
function generateTid(): string {
	tidCounter += 1;
	const stamp = new Date().getTime().toString(36);
	return (stamp + tidCounter.toString(36)).slice(-13).padStart(13, '0');
}

/**
 * Create an in-memory fake PDS backed by a Hono app. Implements the subset of
 * `com.atproto.repo.*` XRPC methods the outbound client calls, following
 * atproto HTTP conventions (queries over GET, procedures over POST).
 */
export function createFakePds(opts: FakePdsOptions = {}): FakePds {
	const repo = opts.repo ?? DEFAULT_REPO;
	const records: Map<string, FakePdsRecord> = new Map();
	const requests: FakePdsRequest[] = [];
	const app = new Hono();

	const key = (collection: string, rkey: string) => `${collection}/${rkey}`;
	const uri = (collection: string, rkey: string) => `at://${repo}/${collection}/${rkey}`;

	const record = (c: Context) => {
		requests.push({
			method: c.req.method,
			pathname: new URL(c.req.url, 'http://fake-pds').pathname,
			headers: Object.fromEntries(c.req.raw.headers.entries()),
		});
	};

	app.get('/xrpc/com.atproto.repo.getRecord', async (c) => {
		record(c);
		const collection = c.req.query('collection');
		const rkey = c.req.query('rkey');
		if (!collection || !rkey) {
			return c.json({ error: 'InvalidRequest', message: 'collection and rkey are required' }, 400);
		}
		const rec = records.get(key(collection, rkey));
		if (!rec) {
			return c.json({ error: 'RecordNotFound', message: `record not found: ${uri(collection, rkey)}` }, 400);
		}
		return c.json({ uri: uri(collection, rkey), cid: rec.cid, value: rec.value });
	});

	app.get('/xrpc/com.atproto.repo.listRecords', async (c) => {
		record(c);
		const collection = c.req.query('collection');
		if (!collection) {
			return c.json({ error: 'InvalidRequest', message: 'collection is required' }, 400);
		}
		const limit = Math.min(100, Math.max(1, Number.parseInt(c.req.query('limit') ?? '50', 10) || 50));
		const reverse = c.req.query('reverse') === 'true';
		const cursor = c.req.query('cursor');

		const prefix = collection + '/';
		let rkeys = [...records.keys()]
			.filter((k) => k.startsWith(prefix))
			.map((k) => k.slice(prefix.length))
			.sort();
		if (reverse) rkeys = rkeys.reverse();
		if (cursor) {
			const idx = rkeys.indexOf(cursor);
			rkeys = idx === -1 ? [] : rkeys.slice(idx + 1);
		}

		const page = rkeys.slice(0, limit);
		const out = page.map((rkey) => {
			const rec = records.get(prefix + rkey)!;
			return { uri: uri(collection, rkey), cid: rec.cid, value: rec.value };
		});
		const hasMore = rkeys.length > limit;
		return c.json({ records: out, ...(hasMore ? { cursor: page[page.length - 1] } : {}) });
	});

	app.post('/xrpc/com.atproto.repo.putRecord', async (c) => {
		record(c);
		const body = (await c.req.json()) as { collection?: string; rkey?: string; record?: unknown };
		const { collection, rkey } = body;
		if (!collection || !rkey) {
			return c.json({ error: 'InvalidRequest', message: 'collection and rkey are required' }, 400);
		}
		const cid = await cidForRecord(body.record);
		records.set(key(collection, rkey), { value: body.record, cid });
		return c.json({ uri: uri(collection, rkey), cid });
	});

	app.post('/xrpc/com.atproto.repo.createRecord', async (c) => {
		record(c);
		const body = (await c.req.json()) as { collection?: string; rkey?: string; record?: unknown };
		const collection = body.collection;
		if (!collection) {
			return c.json({ error: 'InvalidRequest', message: 'collection is required' }, 400);
		}
		const rkey = body.rkey ?? generateTid();
		const k = key(collection, rkey);
		if (records.has(k)) {
			return c.json({ error: 'InvalidRecord', message: `record already exists: ${uri(collection, rkey)}` }, 409);
		}
		const cid = await cidForRecord(body.record);
		records.set(k, { value: body.record, cid });
		return c.json({ uri: uri(collection, rkey), cid });
	});

	app.post('/xrpc/com.atproto.repo.deleteRecord', async (c) => {
		record(c);
		const body = (await c.req.json()) as { collection?: string; rkey?: string };
		const { collection, rkey } = body;
		if (!collection || !rkey) {
			return c.json({ error: 'InvalidRequest', message: 'collection and rkey are required' }, 400);
		}
		const k = key(collection, rkey);
		if (!records.has(k)) {
			return c.json({ error: 'RecordNotFound', message: `record not found: ${uri(collection, rkey)}` }, 400);
		}
		records.delete(k);
		return c.json({});
	});

	app.post('/xrpc/com.atproto.repo.applyWrites', async (c) => {
		record(c);
		const body = (await c.req.json()) as {
			writes?: Array<{ $type?: string; collection?: string; rkey?: string; value?: unknown }>;
		};
		for (const write of body.writes ?? []) {
			const collection = write.collection;
			if (!collection) continue;
			switch (write.$type) {
				case 'com.atproto.repo.applyWrites#create': {
					const rkey = write.rkey ?? generateTid();
					const cid = await cidForRecord(write.value);
					records.set(key(collection, rkey), { value: write.value, cid });
					break;
				}
				case 'com.atproto.repo.applyWrites#update': {
					if (!write.rkey) break;
					const cid = await cidForRecord(write.value);
					records.set(key(collection, write.rkey), { value: write.value, cid });
					break;
				}
				case 'com.atproto.repo.applyWrites#delete': {
					if (!write.rkey) break;
					records.delete(key(collection, write.rkey));
					break;
				}
			}
		}
		return c.json({});
	});

	app.post('/xrpc/com.atproto.repo.uploadBlob', async (c) => {
		record(c);
		const body = await c.req.arrayBuffer();
		const mimeType = c.req.header('content-type') ?? 'application/octet-stream';
		return c.json({
			blob: { $type: 'blob', ref: { $link: FIXED_BLOB_CID }, mimeType, size: body.byteLength },
		});
	});

	return {
		app,
		client: { pdsUrl: '', token: DEFAULT_TOKEN },
		records,
		requests,
	};
}

/**
 * Start the fake PDS on an ephemeral port and return a real HTTP base URL.
 * Point `createPdsClient` at it with the fake's `token`.
 */
export async function serveFakePds(
	fake: FakePds,
): Promise<{ baseUrl: string; close(): void }> {
	const server = serve({ fetch: fake.app.fetch, port: 0 }) as Server;
	await new Promise<void>((resolve) => server.once('listening', resolve));
	const addr = server.address();
	const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		close: () => server.close(),
	};
}
