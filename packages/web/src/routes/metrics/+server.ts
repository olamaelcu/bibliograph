import type { RequestHandler } from './$types';
import { collectProcessMetrics, renderWebMetrics } from '$lib/server/metrics';

// Prometheus text exposition for the web process. The port is scraped on
// loopback (127.0.0.1:5176); the public vhost denies this path, so the endpoint
// never reaches the internet. Process gauges are collected per scrape; the
// request-scoped counters live in the module-level registry.
const CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export const GET: RequestHandler = () => {
  collectProcessMetrics();
  return new Response(renderWebMetrics(), {
    headers: { 'content-type': CONTENT_TYPE, 'cache-control': 'no-store' }
  });
};
