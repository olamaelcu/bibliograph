/**
 * Shared logic for the edition editor's Goodreads format lookup.
 *
 * The browser may send the ISBNs from the current, unsaved form; when it omits
 * them the route falls back to the edition's persisted identifiers. Both paths
 * are filtered to checksum-valid ISBN-10/13s, deduped and capped before the
 * worker sees the list.
 *
 * No SvelteKit imports: node tests drive this module with injected callbacks.
 */

import type { Identifier } from '../../admin/types.ts';
import { isbn13sFromIdentifiers, toIsbn13 } from '../catalog/isbn.ts';

export const MAX_RESOLVE_ISBNS = 10;

export class FormatResolutionError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, message: string, code: string) {
    super(message);
    this.name = 'FormatResolutionError';
    this.status = status;
    this.code = code;
  }
}

/** Filter form values through the ISBN checksum and dedupe normalised ISBN-13s. */
function normalizeFormIsbns(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new FormatResolutionError(400, 'isbns must be an array', 'InvalidIsbns');
  }
  const found = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const isbn = toIsbn13(entry);
    if (isbn !== null) found.add(isbn);
  }
  return [...found];
}

function selectResolutionIsbns(formIsbns: unknown, persisted: Identifier[]): string[] {
  const isbns =
    formIsbns === undefined ? isbn13sFromIdentifiers(persisted) : normalizeFormIsbns(formIsbns);
  const limited = isbns.slice(0, MAX_RESOLVE_ISBNS);
  if (limited.length === 0) {
    throw new FormatResolutionError(
      400,
      'No checksum-valid ISBN-10/13 identifiers are available for this edition',
      'NoIsbns'
    );
  }
  return limited;
}

export type FormatWorkerResult = { status: number; payload: unknown };

/**
 * Decide which ISBNs to send, optionally load the persisted edition, and hand
 * the list to the worker proxy. Worker failures (including its 404/502) are
 * returned unchanged so the browser sees the same status and message.
 */
export async function proxyFormatResolution(input: {
  body: Record<string, unknown>;
  loadIdentifiers: () => Promise<Identifier[] | null>;
  postWorker: (body: { isbns: string[] }) => Promise<FormatWorkerResult>;
}): Promise<FormatWorkerResult> {
  let persisted: Identifier[] = [];
  if (input.body.isbns === undefined) {
    const loaded = await input.loadIdentifiers();
    if (loaded === null) {
      throw new FormatResolutionError(404, 'edition not found', 'NotFound');
    }
    persisted = loaded;
  }
  const isbns = selectResolutionIsbns(input.body.isbns, persisted);
  return input.postWorker({ isbns });
}
