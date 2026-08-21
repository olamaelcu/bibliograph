import { logger } from '../logger.js';

const BASE_URL = 'https://www.googleapis.com/books/v1';

const FIELDS =
	'items(id,volumeInfo(title,subtitle,authors,publishedDate,description,industryIdentifiers,imageLinks))';

const FIELDS_GET =
	'id,volumeInfo(title,subtitle,authors,publishedDate,description,industryIdentifiers,imageLinks)';

const USER_AGENT = 'bibliograph/0.1 (atproto; google-books-cache; gzip)';

const MAX_RETRY_AFTER_MS = 60_000;

export const TRANSIENT_CODES = new Set([
	'ECONNRESET',
	'ECONNREFUSED',
	'ETIMEDOUT',
	'ENOTFOUND',
	'EAI_AGAIN',
	'ENETUNREACH',
	'EPIPE',
	'UND_ERR_SOCKET',
	'UND_ERR_CONNECT_TIMEOUT',
	'UND_ERR_HEADERS_TIMEOUT',
	'UND_ERR_BODY_TIMEOUT',
]);

const DEFAULT_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 4000;

function parseRetryAfter(value: string | null): number | undefined {
	if (value == null) return undefined;
	const trimmed = value.trim();
	if (trimmed === '') return undefined;
	const seconds = Number(trimmed);
	if (Number.isFinite(seconds) && Number.isInteger(seconds) && seconds >= 0) {
		return seconds * 1000;
	}
	const date = Date.parse(trimmed);
	if (!Number.isNaN(date)) {
		return Math.max(0, date - Date.now());
	}
	return undefined;
}

export function collectCodes(err: unknown, out: Set<string>): void {
	if (err == null || typeof err !== 'object') return;
	const code = (err as { code?: unknown }).code;
	if (typeof code === 'string') out.add(code);
	const errors = (err as { errors?: unknown }).errors;
	if (Array.isArray(errors)) {
		for (const e of errors) collectCodes(e, out);
	}
	const cause = (err as { cause?: unknown }).cause;
	if (cause !== undefined && cause !== err) collectCodes(cause, out);
}

export function isTransientNetworkError(err: unknown): boolean {
	const codes = new Set<string>();
	collectCodes(err, codes);
	for (const c of codes) {
		if (TRANSIENT_CODES.has(c)) return true;
	}
	return false;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
	message: string,
	fn: () => Promise<T>,
	ctx: Record<string, unknown> = {},
	opts: { signal?: AbortSignal; retryAfterMs?: number } = {},
): Promise<T> {
	const attempts = DEFAULT_ATTEMPTS;
	let backoffMs = BASE_BACKOFF_MS;
	const retryAfterCapMs = opts.retryAfterMs ?? MAX_RETRY_AFTER_MS;
	for (let attempt = 0; ; attempt += 1) {
		try {
			return await fn();
		} catch (err) {
			const errorRetryMs =
				err instanceof GoogleBooksError && err.retryAfterMs != null
					? Math.min(err.retryAfterMs, retryAfterCapMs)
					: undefined;
			const is429 = err instanceof GoogleBooksError && err.status === 429;
			const retryable =
				(isTransientNetworkError(err) || is429) &&
				attempt < attempts - 1 &&
				!opts.signal?.aborted;
			logger[retryable ? 'warn' : 'error'](
				{ ...ctx, attempt: attempt + 1, aborted: opts.signal?.aborted, err },
				retryable ? `${message}; retrying` : message,
			);
			if (!retryable) throw err;
			const delayMs =
				errorRetryMs ?? backoffMs + Math.floor(Math.random() * backoffMs * 0.2);
			await sleep(delayMs);
			if (errorRetryMs == null) backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
		}
	}
}

/** Subset of Google's `volumeInfo` we read. Unrecognized fields are ignored. */
export interface GbVolumeInfo {
	title?: string;
	subtitle?: string;
	authors?: string[];
	publishedDate?: string;
	description?: string;
	industryIdentifiers?: Array<{ type: string; identifier: string }>;
	imageLinks?: { thumbnail?: string; smallThumbnail?: string };
}

export interface GbVolume {
	id: string;
	volumeInfo?: GbVolumeInfo;
}

export interface GbSearchResponse {
	totalItems: number;
	items?: GbVolume[];
}

/** Public error type so callers can distinguish "no such volume" from a transport failure. */
export class GoogleBooksError extends Error {
	readonly retryAfterMs?: number;
	constructor(
		message: string,
		readonly status: number,
		opts: { retryAfterMs?: number } = {},
	) {
		super(message);
		this.name = 'GoogleBooksError';
		this.retryAfterMs = opts.retryAfterMs;
	}
}

export interface GoogleBooksClientOptions {
	apiKey: string;
	fetchImpl?: typeof fetch;
}

export class GoogleBooksClient {
	private readonly apiKey: string;
	private readonly fetchImpl: typeof fetch;

	constructor(opts: GoogleBooksClientOptions) {
		this.apiKey = opts.apiKey;
		this.fetchImpl = opts.fetchImpl ?? fetch;
	}

	private requireKey(): string {
		if (!this.apiKey) throw new Error('GOOGLE_BOOKS_API_KEY is not set');
		return this.apiKey;
	}

	private async fetchJson(
		url: string,
		ctx: Record<string, unknown>,
		opts: { signal?: AbortSignal } = {},
	): Promise<unknown> {
		this.requireKey();
		return withRetry(
			'google books fetch failed',
			async () => {
				const res = await this.fetchImpl(url, {
					signal: opts.signal,
					headers: {
						accept: 'application/json',
						'user-agent': USER_AGENT,
					},
				});
				if (res.status === 404) {
					throw new GoogleBooksError('not found', 404);
				}
				if (res.status === 429) {
					const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
					throw new GoogleBooksError(`http 429`, 429, { retryAfterMs });
				}
				if (res.status >= 500) {
					throw new GoogleBooksError(`http ${res.status}`, res.status);
				}
				if (!res.ok) {
					throw new GoogleBooksError(`http ${res.status}`, res.status);
				}
				return (await res.json()) as unknown;
			},
			ctx,
			{ signal: opts.signal },
		);
	}

	/** Full-text search against Google's catalog. Caps `maxResults` at 40 (GB's max). */
	async searchVolumes(
		q: string,
		opts: { startIndex?: number; maxResults?: number } = {},
		signal?: AbortSignal,
	): Promise<GbSearchResponse> {
		const params = new URLSearchParams({ q, key: this.apiKey });
		if (opts.startIndex != null) params.set('startIndex', String(opts.startIndex));
		if (opts.maxResults != null) params.set('maxResults', String(Math.min(opts.maxResults, 40)));
		params.set('fields', FIELDS);
		const url = `${BASE_URL}/volumes?${params.toString()}`;
		const body = (await this.fetchJson(
			url,
			{ endpoint: 'search', q },
			{ signal },
		)) as GbSearchResponse;
		return { totalItems: body.totalItems ?? 0, items: body.items ?? [] };
	}

	/** Fetch a single volume by GB volume ID. Returns undefined when 404. */
	async getVolume(volumeId: string, signal?: AbortSignal): Promise<GbVolume | undefined> {
		const url = `${BASE_URL}/volumes/${encodeURIComponent(volumeId)}?key=${this.apiKey}&fields=${FIELDS_GET}`;
		try {
			return (await this.fetchJson(url, { endpoint: 'get', volumeId }, { signal })) as GbVolume;
		} catch (err) {
			if (err instanceof GoogleBooksError && err.status === 404) return undefined;
			throw err;
		}
	}
}
