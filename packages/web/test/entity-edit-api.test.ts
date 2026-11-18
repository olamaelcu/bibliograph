import { expect, test } from 'vitest';

import { readFileSync } from 'node:fs';

// The routes cannot be imported in a plain node test because auth.ts reads
// SvelteKit's `$env`; assert the wiring statically instead, like the report
// routes do.

const API_ROUTES = {
  contributor: new URL(
    '../src/routes/admin/api/contributors/[id]/+server.ts',
    import.meta.url
  ),
  publisher: new URL('../src/routes/admin/api/publishers/[id]/+server.ts', import.meta.url)
};

const PAGE_LOADS = {
  contributor: new URL(
    '../src/routes/admin/contributor/[id]/edit/+page.server.ts',
    import.meta.url
  ),
  publisher: new URL('../src/routes/admin/publisher/[id]/edit/+page.server.ts', import.meta.url)
};

test('entity API routes require the admin cookie and expose GET and POST only', () => {
  for (const [kind, url] of Object.entries(API_ROUTES)) {
    const source = readFileSync(url, 'utf8');
    expect(source, `${kind} GET/POST must call requireAdmin`).toMatch(/requireAdmin\(cookies\)/);
    expect(source, `${kind} must expose GET`).toMatch(/export const GET/);
    expect(source, `${kind} must expose POST`).toMatch(/export const POST/);
    expect(source, `${kind} must answer an unknown row with 404`).toMatch(/status: 404/);
    expect(source, `${kind} must not expose another write verb`).not.toMatch(/export const (PUT|PATCH|DELETE)/);
    expect(source, `${kind} must not write the outbox directly`).not.toMatch(/pds_outbox/);
  }
});

test('entity editor page loads require the admin cookie and answer 404', () => {
  for (const [kind, url] of Object.entries(PAGE_LOADS)) {
    const source = readFileSync(url, 'utf8');
    expect(source, `${kind} page must call requireAdmin`).toMatch(/requireAdmin\(cookies\)/);
    expect(source, `${kind} page must answer an unknown row with 404`).toMatch(/error\(404/);
    expect(source).not.toMatch(/pds_outbox/);
  }
});
