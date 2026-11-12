import test from 'node:test';
import assert from 'node:assert/strict';
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
    assert.match(source, /requireAdmin\(cookies\)/, `${kind} GET/POST must call requireAdmin`);
    assert.match(source, /export const GET/, `${kind} must expose GET`);
    assert.match(source, /export const POST/, `${kind} must expose POST`);
    assert.match(source, /status: 404/, `${kind} must answer an unknown row with 404`);
    assert.doesNotMatch(
      source,
      /export const (PUT|PATCH|DELETE)/,
      `${kind} must not expose another write verb`
    );
    assert.doesNotMatch(source, /pds_outbox/, `${kind} must not write the outbox directly`);
  }
});

test('entity editor page loads require the admin cookie and answer 404', () => {
  for (const [kind, url] of Object.entries(PAGE_LOADS)) {
    const source = readFileSync(url, 'utf8');
    assert.match(source, /requireAdmin\(cookies\)/, `${kind} page must call requireAdmin`);
    assert.match(source, /error\(404/, `${kind} page must answer an unknown row with 404`);
    assert.doesNotMatch(source, /pds_outbox/);
  }
});
