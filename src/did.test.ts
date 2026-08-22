import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDidDocument, getServiceDid } from './did.js';
import { createApp } from './app.js';
import { logger } from './logger.js';

const ORIGINAL_KEY = process.env.ATP_SERVICE_KEY_MULTIBASE;
const ORIGINAL_HOST = process.env.ATP_SERVICE_HOST;
const ORIGINAL_ALLOW_DEV_DID = process.env.ALLOW_DEV_DID;

afterEach(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.ATP_SERVICE_KEY_MULTIBASE;
  } else {
    process.env.ATP_SERVICE_KEY_MULTIBASE = ORIGINAL_KEY;
  }
  if (ORIGINAL_HOST === undefined) {
    delete process.env.ATP_SERVICE_HOST;
  } else {
    process.env.ATP_SERVICE_HOST = ORIGINAL_HOST;
  }
  if (ORIGINAL_ALLOW_DEV_DID === undefined) {
    delete process.env.ALLOW_DEV_DID;
  } else {
    process.env.ALLOW_DEV_DID = ORIGINAL_ALLOW_DEV_DID;
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

describe('getServiceDid', () => {
  beforeEach(() => {
    delete process.env.ATP_SERVICE_HOST;
    delete process.env.ALLOW_DEV_DID;
  });

  it('returns did:web:<host> when ATP_SERVICE_HOST is set', () => {
    process.env.ATP_SERVICE_HOST = 'biblio.livtet.olamaelcu.net';
    expect(getServiceDid()).toBe('did:web:biblio.livtet.olamaelcu.net');
  });

  it('falls back to did:web:localhost when ALLOW_DEV_DID=1 and ATP_SERVICE_HOST is unset', () => {
    process.env.ALLOW_DEV_DID = '1';
    expect(getServiceDid()).toBe('did:web:localhost');
  });

  it('throws when ATP_SERVICE_HOST is unset and ALLOW_DEV_DID is not 1', () => {
    expect(() => getServiceDid()).toThrow(/ATP_SERVICE_HOST/);
    expect(() => getServiceDid()).toThrow(/ALLOW_DEV_DID/);
  });

  it('throws when ALLOW_DEV_DID is set to a non-truthy value', () => {
    process.env.ALLOW_DEV_DID = '0';
    expect(() => getServiceDid()).toThrow(/ATP_SERVICE_HOST/);
  });

  it('prefers ATP_SERVICE_HOST over ALLOW_DEV_DID when both are set', () => {
    process.env.ATP_SERVICE_HOST = 'biblio.livtet.olamaelcu.net';
    process.env.ALLOW_DEV_DID = '1';
    expect(getServiceDid()).toBe('did:web:biblio.livtet.olamaelcu.net');
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
