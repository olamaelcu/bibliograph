/**
 * The request half of `net.olamaelcu.livtet.biblio.giveaway.extend`.
 *
 * Extending is the only mutation of a giveaway's terms, and it is the only way
 * `giveaway_terms.closes_at` moves forwards. The caller must be the author —
 * proven by an atproto service JWT their PDS minted for this method, exactly as
 * the draw does — so an account that rewrites its own record by hand cannot
 * change the date the AppView will accept: a record that disagrees with the
 * verified term is refused by the draw until it is rewritten back.
 *
 * The order of the checks decides which error a caller sees, so it is the order
 * below. `TermMismatch` comes before `NotLater`: a caller working from a record
 * that has already been tampered with should be told about the discrepancy, not
 * about the date it happened to send.
 */

import type { EntityQueryable } from './entities.ts';
import { getGiveaway } from './giveaway.ts';
import type { DrawPool } from './giveaway-draw.ts';
import { GIVEAWAY_EXTEND } from './entity-methods.ts';
import {
  authorizeExtension,
  isConcluded,
  verifyGiveawayTerm,
} from './giveaway-terms.ts';
import { createDidResolver } from '../feeds/did.ts';
import { SERVICE_DID_HOSTNAME, didWeb } from '../service-did.ts';
import { ServiceAuthError, verifyServiceAuthJwt, type DidResolver } from '../xrpc/service-auth.ts';

const ERROR_AUTH_REQUIRED = 'AuthRequired';
const ERROR_INVALID_REQUEST = 'InvalidRequest';
const ERROR_NOT_FOUND = 'NotFound';
const ERROR_NOT_AUTHOR = 'NotAuthor';
const ERROR_NOT_LATER = 'NotLater';
const ERROR_ALREADY_DRAWN = 'AlreadyDrawn';
const ERROR_TERM_MISMATCH = 'TermMismatch';

export type GiveawayExtendContext = {
  plcUrl: string;
  pool: EntityQueryable & DrawPool;
};

function fail(status: number, error: string, message: string, extra?: object): Response {
  return new Response(JSON.stringify({ error, message, ...extra }), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function bearerToken(header: string | null): string | null {
  if (header === null) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

let resolverCache: { plcUrl: string; resolve: DidResolver } | undefined;

function didResolver(plcUrl: string): DidResolver {
  if (resolverCache?.plcUrl !== plcUrl) {
    resolverCache = { plcUrl, resolve: createDidResolver({ plcUrl }) };
  }
  return resolverCache.resolve;
}

export function giveawayExtendAudience(): string {
  return didWeb(SERVICE_DID_HOSTNAME);
}

interface ExtendBody {
  giveaway: string;
  closesAt: string;
}

async function readExtend(request: Request): Promise<ExtendBody | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const { giveaway, closesAt } = body as { giveaway?: unknown; closesAt?: unknown };
  if (typeof giveaway !== 'string' || giveaway === '') return null;
  if (typeof closesAt !== 'string' || closesAt === '') return null;
  return { giveaway, closesAt };
}

export async function giveawayExtend(
  request: Request,
  context: GiveawayExtendContext
): Promise<Response> {
  const token = bearerToken(request.headers.get('authorization'));
  if (token === null) {
    return fail(401, ERROR_AUTH_REQUIRED, 'this method requires an atproto service token');
  }

  let issuer: string;
  try {
    issuer = await verifyServiceAuthJwt(token, {
      audience: giveawayExtendAudience(),
      lxm: GIVEAWAY_EXTEND,
      resolveDid: didResolver(context.plcUrl)
    });
  } catch (error) {
    if (error instanceof ServiceAuthError) {
      console.warn('[giveaway.extend] rejected service token', error.reason);
      return fail(401, ERROR_AUTH_REQUIRED, 'the service token was rejected');
    }
    throw error;
  }

  const body = await readExtend(request);
  if (body === null) {
    return fail(400, ERROR_INVALID_REQUEST, 'the input must be `{ giveaway, closesAt }`');
  }

  const giveaway = await getGiveaway(context.pool, body.giveaway);
  if (giveaway === null) {
    return fail(404, ERROR_NOT_FOUND, 'no giveaway has that URI');
  }
  if (issuer !== giveaway.author) {
    return fail(403, ERROR_NOT_AUTHOR, 'only the giveaway’s author can extend it');
  }
  if (await isConcluded(context.pool, body.giveaway)) {
    return fail(409, ERROR_ALREADY_DRAWN, 'this giveaway has already been drawn');
  }

  // The record must agree with the verified term before anything moves: an
  // extension requested from a disputed record would launder the discrepancy.
  const verdict = await verifyGiveawayTerm(context.pool, body.giveaway);
  if (!verdict.ok) {
    if (verdict.reason === 'not-found') {
      return fail(404, ERROR_NOT_FOUND, 'no giveaway has that URI');
    }
    return fail(409, ERROR_TERM_MISMATCH, mismatchMessage(verdict.stored, verdict.current), {
      stored: verdict.stored,
      current: verdict.current,
      relation: verdict.relation
    });
  }

  const extension = await authorizeExtension(context.pool, body.giveaway, body.closesAt);
  if (!extension.ok) {
    if (extension.reason === 'not-found') {
      return fail(404, ERROR_NOT_FOUND, 'no giveaway has that URI');
    }
    return fail(
      409,
      ERROR_NOT_LATER,
      `the closing date can only move later; it is recorded as ${verdict.closesAt}`,
      { stored: verdict.closesAt }
    );
  }

  return new Response(
    JSON.stringify({ giveaway: body.giveaway, closesAt: extension.closesAt }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

/** The discrepancy, stated with both dates so a caller can act without prose. */
export function mismatchMessage(stored: string, current: string): string {
  if (current === '') {
    return `the record has no readable closing date; it is recorded as ${stored}`;
  }
  return `the record's closing date is ${current}, but the verified date is ${stored}`;
}
