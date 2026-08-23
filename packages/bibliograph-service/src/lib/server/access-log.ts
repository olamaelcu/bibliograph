import type { FetchMiddleware } from '@atcute/xrpc-server';
import type { Logger } from 'pino';
import { correlationStorage, readOrGenerateCorrelationId, type CorrelationContext } from './correlation';

const RE_XRPC_NSID = /^\/xrpc\/([^/?]+)/;

export function accessLog(log: Logger): FetchMiddleware {
  return async (request, next) => {
    const correlationId = readOrGenerateCorrelationId(request);
    const requestLog = log.child({ correlationId });
    const ctx: CorrelationContext = { correlationId, log: requestLog };

    const url = new URL(request.url);
    const nsid = RE_XRPC_NSID.exec(url.pathname)?.[1] ?? null;
    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      request.headers.get('x-real-ip') ??
      null;
    const userAgent = request.headers.get('user-agent');

    const start = performance.now();
    const response = await correlationStorage.run(ctx, () => next(request));
    const durationMs = Math.round((performance.now() - start) * 100) / 100;

    response.headers.set('x-request-id', correlationId);

    const fields = {
      component: 'access',
      nsid,
      method: request.method,
      status: response.status,
      durationMs,
      ip,
      userAgent,
    };

    if (nsid === '_health' || request.method === 'OPTIONS') {
      requestLog.debug(fields, 'xrpc');
    } else if (response.status >= 500) {
      requestLog.error(fields, 'xrpc');
    } else if (response.status >= 400) {
      requestLog.warn(fields, 'xrpc');
    } else {
      requestLog.info(fields, 'xrpc');
    }

    return response;
  };
}
