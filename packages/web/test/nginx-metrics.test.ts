import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * The public vhost must never serve /metrics. Prometheus scrapes the web
 * process on loopback directly; nginx's exact-match location is the guard that
 * keeps the internet from reading internal telemetry.
 */

const config = await readFile(
  new URL('../../../packaging/web/nginx/bibliograph.conf', import.meta.url),
  'utf8'
);

test('the public vhost denies /metrics and does not proxy it', () => {
  const matches = [...config.matchAll(/location\s*=\s*\/metrics\s*\{([\s\S]*?)\}/g)];
  assert.equal(matches.length, 1, 'exactly one exact-match /metrics location');
  const block = matches[0][1];
  assert.match(block, /allow\s+127\.0\.0\.1;/);
  assert.match(block, /deny\s+all;/);
  assert.doesNotMatch(block, /proxy_pass/, 'the denied path is never proxied upstream');
});

test('the upstream remains the loopback web process the scraper targets', () => {
  assert.match(config, /upstream bibliograph_web\s*\{\s*server 127\.0\.0\.1:5176;/);
});
