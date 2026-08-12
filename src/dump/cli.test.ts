import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OL_DUMP_BATCH_SIZE_DEFAULT_FOR_TESTS as resolver, parseArgs, acquireLock, clearStaleLockIfNeeded, isStaleLock, releaseLock } from './cli.js';

describe('cli batch-size env handling', () => {
  it('falls back to 500 for empty / NaN / non-positive env values', () => {
    expect(resolver('')).toBe(500);
    expect(resolver('NaN')).toBe(500);
    expect(resolver('0')).toBe(500);
    expect(resolver('-1')).toBe(500);
    expect(resolver('not-a-number')).toBe(500);
    expect(resolver('500')).toBe(500);
    expect(resolver('1000')).toBe(1000);
  });
});

describe('parseArgs', () => {
  it('parses --keep-dump and --force', () => {
    expect(parseArgs([]).keepDump).toBe(false);
    expect(parseArgs([]).force).toBe(false);
    expect(parseArgs(['--keep-dump']).keepDump).toBe(true);
    expect(parseArgs(['--force']).force).toBe(true);
    expect(parseArgs(['--keep-dump', '--force'])).toMatchObject({ keepDump: true, force: true });
  });

  it('still parses existing flags', () => {
    expect(parseArgs(['--no-download']).noDownload).toBe(true);
    expect(parseArgs(['--reset']).reset).toBe(true);
    expect(parseArgs(['--dry-run']).dryRun).toBe(true);
    expect(parseArgs(['--path=/tmp/d']).dumpPath).toBe('/tmp/d');
    expect(parseArgs(['--batch-size=200']).batchSize).toBe(200);
  });

  it('recognizes the hydrate-book-contributors subcommand', () => {
    expect(parseArgs(['hydrate-book-contributors']).command).toBe('hydrate-book-contributors');
    expect(parseArgs(['hydrate-book-contributors', '--reset']).command).toBe('hydrate-book-contributors');
    expect(parseArgs(['hydrate-book-contributors', '--reset']).reset).toBe(true);
    expect(parseArgs(['hydrate-book-contributors', '--dry-run']).dryRun).toBe(true);
  });
});

describe('lockfile', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cli-lock-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('acquires when no lockfile exists', () => {
    const lockPath = join(dir, '.import.lock');
    expect(acquireLock(lockPath, false)).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
    releaseLock(lockPath);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('refuses to acquire when a live lockfile exists (force=false)', () => {
    const lockPath = join(dir, '.import.lock');
    expect(acquireLock(lockPath, false)).toBe(true);
    expect(acquireLock(lockPath, false)).toBe(false);
  });

  it('refuses --force override of a LIVE lockfile', () => {
    const lockPath = join(dir, '.import.lock');
    writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}\n`);
    expect(acquireLock(lockPath, true)).toBe(false);
  });

  it('--force clears a stale lockfile (dead PID + old timestamp)', () => {
    const lockPath = join(dir, '.import.lock');
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    writeFileSync(lockPath, `999999\n${old}\n`);
    expect(isStaleLock(lockPath)).toBe(true);
    expect(acquireLock(lockPath, true)).toBe(true);
  });

  it('isStaleLock returns false for a recent live lockfile', () => {
    const lockPath = join(dir, '.import.lock');
    writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}\n`);
    expect(isStaleLock(lockPath)).toBe(false);
  });
});

describe('clearStaleLockIfNeeded', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cli-stale-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('is a no-op when no lockfile exists', () => {
    const lockPath = join(dir, '.import.lock');
    expect(clearStaleLockIfNeeded(lockPath)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('clears a lockfile whose PID is dead', () => {
    const lockPath = join(dir, '.import.lock');
    writeFileSync(lockPath, `${process.pid + 999_999}\n${new Date().toISOString()}\n`);
    expect(clearStaleLockIfNeeded(lockPath)).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('does not clear a lockfile held by a live process', () => {
    const lockPath = join(dir, '.import.lock');
    writeFileSync(lockPath, `${process.pid}\n${new Date().toISOString()}\n`);
    expect(clearStaleLockIfNeeded(lockPath)).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    releaseLock(lockPath);
  });

  it('does not clear a corrupted lockfile', () => {
    const lockPath = join(dir, '.import.lock');
    writeFileSync(lockPath, 'this is not a valid pid\n');
    expect(clearStaleLockIfNeeded(lockPath)).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
  });
});

describe('isStaleLock (PID-death only)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cli-stale-check-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns true immediately for any dead PID, regardless of file age', () => {
    const lockPath = join(dir, '.import.lock');
    const recent = new Date().toISOString();
    writeFileSync(lockPath, `999999\n${recent}\n`);
    expect(isStaleLock(lockPath)).toBe(true);
  });

  it('returns false for a live PID even if the file is old', () => {
    const lockPath = join(dir, '.import.lock');
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    writeFileSync(lockPath, `${process.pid}\n${old}\n`);
    expect(isStaleLock(lockPath)).toBe(false);
  });
});
