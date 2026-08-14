import type { ActorIdentifier, Nsid } from '@atcute/lexicons/syntax';
import { Client, ok, simpleFetchHandler, type FetchHandler } from '@atcute/client';
import {
	ComAtprotoRepoApplyWrites,
	ComAtprotoRepoCreateRecord,
	ComAtprotoRepoDeleteRecord,
	ComAtprotoRepoGetRecord,
	ComAtprotoRepoListRecords,
	ComAtprotoRepoPutRecord,
	ComAtprotoRepoUploadBlob,
} from '@atcute/atproto';

export interface PdsClientOptions {
	/** base URL of the user's PDS, e.g. `https://pds.example.com`. */
	pdsUrl: string;
	/** bearer token used as `Authorization: Bearer <token>` on every request. */
	token: string;
	/** repo (handle or DID) the helpers act on; defaults to `did:example:alice`. */
	repo?: string;
}

export interface PdsRecordRef {
	uri: string;
	cid: string;
}

export interface PdsRecord {
	uri: string;
	cid: string;
	value: unknown;
}

export type PdsWrite =
	| { action: 'create'; collection: string; rkey?: string; value: unknown }
	| { action: 'update'; collection: string; rkey: string; value: unknown }
	| { action: 'delete'; collection: string; rkey: string };

export interface PdsUploadResult {
	blob: { $type: 'blob'; ref: { $link: string }; mimeType?: string; size?: number };
}

export interface PdsClient {
	getRecord(collection: string, rkey: string): Promise<PdsRecord>;
	listRecords(
		collection: string,
		opts?: { cursor?: string; limit?: number; reverse?: boolean },
	): Promise<ComAtprotoRepoListRecords.$output>;
	createRecord(collection: string, record: unknown, opts?: { rkey?: string }): Promise<PdsRecordRef>;
	putRecord(
		collection: string,
		rkey: string,
		record: unknown,
		opts?: { validate?: boolean; swapRecord?: string },
	): Promise<PdsRecordRef>;
	deleteRecord(collection: string, rkey: string, opts?: { swapRecord?: string }): Promise<void>;
	applyWrites(writes: Array<PdsWrite>): Promise<void>;
	uploadBlob(body: Uint8Array, contentType?: string): Promise<PdsUploadResult>;
}

const DEFAULT_REPO = 'did:example:alice';

/**
 * Build a typed XRPC client for a user's PDS.
 *
 * @atcute/client has no built-in session/credential support, so the bearer
 * token is injected by wrapping the `simpleFetchHandler` result: every request
 * passes through a handler that adds `Authorization: Bearer <token>` to the
 * outgoing headers before delegating to the plain fetch handler.
 */
export function createPdsClient(opts: PdsClientOptions): PdsClient {
	const repo = opts.repo ?? DEFAULT_REPO;

	const base = simpleFetchHandler({ service: opts.pdsUrl });
	const handler: FetchHandler = (pathname, init) => {
		const headers = new Headers(init.headers);
		if (!headers.has('authorization')) {
			headers.set('authorization', `Bearer ${opts.token}`);
		}
		return base(pathname, { ...init, headers });
	};
	const rpc = new Client({ handler });

	return {
		async getRecord(collection, rkey) {
			const data = await ok(
				rpc.call(ComAtprotoRepoGetRecord, {
					params: { repo: repo as ActorIdentifier, collection: collection as Nsid, rkey },
				}),
			);
			return data as PdsRecord;
		},

		async listRecords(collection, opts) {
			return ok(
				rpc.call(ComAtprotoRepoListRecords, {
					params: {
						repo: repo as ActorIdentifier,
						collection: collection as Nsid,
						cursor: opts?.cursor,
						limit: opts?.limit,
						reverse: opts?.reverse,
					},
				}),
			);
		},

		async createRecord(collection, record, opts) {
			return ok(
				rpc.call(ComAtprotoRepoCreateRecord, {
					input: {
						repo: repo as ActorIdentifier,
						collection: collection as Nsid,
						record: record as Record<string, unknown>,
						rkey: opts?.rkey,
					},
				}),
			);
		},

		async putRecord(collection, rkey, record, opts) {
			return ok(
				rpc.call(ComAtprotoRepoPutRecord, {
					input: {
						repo: repo as ActorIdentifier,
						collection: collection as Nsid,
						rkey,
						record: record as Record<string, unknown>,
						validate: opts?.validate,
						swapRecord: opts?.swapRecord,
					},
				}),
			);
		},

		async deleteRecord(collection, rkey, opts) {
			await ok(
				rpc.call(ComAtprotoRepoDeleteRecord, {
					input: {
						repo: repo as ActorIdentifier,
						collection: collection as Nsid,
						rkey,
						swapRecord: opts?.swapRecord,
					},
				}),
			);
		},

		async applyWrites(writes) {
			await ok(
				rpc.call(ComAtprotoRepoApplyWrites, { input: { repo: repo as ActorIdentifier, writes: toLexiconWrites(writes) } }),
			);
		},

		async uploadBlob(body, contentType) {
			return ok(
				rpc.call(ComAtprotoRepoUploadBlob, {
					input: body,
					headers: contentType ? { 'content-type': contentType } : undefined,
				}),
			);
		},
	};
}

type ApplyLexiconWrite =
	| { $type: 'com.atproto.repo.applyWrites#create'; collection: Nsid; rkey?: string; value: Record<string, unknown> }
	| { $type: 'com.atproto.repo.applyWrites#update'; collection: Nsid; rkey: string; value: Record<string, unknown> }
	| { $type: 'com.atproto.repo.applyWrites#delete'; collection: Nsid; rkey: string };

function toLexiconWrites(writes: Array<PdsWrite>): ApplyLexiconWrite[] {
	return writes.map((write) => {
		switch (write.action) {
			case 'create':
				return {
					$type: 'com.atproto.repo.applyWrites#create',
					collection: write.collection as Nsid,
					...(write.rkey !== undefined ? { rkey: write.rkey } : {}),
					value: write.value as Record<string, unknown>,
				};
			case 'update':
				return {
					$type: 'com.atproto.repo.applyWrites#update',
					collection: write.collection as Nsid,
					rkey: write.rkey,
					value: write.value as Record<string, unknown>,
				};
			case 'delete':
				return {
					$type: 'com.atproto.repo.applyWrites#delete',
					collection: write.collection as Nsid,
					rkey: write.rkey,
				};
		}
	});
}
