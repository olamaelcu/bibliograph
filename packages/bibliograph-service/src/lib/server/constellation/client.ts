import { createLogger } from '../logger';

const log = createLogger('web');

export const CONSTELLATION_URL = process.env.CONSTELLATION_URL ?? 'https://constellation.microcosm.blue';
export const CONSTELLATION_TIMEOUT_MS = 5_000;
export const CONSTELLATION_USER_AGENT = 'bibliograph/0.1.0 (+https://biblio.livtet.olamaelcu.net)';

export type ShelvingSource =
  | 'net.olamaelcu.livtet.biblio.bookShelving:book.ref'
  | 'net.olamaelcu.livtet.biblio.bookShelving:shelf';

export interface BacklinkRecord {
  uri: string;
  did: string;
}

export interface BacklinkPage {
  records: BacklinkRecord[];
  cursor?: string;
}

export interface GetBacklinksParams {
  subject: string;
  source: ShelvingSource;
  did?: string;
  limit: number;
  cursor?: string;
  signal?: AbortSignal;
}

export async function getBacklinks(params: GetBacklinksParams): Promise<BacklinkPage> {
  const url = new URL(`${CONSTELLATION_URL}/xrpc/blue.microcosm.links.getBacklinks`);
  url.searchParams.set('subject', params.subject);
  url.searchParams.set('source', params.source);
  url.searchParams.set('limit', String(params.limit));
  if (params.did) url.searchParams.set('did', params.did);
  if (params.cursor) url.searchParams.set('cursor', params.cursor);

  const signal = params.signal ?? AbortSignal.timeout(CONSTELLATION_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': CONSTELLATION_USER_AGENT,
      },
      signal,
    });
  } catch (err) {
    log.warn({ err, subject: params.subject, source: params.source }, 'constellation: fetch failed');
    return { records: [] };
  }

  if (!res.ok) {
    log.warn({ status: res.status, subject: params.subject, source: params.source }, 'constellation: non-2xx');
    return { records: [] };
  }

  let body: { records?: Array<{ uri?: string; did?: string; collection?: string; rkey?: string }>; cursor?: string | null };
  try {
    body = (await res.json()) as typeof body;
  } catch (err) {
    log.warn({ err, subject: params.subject }, 'constellation: parse failed');
    return { records: [] };
  }

  const records: BacklinkRecord[] = [];
  for (const r of body.records ?? []) {
    let uri: string | undefined;
    let did: string | undefined;
    if (typeof r.uri === 'string') {
      uri = r.uri;
      const m = /^at:\/\/([^/]+)\//.exec(uri);
      if (m) did = m[1];
    }
    if (!uri && typeof r.did === 'string' && typeof r.collection === 'string' && typeof r.rkey === 'string') {
      uri = `at://${r.did}/${r.collection}/${r.rkey}`;
      did = r.did;
    }
    if (uri && did) records.push({ uri, did });
  }
  return { records, cursor: body.cursor ?? undefined };
}
