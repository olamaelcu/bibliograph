import type { Context } from 'hono';
import { createTestDb } from './db.js';

export function createMockContext(overrides: {
  query?: Record<string, string>;
  queries?: Record<string, string[]>;
  json?: unknown;
  headers?: Record<string, string>;
} = {}): Context {
  const query = { ...overrides.query };
  const queries = { ...overrides.queries };
  const jsonBody = overrides.json;

  const headers = new Headers(overrides.headers);
  const req = new Request('http://localhost', { headers });

  const store = new Map<string, unknown>();
  store.set('log', console);

  return {
    req: {
      query: () => query,
      queries: (key: string) => queries[key] ?? undefined,
      json: () => Promise.resolve(jsonBody),
      raw: req,
    },
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => store.set(key, value),
    json: (data: unknown, status?: number) =>
      new Response(JSON.stringify(data), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    html: (content: string) =>
      new Response(content, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    text: (content: string, status?: number) =>
      new Response(content, {
        status: status ?? 200,
        headers: { 'content-type': 'text/plain' },
      }),
    header: (_name: string, _value?: string) => {},
    status: (_code: number) => ({}),
    res: {} as Response,
  } as unknown as Context;
}

export function createTestAppContext() {
  return createTestDb();
}

export async function readJsonBody(res: Response): Promise<unknown> {
  return JSON.parse(await res.text());
}
