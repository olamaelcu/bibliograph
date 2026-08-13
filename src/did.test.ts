import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDidDocument } from './did.js';
import { createApp } from './app.js';
import { logger } from './logger.js';

const ORIGINAL_KEY = process.env.ATP_SERVICE_KEY_MULTIBASE;

afterEach(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.ATP_SERVICE_KEY_MULTIBASE;
  } else {
    process.env.ATP_SERVICE_KEY_MULTIBASE = ORIGINAL_KEY;
  }
  vi.restoreAllMocks();
});

describe('buildDidDocument', () => {
  it('uses the configured multibase key when set', () => {
    process.env.ATP_SERVICE_KEY_MULTIBASE = 'zQ3shTestKeyMultibaseValue123';
    const doc = buildDidDocument('biblio.example.com', 'https');
    expect(doc.verificationMethod[0].publicKeyMultibase).toBe('zQ3shTestKeyMultibaseValue123');
  });

  it('warns once when the key is missing', () => {
    delete process.env.ATP_SERVICE_KEY_MULTIBASE;
    const warnSpy = vi.spyOn(logger, 'warn');
    buildDidDocument('localhost', 'http');
    buildDidDocument('localhost', 'http');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to a placeholder when the key is unset', () => {
    delete process.env.ATP_SERVICE_KEY_MULTIBASE;
    const doc = buildDidDocument('localhost', 'http');
    expect(doc.verificationMethod[0].publicKeyMultibase).toBe('z6MkplaceholderDidWebOnlyKeyNotFunctional');
  });

  it('builds a did:web identifier from the host', () => {
    process.env.ATP_SERVICE_KEY_MULTIBASE = 'zQ3shTestKeyMultibaseValue123';
    const doc = buildDidDocument('biblio.example.com', 'https');
    expect(doc.id).toBe('did:web:biblio.example.com');
    expect(doc.alsoKnownAs).toEqual(['at://biblio.example.com']);
  });

  it('exposes the PDS service endpoint under /xrpc', () => {
    process.env.ATP_SERVICE_KEY_MULTIBASE = 'zQ3shTestKeyMultibaseValue123';
    const doc = buildDidDocument('biblio.example.com', 'https');
    expect(doc.service[0].type).toBe('AtprotoPersonalDataServer');
    expect(doc.service[0].serviceEndpoint).toBe('https://biblio.example.com/xrpc');
  });
});

describe('did document endpoint', () => {
  it('serves the DID document at /.well-known/did.json', async () => {
    process.env.ATP_SERVICE_KEY_MULTIBASE = 'zQ3shTestKeyMultibaseValue123';
    const app = createApp();
    const res = await app.request('/.well-known/did.json', {
      headers: { host: 'biblio.example.com', 'x-forwarded-proto': 'https' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe('did:web:biblio.example.com');
    expect(body.service[0].serviceEndpoint).toBe('https://biblio.example.com/xrpc');
  });
});
