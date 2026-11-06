import test from 'node:test';
import assert from 'node:assert/strict';
import { shelfViewFromValue } from './shelf-view';

const USER = 'did:plc:reader';
const CUSTOM_SHELF = `at://${USER}/net.olamaelcu.livtet.biblio.shelf/3lxyzcustom`;
const STATUS_SHELF = `at://${USER}/net.olamaelcu.livtet.biblio.shelf/to-read`;

test('shelfViewFromValue: publishes name, description and both timestamps', () => {
  const view = shelfViewFromValue(CUSTOM_SHELF, {
    name: 'Slow Burn Romance',
    description: 'Books where the tension carries the plot.',
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-02T11:30:00.000Z',
  });
  assert.equal(view.uri, CUSTOM_SHELF);
  assert.equal(view.name, 'Slow Burn Romance');
  assert.equal(view.description, 'Books where the tension carries the plot.');
  assert.equal(view.createdAt, '2026-11-01T10:00:00.000Z');
  assert.equal(view.updatedAt, '2026-11-02T11:30:00.000Z');
  assert.equal(view.$type, 'net.olamaelcu.livtet.biblio.defs#shelfView');
});

test('shelfViewFromValue: a status shelf with no description omits the field', () => {
  const view = shelfViewFromValue(STATUS_SHELF, { name: 'To Read' });
  // Absent, not blank: over the wire an undefined field is dropped, so a client
  // renders no description rather than an empty paragraph.
  assert.equal(view.description, undefined);
  assert.equal(view.createdAt, undefined);
  assert.equal(view.updatedAt, undefined);
  assert.equal('description' in JSON.parse(JSON.stringify(view)), false);
});

test('shelfViewFromValue: falls back to the fixed display name when the record carries none', () => {
  assert.equal(shelfViewFromValue(STATUS_SHELF, {}).name, 'To Read');
  assert.equal(shelfViewFromValue(STATUS_SHELF, null).name, 'To Read');
});

test('shelfViewFromValue: a custom shelf with no record has no name to show', () => {
  assert.equal(shelfViewFromValue(CUSTOM_SHELF, undefined).name, '');
});

test('shelfViewFromValue: an empty description is treated as no description', () => {
  const view = shelfViewFromValue(CUSTOM_SHELF, { name: 'Favourites', description: '' });
  assert.equal(view.description, undefined);
});

test('shelfViewFromValue: a non-string description is dropped, not forwarded', () => {
  const view = shelfViewFromValue(CUSTOM_SHELF, { name: 'Favourites', description: 42 });
  assert.equal(view.description, undefined);
});
