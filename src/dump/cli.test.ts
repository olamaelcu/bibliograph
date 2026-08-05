import { describe, it, expect } from 'vitest';
import { OL_DUMP_BATCH_SIZE_DEFAULT_FOR_TESTS as resolver, parseArgs } from './cli.js';

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
});
