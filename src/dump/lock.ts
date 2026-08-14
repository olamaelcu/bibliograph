import { closeSync, existsSync, openSync, unlinkSync, writeSync } from 'node:fs';

/** Acquire an exclusive lockfile; returns false if already held. */
export function acquireLock(lockPath: string, force = false): boolean {
  if (!existsSync(lockPath)) {
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
  if (!force) return false;
  unlinkSync(lockPath);
  return acquireLock(lockPath, false);
}

export function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // already gone
  }
}
