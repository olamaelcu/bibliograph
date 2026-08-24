import type { RequestHandler } from './$types';
import { metricsRegistry } from '$lib/server/metrics';

export const GET: RequestHandler = async () => {
  const body = await metricsRegistry.metrics();
  return new Response(body, {
    status: 200,
    headers: { 'content-type': metricsRegistry.contentType },
  });
};