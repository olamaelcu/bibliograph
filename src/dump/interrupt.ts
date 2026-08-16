import { logger } from '../logger.js';

/** Thrown when an import loop observes a graceful-stop signal. */
export class InterruptedError extends Error {
  constructor(public readonly signal: 'SIGINT' | 'SIGTERM' | string) {
    super(`import interrupted by ${signal}`);
    this.name = 'InterruptedError';
  }
}

/** Map a signal name to the conventional process exit code (128 + signum). */
export function signalExitCode(signal: string): number {
  return signal === 'SIGTERM' ? 143 : 130; // 128 + SIGTERM(15) / SIGINT(2)
}

export interface InterruptHandle {
  controller: AbortController;
  signal: AbortSignal;
  /** Name of the first signal observed, or null if none. */
  interruptedBy: () => string | null;
  /** Exit just the CLI process after a graceful stop; does not abort again. */
  exit: () => void;
  dispose: () => void;
}

/**
 * Install SIGINT/SIGTERM handlers that request a graceful stop: the first
 * observation aborts the signal (import loops stop at a safe point and run
 * their cleanup), the second forces an immediate exit so the operator is never
 * trapped by a stuck phase.
 */
export function installInterruptHandlers(): InterruptHandle {
  const controller = new AbortController();
  let observed: string | null = null;
  let count = 0;

  const onSignal = (signal: string) => (): void => {
    count += 1;
    if (count === 1) {
      observed = signal;
      logger.warn({ signal }, 'interrupt received; stopping import gracefully');
      controller.abort(new InterruptedError(signal));
      return;
    }
    logger.error({ signal }, 'second interrupt; forcing exit');
    process.exit(signalExitCode(signal));
  };

  const sigint = onSignal('SIGINT');
  const sigterm = onSignal('SIGTERM');
  process.on('SIGINT', sigint);
  process.on('SIGTERM', sigterm);

  return {
    controller,
    signal: controller.signal,
    interruptedBy: () => observed,
    exit: () => {
      if (observed) process.exit(signalExitCode(observed));
    },
    dispose: () => {
      process.off('SIGINT', sigint);
      process.off('SIGTERM', sigterm);
    },
  };
}

/**
 * The abort reason if a graceful stop fired, else null. Preserves an explicit
 * Error reason (including InterruptedError) so callers can distinguish an
 * interrupt from an unrelated error; aborts without a reason fall back to a
 * generic InterruptedError for SIGINT.
 */
export function abortReason(signal: AbortSignal | undefined): InterruptedError | Error | null {
  if (!signal?.aborted) return null;
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new InterruptedError('SIGINT');
}
