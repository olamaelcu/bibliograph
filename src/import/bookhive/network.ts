import { logger } from '../../logger.js';

const TRANSIENT_CODES = new Set([
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

/** Collect every error code reachable from `err`, walking `cause` chains and undici aggregate causes (one per tried address). */
function collectCodes(err: unknown, out: Set<string>): void {
  if (err == null || typeof err !== 'object') return;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') out.add(code);
  const child: unknown[] = [];
  const errors = (err as { errors?: unknown }).errors;
  if (Array.isArray(errors)) {
    for (const e of errors) child.push(e);
  }
  const cause = (err as { cause?: unknown }).cause;
  if (cause !== undefined && cause !== err) child.push(cause);
  for (const c of child) collectCodes(c, out);
}

/** True when `err` is a transient network failure worth retrying. */
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

/**
 * Invoke `fn`, retrying transient network failures (`isTransientNetworkError`)
 * with exponential backoff (+jitter). Non-transient errors rethrow immediately;
 * the final failure is logged at error level before being rethrown. `ctx` is
 * merged into every retry log line (e.g. the active cursor).
 */
export async function withRetry<T>(
  message: string,
  fn: () => Promise<T>,
  ctx: Record<string, unknown> = {},
  opts: { attempts?: number; baseDelayMs?: number; maxDelayMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  const maxDelay = opts.maxDelayMs ?? MAX_BACKOFF_MS;
  let backoffMs = opts.baseDelayMs ?? BASE_BACKOFF_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      const retryable = isTransientNetworkError(err) && attempt < attempts - 1;
      logger[retryable ? 'warn' : 'error'](
        { ...ctx, attempt: attempt + 1, err },
        retryable ? `${message}; retrying` : message,
      );
      if (!retryable) throw err;
      const jitter = Math.floor(Math.random() * backoffMs * 0.2);
      await sleep(backoffMs + jitter);
      backoffMs = Math.min(backoffMs * 2, maxDelay);
    }
  }
}
