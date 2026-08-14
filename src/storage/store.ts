import { Operator } from 'opendal';
import { createHash } from 'node:crypto';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { catalogBlobs } from '../db/schema.js';
import { logger } from '../logger.js';

export interface BlobStoreConfig {
	scheme?: 's3' | 'memory';
	bucket?: string;
	endpoint?: string;
	region?: string;
	accessKeyId?: string;
	secretAccessKey?: string;
	/** Served URL base for blob keys, e.g. https://cdn.example.com/ */
	publicBaseUrl?: string;
}

export function blobStoreConfigFromEnv(): BlobStoreConfig {
	return {
		scheme: (process.env.BLOB_STORE_SCHEME as 's3' | 'memory') ?? 's3',
		bucket: process.env.AWS_BUCKET,
		endpoint: process.env.AWS_S3_ENDPOINT,
		region: process.env.AWS_S3_REGION,
		accessKeyId: process.env.AWS_ACCESS_KEY_ID,
		secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
		publicBaseUrl: process.env.BLOB_PUBLIC_BASE_URL,
	};
}

export interface StoredBlob {
	pk: string;
	objectKey: string;
	cid: string;
	mimeType: string | null;
	size: number;
	url: string;
}

export class BlobStore {
	private op: Operator;

	constructor(
		private readonly db: BetterSQLite3Database,
		private readonly cfg: BlobStoreConfig,
	) {
		// The s3 operator throws ConfigInvalid at construction if the bucket is missing, so
		// a dev env without AWS_BUCKET (scheme defaults to 's3' in blobStoreConfigFromEnv)
		// would crash `new BlobStore(...)`. Fall back to the in-memory backend so local
		// development works out of the box; set AWS_BUCKET to opt into S3.
		const scheme = cfg.scheme ?? 's3';
		if (scheme === 's3' && !cfg.bucket) {
			logger.warn('BlobStore: s3 scheme selected but no bucket configured; falling back to memory. Set AWS_BUCKET to use S3.');
			this.op = new Operator('memory');
		} else if (scheme === 'memory') {
			this.op = new Operator('memory');
		} else {
			const s3Options: Record<string, string> = { root: '/' };
			if (cfg.bucket) s3Options.bucket = cfg.bucket;
			if (cfg.endpoint) s3Options.endpoint = cfg.endpoint;
			if (cfg.region) s3Options.region = cfg.region;
			if (cfg.accessKeyId) s3Options.access_key_id = cfg.accessKeyId;
			if (cfg.secretAccessKey) s3Options.secret_access_key = cfg.secretAccessKey;
			this.op = new Operator('s3', s3Options);
		}
	}

	/** Write bytes and upsert the catalog_blobs row. */
	async put(opts: {
		entityType: 'book' | 'contributor';
		entityPk: string;
		kind: 'cover' | 'portrait';
		bytes: Uint8Array;
		mimeType: string;
		source: string;
	}): Promise<StoredBlob> {
		const cid = createHash('sha256').update(opts.bytes).digest('hex');
		const pk = `${opts.entityType}:${opts.entityPk}:${opts.kind}`;
		const objectKey = `catalog/${opts.entityType}/${opts.entityPk}/${opts.kind}-${cid}`;

		await this.op.write(objectKey, Buffer.from(opts.bytes));

		const now = Math.floor(Date.now() / 1000);
		this.db
			.insert(catalogBlobs)
			.values({
				pk,
				entityType: opts.entityType,
				entityPk: opts.entityPk,
				kind: opts.kind,
				cid,
				mimeType: opts.mimeType,
				size: opts.bytes.byteLength,
				objectKey,
				source: opts.source,
				createdAt: now,
			})
			.onConflictDoUpdate({
				target: catalogBlobs.pk,
				set: {
					cid,
					mimeType: opts.mimeType,
					size: opts.bytes.byteLength,
					objectKey,
					source: opts.source,
				},
			})
			.run();

		return {
			pk,
			objectKey,
			cid,
			mimeType: opts.mimeType,
			size: opts.bytes.byteLength,
			url: this.urlFor(objectKey),
		};
	}

	urlFor(objectKey: string): string {
		if (this.cfg.publicBaseUrl) {
			return `${this.cfg.publicBaseUrl.replace(/\/$/, '')}/${objectKey}`;
		}
		// No CDN configured: serve through the app's blob proxy (registered in app.ts).
		return `/catalog-blobs/${objectKey}`;
	}

	async get(objectKey: string): Promise<Uint8Array> {
		return this.op.read(objectKey);
	}

	async delete(entityType: string, entityPk: string, kind: string): Promise<void> {
		const row = this.db
			.select()
			.from(catalogBlobs)
			.where(eq(catalogBlobs.pk, `${entityType}:${entityPk}:${kind}`))
			.get();
		if (!row) return;
		await this.op.delete(row.objectKey);
		this.db.delete(catalogBlobs).where(eq(catalogBlobs.pk, row.pk)).run();
	}
}
