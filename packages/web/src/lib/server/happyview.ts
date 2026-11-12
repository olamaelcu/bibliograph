import { env } from "$env/dynamic/private";

import { metrics, recordHappyViewRequest } from "$lib/server/metrics";

/** Upstream request headers worth relaying; everything else is hop-by-hop. */
const FORWARDED_REQUEST_HEADERS = ["content-type", "accept", "authorization", "dpop"] as const;

/** Response headers the caller needs back (XRPC errors and DPoP replay data). */
const FORWARDED_RESPONSE_HEADERS = ["content-type", "dpop-nonce"] as const;

/**
 * The envelope a script's `fail()` returns.
 *
 * A handler cannot choose its own HTTP status — it returns a table, and
 * HappyView writes it as a `200` body. The wrapper is what tells this gateway
 * that the table was a failure and which status it asked for, so unwrapping it
 * here is what turns `fail(404, 'RecordNotFound', …)` into an actual 404 for
 * every caller.
 */
const SCRIPT_FAILURE = "__bib_http";

type ScriptFailure = { status: number; body: unknown };

function scriptFailure(status: number, body: unknown): ScriptFailure | null {
  if (!Number.isInteger(status) || status < 400 || status > 599) return null;
  if (body === null || typeof body !== "object") return null;
  return { status, body };
}

/**
 * Read a `200` body that is only the `fail()` envelope, and say what it meant.
 *
 * Deliberately narrow: a `200` whose whole body is an object carrying nothing
 * but `__bib_http`, whose `status` is a 4xx/5xx integer and whose `body` is an
 * object. Anything else — a real payload with the key in it, a status outside
 * the error range, a body HappyView already failed the request with — is
 * relayed untouched, because a proxy that guesses would turn a successful
 * response into an error.
 */
function unwrapScriptFailure(bytes: ArrayBuffer, contentType: string | null): ScriptFailure | null {
  if (bytes.byteLength === 0) return null;
  if (contentType === null || !contentType.toLowerCase().includes("application/json")) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== SCRIPT_FAILURE) return null;

  const envelope = (parsed as Record<string, unknown>)[SCRIPT_FAILURE];
  if (envelope === null || typeof envelope !== "object") return null;
  const { status, body } = envelope as Record<string, unknown>;

  return scriptFailure(status as number, body);
}

const DEFAULT_HAPPYVIEW_URL = "http://127.0.0.1:3000";

/**
 * The client identity belongs to this server, never to the browser.
 *
 * Built from scratch rather than copied from the request: a caller must not be
 * able to choose the credentials the edge presents upstream.
 */
function clientHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (env.HAPPYVIEW_CLIENT_KEY) headers["x-client-key"] = env.HAPPYVIEW_CLIENT_KEY;
  if (env.HAPPYVIEW_CLIENT_SECRET) headers["x-client-secret"] = env.HAPPYVIEW_CLIENT_SECRET;
  return headers;
}

/**
 * Proxy one XRPC call to the AppView and return its response.
 *
 * `method` is the NSID from the path; the verb comes from the request, which the
 * route has already constrained to GET or POST.
 *
 * The edge holds no user session. `authorization` and `dpop` are relayed from
 * the caller untouched: that is how a trusted server-side client presents an
 * inter-service JWT or its own DPoP-bound session, and the AppView — not this
 * proxy — decides what those credentials are worth.
 *
 * A script's `fail()` envelope is the one thing not relayed as it arrived (see
 * `unwrapScriptFailure`): it is a failure the caller asked for, and only this
 * layer can turn it into the status it names.
 */
async function forwardRequest(method: string, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers();

  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  for (const [name, value] of Object.entries(clientHeaders())) headers.set(name, value);

  const body = request.method === "POST" ? await request.arrayBuffer() : undefined;

  let upstream: Response;
  try {
    const base = (env.HAPPYVIEW_URL || DEFAULT_HAPPYVIEW_URL).replace(/\/+$/, "");
    upstream = await fetch(`${base}/xrpc/${method}${url.search}`, {
      method: request.method,
      headers,
      body,
    });
  } catch {
    return new Response(JSON.stringify({ error: "UpstreamUnavailable" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }

  const response = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) response.set(name, value);
  }

  const bytes = await upstream.arrayBuffer();

  // A script reports failure by returning the envelope, which HappyView writes
  // as a `200`. Only a `200` can be one: any other status is HappyView itself
  // answering, and that answer is already the right one.
  if (upstream.status === 200) {
    const failure = unwrapScriptFailure(bytes, upstream.headers.get("content-type"));
    if (failure !== null) {
      response.set("content-type", "application/json");
      return new Response(JSON.stringify(failure.body), {
        status: failure.status,
        headers: response,
      });
    }
  }

  return new Response(bytes, {
    status: upstream.status,
    headers: response,
  });
}

/**
 * Count one XRPC call and relay it. The counter is recorded only after the
 * proxy produced a response, so the status label is the status the caller
 * actually saw; a thrown error (a bug, not an upstream failure) is still
 * counted as an exception before propagating.
 */
export async function forward(method: string, request: Request): Promise<Response> {
  try {
    const response = await forwardRequest(method, request);
    recordHappyViewRequest(metrics, { method, status: response.status });
    return response;
  } catch (error) {
    recordHappyViewRequest(metrics, { method, status: 0, outcome: "exception" });
    throw error;
  }
}
