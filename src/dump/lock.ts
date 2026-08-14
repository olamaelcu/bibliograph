import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';

/** True if `pid` is a live process on this host. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Acquire an exclusive lockfile; returns false if already held. */
export function acquireLock(lockPath: string, force = false): boolean {
  if (existsSync(lockPath)) {
    if (!force) {
      // A lockfile whose pid is no longer running is stale; take it over.
      try {
        const pid = Number(readFileSync(lockPath, 'utf8').split('\n')[0]);
        if (Number.isFinite(pid) && !isPidAlive(pid)) unlinkSync(lockPath);
        else return false;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
        // File vanished between existsSync and read — treat as unlocked.
      }
    } else {
      try {
        unlinkSync(lockPath);
      } catch {
        // raced away; fine
      }
    }
  }
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    writeSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

export function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // already gone
  }
}
