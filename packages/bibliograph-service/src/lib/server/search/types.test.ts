import test from 'node:test';
import assert from 'node:assert/strict';
import type { Logger } from 'pino';
import type { SearchSource, Enricher, Ingestor, SearchQuery, SearchResult, EditionItem, WorkItem, ContributorItem } from './types.ts';

test('SearchSource interface shape', (_t) => {
  const fn = (_q: SearchQuery, _l: Logger, _s?: AbortSignal): Promise<SearchResult<EditionItem>> => {
    throw new Error('not implemented in test');
  };
  const _src: SearchSource<EditionItem> = { name: 'x', search: fn };
  assert.ok(_src);
});

test('Enricher interface shape', (_t) => {
  const fn = (_items: WorkItem[], _l: Logger, _s?: AbortSignal): Promise<WorkItem[]> => {
    throw new Error('not implemented in test');
  };
  const _e: Enricher<WorkItem> = { name: 'y', enrich: fn };
  assert.ok(_e);
});

test('Ingestor interface shape', (_t) => {
  const fn = (_items: ContributorItem[]): Promise<void> => Promise.resolve();
  const _i: Ingestor<ContributorItem> = { name: 'z', ingest: fn };
  assert.ok(_i);
});

test('EditionItem fields exist on type', () => {
  const item: EditionItem = {
    title: 't',
    identifiers: [],
    contributors: [],
    createdAt: new Date().toISOString(),
  };
  assert.equal(item.title, 't');
});
