/**
 * The request half of `net.olamaelcu.livtet.biblio.giveaway.draw`.
 *
 * The order of the checks decides which error a caller sees, so it is the order
 * below: a caller with no token learns nothing about whether the giveaway exists,
 * and a caller who is not its author learns nothing about whether it has closed.
 *
 * The caller is the giveaway's **author**, proven by an atproto service JWT their
 * own PDS minted for `aud` = this host's `did:web` and `lxm` = this method. The
 * issuer is read from the verified token's `iss`, never from a header: a
 * caller-supplied DID proves nothing, and the whole point of the exchange is that
 * only the account holding the author's repo keys can conclude their giveaway.
 *
 * The PLC directory and the index pool arrive as arguments rather than from
 * `$env`, so this module is a plain function of its inputs: the route binds the
 * deployment's values, and the tests exercise the whole decision table without a
 * SvelteKit module or a network.
 */

import type { EntityQueryable } from './entities.ts';
import { getGiveaway } from './giveaway.ts';
import { concludeGiveaway, type DrawPool } from './giveaway-draw.ts';
import { GIVEAWAY_DRAW } from './entity-methods.ts';
import { verifyGiveawayTerm } from './giveaway-terms.ts';
import { mismatchMessage } from './giveaway-extend-handler.ts';
import { createDidResolver } from '../feeds/did.ts';
import { SERVICE_DID_HOSTNAME, didWeb } from '../service-did.ts';
import {
  ServiceAuthError,
  verifyServiceAuthJwt,
  type DidResolver
} from '../xrpc/service-auth.ts';

const ERROR_AUTH_REQUIRED = 'AuthRequired';
const ERROR_INVALID_REQUEST = 'InvalidRequest';
const ERROR_NOT_FOUND = 'NotFound';
const ERROR_NOT_AUTHOR = 'NotAuthor';
const ERROR_NOT_CLOSED = 'NotClosed';
const ERROR_TERM_MISMATCH = 'TermMismatch';

/** What the route binds: the deployment's PLC directory and the index pool. */
export type GiveawayDrawContext = {
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

/** The audience: this host's service identity, without a fragment. */
export function giveawayDrawAudience(): string {
  return didWeb(SERVICE_DID_HOSTNAME);
}

/** `{ giveaway }` from the JSON body, or `null` when the body is anything else. */
async function readGiveaway(request: Request): Promise<string | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  if (!('giveaway' in body)) return null;
  const giveaway = body.giveaway;
  return typeof giveaway === 'string' && giveaway !== '' ? giveaway : null;
}

export async function giveawayDraw(
  request: Request,
  context: GiveawayDrawContext
): Promise<Response> {
  const token = bearerToken(request.headers.get('authorization'));
  if (token === null) {
    return fail(401, ERROR_AUTH_REQUIRED, 'this method requires an atproto service token');
  }

  let issuer: string;
  try {
    issuer = await verifyServiceAuthJwt(token, {
      audience: giveawayDrawAudience(),
      lxm: GIVEAWAY_DRAW,
      resolveDid: didResolver(context.plcUrl)
    });
  } catch (error) {
    if (error instanceof ServiceAuthError) {
      // The reason names what failed in the caller's token, so it stays out of the
      // body: a 401 says only that the credential was refused.
      console.warn('[giveaway.draw] rejected service token', error.reason);
      return fail(401, ERROR_AUTH_REQUIRED, 'the service token was rejected');
    }
    throw error;
  }

  const giveawayUri = await readGiveaway(request);
  if (giveawayUri === null) {
    return fail(400, ERROR_INVALID_REQUEST, 'the input must be `{ giveaway }`');
  }

  const giveaway = await getGiveaway(context.pool, giveawayUri);
  if (giveaway === null) {
    return fail(404, ERROR_NOT_FOUND, 'no giveaway has that URI');
  }
  if (issuer !== giveaway.author) {
    return fail(403, ERROR_NOT_AUTHOR, 'only the giveaway’s author can conclude it');
  }
  // The verified term decides, not the record's: the record is editable by hand,
  // and a date moved out of band must be restored before anything is drawn.
  const verdict = await verifyGiveawayTerm(context.pool, giveawayUri);
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
  const closesAt = Date.parse(verdict.closesAt);
  if (Number.isNaN(closesAt) || Date.now() < closesAt) {
    return fail(409, ERROR_NOT_CLOSED, 'the giveaway is still open');
  }

  const outcome = await concludeGiveaway(context.pool, giveawayUri);
  if (!outcome.ok) {
    return fail(404, ERROR_NOT_FOUND, 'no giveaway has that URI');
  }
  return new Response(JSON.stringify(outcome.value), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}
