import { describe, expect, it } from 'vitest';
import { landingPageHtml } from './landing.js';
import { lexiconEndpoints, procedureCount, queryCount } from '../lexicon-catalog.js';

describe('lexicon catalog', () => {
  it('extracts every query and procedure lexicon', () => {
    expect(lexiconEndpoints.length).toBeGreaterThanOrEqual(12);
    expect(queryCount).toBeGreaterThan(0);
    for (const endpoint of lexiconEndpoints) {
      expect(endpoint.type === 'query' || endpoint.type === 'procedure').toBe(true);
      expect(endpoint.id).toMatch(/^net\.olamaelcu\.livtet\.biblio\./);
    }
  });

  it('catalogs the biblio write procedures', () => {
    const writeIds = lexiconEndpoints
      .filter((e) => /^(put|delete)/.test(e.name))
      .map((e) => e.id)
      .sort();
    expect(writeIds).toEqual([
      'net.olamaelcu.livtet.biblio.deleteActor',
      'net.olamaelcu.livtet.biblio.deleteBookShelving',
      'net.olamaelcu.livtet.biblio.deleteReview',
      'net.olamaelcu.livtet.biblio.deleteShelf',
      'net.olamaelcu.livtet.biblio.putActor',
      'net.olamaelcu.livtet.biblio.putBookShelving',
      'net.olamaelcu.livtet.biblio.putReview',
      'net.olamaelcu.livtet.biblio.putShelf',
    ]);
    expect(procedureCount).toBeGreaterThanOrEqual(8);
    for (const endpoint of lexiconEndpoints) {
      expect(endpoint.lexiconPath).toBeDefined();
    }
  });

  it('documents parameters and output of searchBooks', () => {
    const search = lexiconEndpoints.find((e) => e.name === 'searchBooks');
    expect(search).toBeDefined();
    expect(search?.params.some((p) => p.name === 'q' && p.required)).toBe(true);
    expect(search?.output?.properties.some((p) => p.name === 'books')).toBe(true);
  });

  it('marks params required/optional and includes descriptions', () => {
    const getBook = lexiconEndpoints.find((e) => e.name === 'getBook');
    expect(getBook?.params).toEqual([
      expect.objectContaining({ name: 'uri', type: 'string', required: true }),
    ]);
    expect(getBook?.description).toMatch(/hydrated view/);
  });
});

describe('landing page SSR', () => {
  it('renders a full document with declarative shadow DOM', () => {
    expect(landingPageHtml).toContain('<!doctype html>');
    expect(landingPageHtml).toContain('did-ssr');
    expect(landingPageHtml).toContain('shadowrootmode');
  });

  it('lists every endpoint NSID', () => {
    for (const endpoint of lexiconEndpoints) {
      expect(landingPageHtml).toContain(endpoint.id);
    }
  });

  it('includes the ssr loader and theme stylesheet', () => {
    expect(landingPageHtml).toContain('/webawesome/dist-cdn/webawesome.ssr-loader.js');
    expect(landingPageHtml).toContain('/webawesome/dist-cdn/styles/webawesome.css');
  });
});
