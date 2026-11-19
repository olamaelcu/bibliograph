/**
 * State and process plumbing shared by the Playwright global setup and the
 * specs.
 *
 * The global setup runs in its own process; test workers are spawned after it
 * and do not inherit env changes reliably, so everything the spec needs is
 * written to `.cache/e2e/state.json` instead. `.cache/` is gitignored.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STATE_DIR = fileURLToPath(new URL('../.cache/e2e/', import.meta.url));
const STATE_FILE = `${STATE_DIR}state.json`;

export type HarnessState = {
  /** False when the fixture stack was not reachable; `reason` says why. */
  ready: boolean;
  reason?: string;
  databaseUrl: string;
  edgeUrl: string;
  workerAdminUrl: string;
  labelerUrl: string;
  /** Multikey of the throwaway labeler key, for verifying the signature. */
  labelerPublic: string;
  librarianDid: string;
  /** The fixture account the suite signs in as, with the PDS's own forms. */
  librarianHandle: string;
  contributorUri: string;
  contributorName: string;
  approvedDid: string;
  rejectedDid: string;
  /** The fixture PDS repo the `knownContributor` record is published into. */
  publisherDid: string;
  pdsUrl: string;
  /** The operator token `/admin` accepts (a test constant here). */
  adminToken: string;
  /** Catalog rows the admin scenarios act on. */
  contributorSourceId: string;
  contributorTargetId: string;
  publisherSourceId: string;
  publisherTargetId: string;
  bookBaseUri: string;
  bookOtherUri: string;
  /** Rows the guard scenarios act on; nothing else touches them. */
  guardContributorId: string;
  guardPublisherId: string;
  deleteEditionUri: string;
  bothIdentitySourceId: string;
  bothIdentityTargetId: string;
  workbenchBaseUri: string;
  workbenchOtherUri: string;
  workerLog: string;
  edgeLog: string;
};

export function writeState(state: HarnessState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  rmSync(STATE_FILE, { force: true });
  appendFileSync(STATE_FILE, `${JSON.stringify(state, null, 1)}\n`);
}

export function readState(): HarnessState | null {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as HarnessState;
  } catch {
    return null;
  }
}

export function clearState(): void {
  rmSync(STATE_FILE, { force: true });
}

/** Poll until `url` answers at all (any status), or throw. */
export async function waitForHttp(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      await fetch(url, { redirect: 'manual' });
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${url}: ${lastError}`);
}

type StartOptions = {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** A line on stdout/stderr that means the process is serving. */
  readyPattern: RegExp;
  logFile: string;
  timeoutMs?: number;
};

/**
 * Start a daemon and resolve once it says it is ready.
 *
 * Everything it prints is appended to `logFile` so a failed run leaves the
 * worker's and the edge's own account of what happened, and an early exit
 * rejects with the tail of that log instead of a bare code.
 */
export function startProcess({
  name,
  command,
  args,
  cwd,
  env,
  readyPattern,
  logFile,
  timeoutMs = 120_000
}: StartOptions): Promise<ChildProcess> {
  mkdirSync(STATE_DIR, { recursive: true });
  rmSync(logFile, { force: true });

  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false
  });

  const { promise, resolve, reject } = Promise.withResolvers<ChildProcess>();
  let settled = false;
  let buffered = '';

  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    fn();
  };

  const onData = (chunk: Buffer) => {
    const text = chunk.toString();
    appendFileSync(logFile, text);
    if (readyPattern.test(text)) {
      settle(() => resolve(child));
      return;
    }
    buffered = `${buffered}${text}`.slice(-4000);
  };

  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    settle(() => reject(new Error(`${name} did not become ready in ${timeoutMs}ms:\n${buffered}`)));
  }, timeoutMs);

  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.on('error', (error) => settle(() => reject(error)));
  child.on('exit', (code, signal) =>
    settle(() =>
      reject(new Error(`${name} exited before it was ready (${signal ?? code}):\n${buffered}`))
    )
  );

  return promise;
}

export function stopProcess(child: ChildProcess | undefined): void {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  setTimeout(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  }, 5000).unref();
}
