import { describe, it, expect, afterEach } from 'vitest';
import { getServiceDid, buildDidDocument } from './did.js';

describe('getServiceDid', () => {
  afterEach(() => {
    delete process.env.ATP_SERVICE_DID;
  });

  it('returns ATP_SERVICE_DID when set', () => {
    process.env.ATP_SERVICE_DID = 'did:web:biblio.livtet.olamaelcu.net';
    expect(getServiceDid()).toBe('did:web:biblio.livtet.olamaelcu.net');
  });

  it('falls back to did:web:localhost when unset', () => {
    delete process.env.ATP_SERVICE_DID;
    expect(getServiceDid()).toBe('did:web:localhost');
  });
});

describe('buildDidDocument', () => {
  it('returns a document id and atproto_labeler service', () => {
    const doc = buildDidDocument(
      'did:web:biblio.livtet.olamaelcu.net',
      'https://biblio.livtet.olamaelcu.net',
    );

    expect(doc).toEqual({
      id: 'did:web:biblio.livtet.olamaelcu.net',
      service: [
        {
          id: '#atproto_labeler',
          type: 'AtprotoLabeler',
          serviceEndpoint: 'https://biblio.livtet.olamaelcu.net',
        },
      ],
    });
  });
});
