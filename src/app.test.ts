import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';

const app = createApp();

const LEXICON_NSIDS = [
  'book',
  'bookContributor',
  'contributor',
  'contributorRole',
  'defs',
  'format',
  'genre',
  'review',
  'shelf',
  'work',
];

describe('health', () => {
  it('returns ok with version', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', version: '0.0.1' });
  });
});

describe('static lexicon serving', () => {
  for (const nsid of LEXICON_NSIDS) {
    it(`serves ${nsid}.json`, async () => {
      const res = await app.request(`/lexicons/net/olamaelcu/livtet/biblio/${nsid}.json`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      const body = await res.json();
      expect(body.id).toBe(`net.olamaelcu.livtet.biblio.${nsid}`);
    });
  }

  it('returns 404 for an unknown lexicon', async () => {
    const res = await app.request('/lexicons/net/olamaelcu/livtet/biblio/nope.json');
    expect(res.status).toBe(404);
  });

  it('returns 404 for a path traversal attempt', async () => {
    const res = await app.request('/lexicons/../../package.json');
    expect(res.status).toBe(404);
  });
});

describe('cors', () => {
  it('adds access-control-allow-origin', async () => {
    const res = await app.request('/health');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
