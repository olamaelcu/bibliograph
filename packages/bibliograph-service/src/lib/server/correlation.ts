import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';

export interface CorrelationContext {
  correlationId: string;
  log: Logger;
}

export const correlationStorage = new AsyncLocalStorage<CorrelationContext>();

export function getCorrelation(): CorrelationContext | undefined {
  return correlationStorage.getStore();
}

export function getCorrelationId(): string | undefined {
  return correlationStorage.getStore()?.correlationId;
}

export function getCorrelationLog(): Logger | undefined {
  return correlationStorage.getStore()?.log;
}

const HEADER = 'x-request-id';
const MAX_LEN = 128;
const VALID = /^[A-Za-z0-9._\-:]+$/;

export function readOrGenerateCorrelationId(request: Request): string {
  const incoming = request.headers.get(HEADER);
  if (incoming && incoming.length > 0 && incoming.length <= MAX_LEN && VALID.test(incoming)) {
    return incoming;
  }
  return randomUUID();
}
