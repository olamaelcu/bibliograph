#!/usr/bin/env tsx
// A minimal PLC directory for local development and E2E runs.
//
// It implements the two reads identity resolution needs and the write a PDS
// performs when it creates an account, but it does not validate PLC operations
// or signatures: it is a disposable registry, not a PLC. Point PDS_DID_PLC_URL
// (or PDS_PLC_URL) at it and PLC_DIRECTORY_URL at the same origin for the app.
//
//   PORT=2582 MOCK_PLC_STORE=./data/mock-plc.json pnpm mock-plc
//
// Routes:
//   GET  /_health           readiness
//   GET  /:did              the DID document
//   POST /:did              accept a PLC operation (create/update) from a PDS
//   POST /admin/dids        seed a document by hand: {did, pds?, handle?, doc?}
//   DELETE /admin/dids/:did forget one (test reset)

import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';

interface StoredDoc {
	'@context'?: string[];
	id?: string;
	alsoKnownAs?: string[];
	verificationMethod?: Array<Record<string, unknown>>;
	service?: Array<Record<string, unknown>>;
}

const PORT = Number(process.env.PORT ?? 2582);
const HOST = process.env.HOST ?? '127.0.0.1';
const STORE = process.env.MOCK_PLC_STORE;
const docs = new Map<string, StoredDoc>();

function load(): void {
	if (!STORE) return;
	try {
		const parsed: unknown = JSON.parse(readFileSync(STORE, 'utf8'));
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
		for (const [did, doc] of Object.entries(parsed as Record<string, StoredDoc>)) docs.set(did, doc);
	} catch {
		// A missing or unreadable store is an empty registry.
	}
}

function save(): void {
	if (!STORE) return;
	const object: Record<string, StoredDoc> = {};
	for (const [did, doc] of docs) object[did] = doc;
	writeFileSync(STORE, JSON.stringify(object, null, 2));
}

function documentFor(did: string, input: Record<string, unknown>): StoredDoc {
	if (typeof input.id === 'string' && input.id === did) return input as StoredDoc;

	const op =
		input.operation && typeof input.operation === 'object'
			? (input.operation as Record<string, unknown>)
			: input;
	const alsoKnownAs = Array.isArray(op.alsoKnownAs) ? (op.alsoKnownAs as string[]) : [];
	const verificationMethods =
		op.verificationMethods && typeof op.verificationMethods === 'object'
			? (op.verificationMethods as Record<string, string>)
			: {};
	const services =
		op.services && typeof op.services === 'object'
			? (op.services as Record<string, { type?: string; endpoint?: string }>)
			: {};

	return {
		'@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
		id: did,
		alsoKnownAs,
		verificationMethod: Object.entries(verificationMethods).map(([id, key]) => ({
			id,
			type: 'Multikey',
			controller: did,
			publicKeyMultibase: key,
		})),
		service: Object.entries(services).map(([id, service]) => ({
			id,
			type: service.type ?? 'AtprotoPersonalDataServer',
			serviceEndpoint: service.endpoint,
		})),
	};
}

function seededDocument(did: string, body: Record<string, unknown>): StoredDoc {
	const handle = typeof body.handle === 'string' ? body.handle : `${did.replace(/[^a-z0-9]/gi, '')}.test`;
	const pds = typeof body.pds === 'string' ? body.pds : 'http://127.0.0.1:2583';
	return {
		'@context': ['https://www.w3.org/ns/did/v1'],
		id: did,
		alsoKnownAs: [`at://${handle}`],
		service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: pds }],
	};
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { 'content-type': 'application/json' });
	res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
	let raw = '';
	for await (const chunk of req) raw += chunk;
	if (!raw) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

	if (url.pathname === '/_health' || url.pathname === '/health') {
		json(res, 200, { ok: true, dids: docs.size });
		return;
	}

	if (req.method === 'POST' && url.pathname === '/admin/dids') {
		const body = await readBody(req);
		const did = typeof body.did === 'string' ? body.did : undefined;
		if (!did?.startsWith('did:plc:')) {
			json(res, 400, { error: 'InvalidRequest', message: 'did:plc:... is required' });
			return;
		}
		const doc =
			body.doc && typeof body.doc === 'object'
				? (body.doc as StoredDoc)
				: seededDocument(did, body);
		doc.id = did;
		docs.set(did, doc);
		save();
		json(res, 200, doc);
		return;
	}

	if (req.method === 'DELETE' && url.pathname.startsWith('/admin/dids/')) {
		const did = decodeURIComponent(url.pathname.slice('/admin/dids/'.length));
		docs.delete(did);
		save();
		json(res, 200, { ok: true });
		return;
	}

	const did = decodeURIComponent(url.pathname.slice(1));
	if (!did.startsWith('did:plc:')) {
		json(res, 404, { error: 'NotFound', message: 'Not a PLC DID' });
		return;
	}

	if (req.method === 'GET') {
		const doc = docs.get(did);
		if (!doc) {
			json(res, 404, { error: 'NotFound', message: `No document for ${did}` });
			return;
		}
		json(res, 200, doc);
		return;
	}

	if (req.method === 'POST') {
		const body = await readBody(req);
		const doc = documentFor(did, body);
		docs.set(did, doc);
		save();
		json(res, 200, doc);
		return;
	}

	json(res, 405, { error: 'MethodNotAllowed' });
});

load();
server.listen(PORT, HOST, () => {
	console.log(`[mock-plc] listening on http://${HOST}:${PORT} (${docs.size} DIDs loaded)`);
});
