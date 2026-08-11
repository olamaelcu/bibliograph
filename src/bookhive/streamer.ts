export interface BookhiveRawRecord {
  uri: string;
  cid: string;
  value: Record<string, unknown>;
}

export interface BookhiveRecord {
  uri: string;
  rkey: string;
  record: Record<string, unknown>;
}

export interface ListRecordsOpts {
  repo: string;
  collection: string;
  limit: number;
  cursor?: string;
}

export interface ListRecordsResponse {
  records: BookhiveRawRecord[];
  cursor?: string;
}

export type ListRecordsFn = (opts: ListRecordsOpts) => Promise<ListRecordsResponse>;

export interface BookhiveStreamerOptions {
  pdsUrl: string;
  repoDid: string;
  collection: string;
  pageSize: number;
  listRecords: ListRecordsFn;
}

export interface BookhiveIterOptions {
  resumeCursor?: string;
}

function rkeyFromUri(uri: string): string {
  const idx = uri.lastIndexOf('/');
  return idx === -1 ? uri : uri.slice(idx + 1);
}

async function defaultListRecords(
  pdsUrl: string,
  opts: ListRecordsOpts,
): Promise<ListRecordsResponse> {
  const params = new URLSearchParams({
    repo: opts.repo,
    collection: opts.collection,
    limit: String(opts.limit),
  });
  if (opts.cursor) params.set('cursor', opts.cursor);
  const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `listRecords: ${pdsUrl}/xrpc/com.atproto.repo.listRecords returned ${res.status} ${body.slice(0, 200)}`,
    );
  }
  return (await res.json()) as ListRecordsResponse;
}

export class BookhiveStreamer {
  constructor(private readonly opts: BookhiveStreamerOptions) {}

  async *iter(opts: BookhiveIterOptions = {}): AsyncGenerator<BookhiveRecord> {
    const listRecords =
      this.opts.listRecords ??
      ((reqOpts) => defaultListRecords(this.opts.pdsUrl, reqOpts));
    let cursor: string | undefined = opts.resumeCursor;
    while (true) {
      const page = await listRecords({
        repo: this.opts.repoDid,
        collection: this.opts.collection,
        limit: this.opts.pageSize,
        cursor,
      });
      for (const raw of page.records) {
        yield { uri: raw.uri, rkey: rkeyFromUri(raw.uri), record: raw.value };
      }
      if (!page.cursor) return;
      cursor = page.cursor;
    }
  }
}

export const _internal = { defaultListRecords, rkeyFromUri };
