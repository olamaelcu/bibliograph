import { expect, test } from 'vitest';

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
  expect(matches.length, 'exactly one exact-match /metrics location').toBe(1);
  const block = matches[0][1];
  expect(block).toMatch(/allow\s+127\.0\.0\.1;/);
  expect(block).toMatch(/deny\s+all;/);
  expect(block, 'the denied path is never proxied upstream').not.toMatch(/proxy_pass/);
});

test('the upstream remains the loopback web process the scraper targets', () => {
  expect(config).toMatch(/upstream bibliograph_web\s*\{\s*server 127\.0\.0\.1:5176;/);
});
