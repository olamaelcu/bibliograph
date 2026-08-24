import test from 'node:test';
import assert from 'node:assert/strict';
import { allowRequest, resetRateLimits } from './rate-limit.ts';

test('allowRequest allows up to capacity then rejects', () => {
  resetRateLimits();
  // First 60 requests succeed (capacity = 60 rpm)
  for (let i = 0; i < 60; i++) {
    assert.equal(allowRequest('1.1.1.1', 'community.lexicon.book.searchEditions'), true, `req ${i + 1} should pass`);
  }
  // 61st rejects
  assert.equal(allowRequest('1.1.1.1', 'community.lexicon.book.searchEditions'), false);
});

test('allowRequest is per-(ip, nsid)', () => {
  resetRateLimits();
  // IP A exhausts its budget
  for (let i = 0; i < 60; i++) allowRequest('2.2.2.2', 'community.lexicon.book.searchEditions');
  assert.equal(allowRequest('2.2.2.2', 'community.lexicon.book.searchEditions'), false);
  // IP B still has tokens
  assert.equal(allowRequest('3.3.3.3', 'community.lexicon.book.searchEditions'), true);
  // Different nsid, same IP, has its own bucket
  assert.equal(allowRequest('2.2.2.2', 'community.lexicon.book.searchWorks'), true);
});

test('PDS NSIDs get the higher default RPM', () => {
  resetRateLimits();
  // com.atproto.* gets 600 rpm
  for (let i = 0; i < 600; i++) {
    assert.equal(allowRequest('4.4.4.4', 'com.atproto.repo.listRecords'), true, `req ${i + 1} should pass`);
  }
  assert.equal(allowRequest('4.4.4.4', 'com.atproto.repo.listRecords'), false);
});