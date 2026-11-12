/**
 * Minimal atproto PDS client for the outbox publisher.
 *
 * Authentication is an account session on the publisher PDS, not a repo
 * signing key: the PDS owns the repo's signing key, so the publisher only
 * proves which account it is and asks for writes.
 *
 * Two credential shapes are accepted:
 *
 * - `PDS_ACCOUNT_DID` + `PDS_ACCOUNT_PASSWORD` (an app password): a fresh
 *   `com.atproto.server.createSession` per process, refreshed on expiry.
 * - `PDS_ACCESS_TOKEN` (+ optional `PDS_REFRESH_TOKEN`): a provisioned session,
 *   for deployments that would rather not put the account password on disk.
 *
 * Everything is validated before any row is claimed. Missing credentials are a
 * configuration error, never a silent no-op: publishing to the wrong repo or
 * dropping work without a trace is worse than refusing to start.
 */

export class PublisherConfigError extends Error {
  constructor(message, { problems = [] } = {}) {
    super(message);
    this.name = 'PublisherConfigError';
    this.problems = problems;
  }
}

export class PdsError extends Error {
  constructor(message, { status, code, body } = {}) {
    super(message);
    this.name = 'PdsError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * The repo authority catalog URIs are minted under: `ATP_SERVICE_DID` when set,
 * else `did:web:<ATP_SERVICE_HOST>`. This does not require publisher
 * credentials, so hydration keeps minting the same identity while pds-publish
 * is disabled. `PDS_ACCOUNT_DID` is deliberately not a fallback here: it names
 * the authenticated account, and only config resolution may adopt it when no
 * explicit authority exists.
 */
export function resolvePublisherAuthority(env = process.env) {
  return (
    env.ATP_SERVICE_DID ||
    (env.ATP_SERVICE_HOST ? `did:web:${env.ATP_SERVICE_HOST}` : undefined) ||
    undefined
  );
}

/**
 * Resolve and validate publisher configuration without touching the network.
 * `configured: false` carries the exact list of missing settings.
 */
export function resolvePublisherConfig(env = process.env) {
  const pdsUrl = typeof env.PDS_URL === 'string' ? env.PDS_URL.replace(/\/+$/, '') : undefined;
  const publisherDid =
    resolvePublisherAuthority(env) ||
    env.PDS_ACCOUNT_DID ||
    undefined;
  const accountDid = env.PDS_ACCOUNT_DID || publisherDid;
  const password = env.PDS_ACCOUNT_PASSWORD || undefined;
  const accessToken = env.PDS_ACCESS_TOKEN || undefined;
  const refreshToken = env.PDS_REFRESH_TOKEN || undefined;

  const problems = [];
  if (!pdsUrl) problems.push('PDS_URL');
  if (!publisherDid) problems.push('ATP_SERVICE_HOST or ATP_SERVICE_DID');
  if (!accessToken && !password) problems.push('PDS_ACCOUNT_PASSWORD or PDS_ACCESS_TOKEN');
  if (!accountDid) problems.push('PDS_ACCOUNT_DID');
  if (accountDid && publisherDid && accountDid !== publisherDid) {
    problems.push(
      `PDS_ACCOUNT_DID (${accountDid}) is not the publisher DID (${publisherDid}); ` +
        'the session must own the repo the catalog URIs name'
    );
  }

  return {
    pdsUrl,
    publisherDid,
    accountDid,
    password,
    accessToken,
    refreshToken,
    problems,
    configured: problems.length === 0
  };
}

export function publisherConfigError(config) {
  return new PublisherConfigError(
    'pds-publish is not configured: ' +
      config.problems.join('; ') +
      '. Set PDS_URL, the publisher identity (ATP_SERVICE_HOST / ATP_SERVICE_DID or ' +
      'PDS_ACCOUNT_DID) and either PDS_ACCOUNT_PASSWORD (app password) or PDS_ACCESS_TOKEN. ' +
      'The session account must be the repo owner — its DID is the authority in every ' +
      'catalog edition URI.',
    { problems: config.problems }
  );
}

async function readJson(response) {
  const text = await response.text();
  if (text === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: 'InvalidResponse', message: text.slice(0, 500) };
  }
}

export function createPdsPublisher({ config, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const cfg = config ?? resolvePublisherConfig();
  if (!cfg.configured) throw publisherConfigError(cfg);
  if (cfg.accountDid && cfg.publisherDid && cfg.accountDid !== cfg.publisherDid) {
    throw new PublisherConfigError(
      `PDS_ACCOUNT_DID (${cfg.accountDid}) is not the publisher DID (${cfg.publisherDid}); ` +
        'the session must own the repo the catalog URIs name'
    );
  }

  let session;
  let sessionPromise;

  async function request(nsid, { httpMethod = 'POST', body, token, headers = {} } = {}) {
    const init = {
      method: httpMethod,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs)
    };
    const response = await fetchImpl(`${cfg.pdsUrl}/xrpc/${nsid}`, init);
    const payload = await readJson(response);
    if (!response.ok) {
      throw new PdsError(
        `${nsid} failed: ${response.status} ${payload.error ?? ''} ${
          payload.message ?? ''
        }`.trim(),
        { status: response.status, code: payload.error, body: payload }
      );
    }
    return payload;
  }

  async function createSession() {
    if (cfg.accessToken) {
      const current = await request('com.atproto.server.getSession', {
        httpMethod: 'GET',
        token: cfg.accessToken
      });
      assertOwner(current.did);
      return { accessJwt: cfg.accessToken, refreshJwt: cfg.refreshToken };
    }

    const created = await request('com.atproto.server.createSession', {
      body: { identifier: cfg.accountDid, password: cfg.password }
    });
    if (typeof created.accessJwt !== 'string' || created.accessJwt === '') {
      throw new PdsError('createSession returned no accessJwt', { body: created });
    }
    assertOwner(created.did);
    return { accessJwt: created.accessJwt, refreshJwt: created.refreshJwt };
  }

  async function refreshSession(previous) {
    if (!previous?.refreshJwt) {
      if (!cfg.password) throw expiredSessionError();
      return createSession();
    }
    try {
      const refreshed = await request('com.atproto.server.refreshSession', {
        token: previous.refreshJwt
      });
      if (typeof refreshed.accessJwt !== 'string' || refreshed.accessJwt === '') {
        throw new PdsError('refreshSession returned no accessJwt', { body: refreshed });
      }
      assertOwner(refreshed.did);
      return { accessJwt: refreshed.accessJwt, refreshJwt: refreshed.refreshJwt };
    } catch {
      // A revoked or expired refresh token is recoverable with the password.
      // With a provisioned access token there is nothing left to try.
      if (!cfg.password) throw expiredSessionError();
      return createSession();
    }
  }

  function expiredSessionError() {
    return new PdsError(
      'the PDS session expired and no refresh token or account password is configured; ' +
        'issue a new PDS_ACCESS_TOKEN (and PDS_REFRESH_TOKEN) or set PDS_ACCOUNT_PASSWORD',
      { status: 401, code: 'ExpiredToken' }
    );
  }

  function assertOwner(did) {
    if (typeof did === 'string' && did !== '' && did !== cfg.publisherDid) {
      throw new PdsError(
        `authenticated as ${did}, but the catalog publishes as ${cfg.publisherDid}; ` +
          'set PDS_ACCOUNT_DID to the publisher account (or ATP_SERVICE_DID/ATP_SERVICE_HOST ' +
          'to the repo the account owns)',
        { code: 'WrongRepoOwner' }
      );
    }
  }

  /** One session per process; concurrent callers share the in-flight sign-in. */
  async function token(force = false) {
    if (session && !force) return session.accessJwt;
    sessionPromise ??= (async () => {
      const previous = session;
      session = undefined;
      try {
        session = await (force && previous ? refreshSession(previous) : createSession());
        return session.accessJwt;
      } catch (error) {
        if (error instanceof PdsError && error.status === 401) {
          throw new PdsError(
            `PDS rejected the publisher credentials (401 ${error.code ?? ''}): ` +
              'check PDS_ACCOUNT_DID / PDS_ACCOUNT_PASSWORD (use an app password) or the ' +
              'provisioned PDS_ACCESS_TOKEN',
            { status: 401, code: error.code, body: error.body }
          );
        }
        throw error;
      } finally {
        sessionPromise = undefined;
      }
    })();
    return sessionPromise;
  }

  /**
   * The PDS reports an expired access token either as 401 or as 400 with the
   * error code `ExpiredToken`. Both mean "refresh and retry"; every other
   * status/code is a real request failure that must not disturb the session.
   */
  function isExpiredToken(error) {
    if (!(error instanceof PdsError)) return false;
    return error.status === 401 || (error.status === 400 && error.code === 'ExpiredToken');
  }

  async function rpc(method, { body } = {}) {
    let accessJwt = await token();
    try {
      return await request(method, { body, token: accessJwt });
    } catch (error) {
      if (!isExpiredToken(error)) throw error;
      // Refresh once and retry once. A freshly minted token the PDS still
      // rejects is a credential problem, not a race worth another attempt.
      accessJwt = await token(true);
      return request(method, { body, token: accessJwt });
    }
  }

  function write(operation, collection, rkey, value) {
    const type = `com.atproto.repo.applyWrites#${operation}`;
    return {
      $type: type,
      collection,
      rkey,
      ...(operation === 'delete' ? {} : { value })
    };
  }

  /**
   * Send one write to the publisher repo. Returns the atproto result item
   * (`{ uri, cid, validationStatus }`, or `{ uri }` for deletes).
   */
  async function applyWrite({ operation, collection, rkey, value }) {
    const response = await rpc('com.atproto.repo.applyWrites', {
      body: {
        repo: cfg.publisherDid,
        validate: false,
        writes: [write(operation, collection, rkey, value)]
      }
    });
    const result = response.results?.[0];
    if (result === undefined) {
      throw new PdsError('applyWrites returned no result for the write', { body: response });
    }
    if (operation !== 'delete' && (typeof result.cid !== 'string' || result.cid === '')) {
      throw new PdsError(`applyWrites ${operation} returned no CID`, { body: response });
    }
    return result;
  }

  return {
    config: cfg,
    applyWrite,
    /** For diagnostics/tests; drops the cached session. */
    resetSession() {
      session = undefined;
    }
  };
}
