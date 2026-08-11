import { describe, it, expect } from 'vitest';
import { createBookhiveResolver } from './resolver.js';

describe('BookhiveResolver', () => {
  it('uses BOOKHIVE_CATALOG_DID env override and skips DNS', async () => {
    let dnsCalls = 0;
    const resolver = createBookhiveResolver({
      dnsTxtLookup: async () => {
        dnsCalls++;
        return ['did:plc:dns-was-called'];
      },
      fetchDidDoc: async () => ({ pds: 'https://never-called.example' }),
    });
    process.env.BOOKHIVE_CATALOG_DID = 'did:plc:env-override';
    process.env.BOOKHIVE_PDS_URL = 'https://env-override.example';

    const out = await resolver.resolveCatalog();
    expect(out).toEqual({
      catalogDid: 'did:plc:env-override',
      pdsUrl: 'https://env-override.example',
    });
    expect(dnsCalls).toBe(0);
    delete process.env.BOOKHIVE_CATALOG_DID;
    delete process.env.BOOKHIVE_PDS_URL;
  });

  it('falls back to DNS TXT lookup when no env override is set', async () => {
    delete process.env.BOOKHIVE_CATALOG_DID;
    delete process.env.BOOKHIVE_PDS_URL;
    const resolver = createBookhiveResolver({
      dnsTxtLookup: async (name) => {
        expect(name).toBe('_lexicon.bookhive.buzz');
        return ['did=did:plc:from-dns'];
      },
      fetchDidDoc: async (did) => {
        expect(did).toBe('did:plc:from-dns');
        return { pds: 'https://from-dns.example' };
      },
    });

    const out = await resolver.resolveCatalog();
    expect(out).toEqual({
      catalogDid: 'did:plc:from-dns',
      pdsUrl: 'https://from-dns.example',
    });
  });

  it('falls back to BOOKHIVE_PDS_URL env when no fetchDidDoc is needed (DID-only env override)', async () => {
    process.env.BOOKHIVE_CATALOG_DID = 'did:plc:env-did';
    process.env.BOOKHIVE_PDS_URL = 'https://env-pds.example';
    delete process.env.BOOKHIVE_USE_FIXED_DID;
    let fetchCalls = 0;
    const resolver = createBookhiveResolver({
      fetchDidDoc: async () => {
        fetchCalls++;
        return { pds: 'https://never-called.example' };
      },
    });

    const out = await resolver.resolveCatalog();
    expect(out.pdsUrl).toBe('https://env-pds.example');
    expect(fetchCalls).toBe(0);
    delete process.env.BOOKHIVE_CATALOG_DID;
    delete process.env.BOOKHIVE_PDS_URL;
  });

  it('surfaces a clear error when DNS lookup fails', async () => {
    delete process.env.BOOKHIVE_CATALOG_DID;
    delete process.env.BOOKHIVE_PDS_URL;
    const resolver = createBookhiveResolver({
      dnsTxtLookup: async () => {
        throw new Error('ENOTFOUND');
      },
      fetchDidDoc: async () => ({ pds: 'https://never-called.example' }),
    });

    await expect(resolver.resolveCatalog()).rejects.toThrow(/bookhive.*DNS|did not resolve/i);
  });

  it('caches resolved values until the TTL expires', async () => {
    delete process.env.BOOKHIVE_CATALOG_DID;
    delete process.env.BOOKHIVE_PDS_URL;
    let dnsCalls = 0;
    let didCalls = 0;
    const resolver = createBookhiveResolver(
      {
        dnsTxtLookup: async () => {
          dnsCalls++;
          return ['did:plc:cache-test'];
        },
        fetchDidDoc: async () => {
          didCalls++;
          return { pds: 'https://cache.example' };
        },
      },
      { cacheTtlMs: 60_000 },
    );

    await resolver.resolveCatalog();
    await resolver.resolveCatalog();
    await resolver.resolveCatalog();
    expect(dnsCalls).toBe(1);
    expect(didCalls).toBe(1);
  });

  it('resolvePds resolves an arbitrary did:plc user to its PDS', async () => {
    const resolver = createBookhiveResolver({
      fetchDidDoc: async (did) => {
        expect(did).toBe('did:plc:reader123');
        return { pds: 'https://reader.pds.example' };
      },
    });
    const pds = await resolver.resolvePds('did:plc:reader123');
    expect(pds).toBe('https://reader.pds.example');
  });

  it('resolvePds resolves did:web users via well-known document', async () => {
    const resolver = createBookhiveResolver({
      fetchDidDoc: async (did) => {
        expect(did).toBe('did:web:reader.example');
        return { pds: 'https://reader.example/pds' };
      },
    });
    const pds = await resolver.resolvePds('did:web:reader.example');
    expect(pds).toBe('https://reader.example/pds');
  });

  it('resolvePds caches per-DID results', async () => {
    let calls = 0;
    const resolver = createBookhiveResolver(
      {
        fetchDidDoc: async () => {
          calls++;
          return { pds: 'https://reader.pds.example' };
        },
      },
      { cacheTtlMs: 60_000 },
    );
    await resolver.resolvePds('did:plc:reader123');
    await resolver.resolvePds('did:plc:reader123');
    await resolver.resolvePds('did:plc:reader123');
    expect(calls).toBe(1);
  });
});
