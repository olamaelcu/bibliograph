import test from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker } from './breaker';

test('breaker starts closed and allows calls', () => {
  const b = new CircuitBreaker('test', 3, 1000);
  assert.equal(b.getState(), 'closed');
  assert.equal(b.canCall(), true);
});

test('breaker opens after threshold consecutive failures', () => {
  const b = new CircuitBreaker('test', 3, 1000);
  b.recordFailure();
  b.recordFailure();
  assert.equal(b.getState(), 'closed');
  b.recordFailure();
  assert.equal(b.getState(), 'open');
  assert.equal(b.canCall(), false);
});

test('breaker closes after a success', () => {
  const b = new CircuitBreaker('test', 3, 1000);
  b.recordFailure();
  b.recordFailure();
  b.recordFailure();
  assert.equal(b.getState(), 'open');
  b.recordSuccess();
  assert.equal(b.getState(), 'closed');
  assert.equal(b.canCall(), true);
  assert.equal(b.getName(), 'test');
});

test('breaker transitions to half-open after openMs', () => {
  let now = 0;
  const b = new CircuitBreaker('test', 2, 100, () => now);
  b.recordFailure();
  b.recordFailure();
  assert.equal(b.getState(), 'open');
  now = 50;
  assert.equal(b.getState(), 'open');
  assert.equal(b.canCall(), false);
  now = 200;
  assert.equal(b.getState(), 'half-open');
  assert.equal(b.canCall(), true);
});

test('breaker with high threshold never opens on isolated failures', () => {
  const b = new CircuitBreaker('test', 100, 1000);
  for (let i = 0; i < 50; i++) b.recordFailure();
  assert.equal(b.getState(), 'closed');
  assert.equal(b.canCall(), true);
});