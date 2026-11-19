import { expect, test } from 'vitest';

import {
  buildServiceDidDocument,
  didWeb,
  INTERACTION_FRAGMENT,
  LABELER_FRAGMENT,
  LABEL_FRAGMENT,
  SERVICE_DID_HOSTNAME,
  SPACE_MANAGER_FRAGMENT
} from '../src/lib/server/service-did.ts';

/**
 * The document served at `/.well-known/did.json`.
 *
 * These pin the identity the Livtet platform signs against: the id a consumer
 * derives from the hostname, the fragment its assertion audience names, the
 * absence of a key until one is configured (a half-configured host must not
 * publish an empty Multikey), and the omission of `alsoKnownAs`.
 */

test('default host builds the biblio identity with no verification method', () => {
  const document = buildServiceDidDocument({
    hostname: SERVICE_DID_HOSTNAME,
    interactionKeyMultibase: null,
    spaceManagerEndpoint: 'https://livtet.olamaelcu.net'
  });

  expect(document.id).toBe('did:web:biblio.livtet.olamaelcu.net');
  expect(document.verificationMethod).toEqual([]);
  expect(document.service).toEqual([
    {
      id: `#${SPACE_MANAGER_FRAGMENT}`,
      type: 'AtprotoSpaceManager',
      serviceEndpoint: 'https://livtet.olamaelcu.net'
    },
    {
      id: `#${LABELER_FRAGMENT}`,
      type: 'AtprotoLabeler',
      serviceEndpoint: `https://${SERVICE_DID_HOSTNAME}`
    }
  ]);
});

test('a configured key is published as #oauth_interaction', () => {
  const document = buildServiceDidDocument({
    hostname: SERVICE_DID_HOSTNAME,
    interactionKeyMultibase: 'zQ3shTest',
    spaceManagerEndpoint: 'https://livtet.olamaelcu.net'
  });

  expect(document.verificationMethod.length).toBe(1);
  const [method] = document.verificationMethod;
  expect(method.id).toBe(`#${INTERACTION_FRAGMENT}`);
  expect(method.type).toBe('Multikey');
  expect(method.controller).toBe(document.id);
  expect(method.publicKeyMultibase).toBe('zQ3shTest');
});

test('the document claims no handle', () => {
  const document = buildServiceDidDocument({
    hostname: SERVICE_DID_HOSTNAME,
    interactionKeyMultibase: 'zQ3shTest',
    spaceManagerEndpoint: 'https://livtet.olamaelcu.net'
  });

  expect(Object.hasOwn(document, 'alsoKnownAs')).toBe(false);
});

test('a port is percent-encoded in the identifier', () => {
  expect(didWeb('127.0.0.1:5176')).toBe('did:web:127.0.0.1%3A5176');
});

test('a configured labeler key is published as #atproto_label', () => {
  const document = buildServiceDidDocument({
    hostname: SERVICE_DID_HOSTNAME,
    interactionKeyMultibase: null,
    spaceManagerEndpoint: 'https://livtet.olamaelcu.net',
    labelerKeyMultibase: 'zQ3shLabeler',
    labelerEndpoint: 'https://biblio.livtet.olamaelcu.net'
  });

  expect(document.verificationMethod).toEqual([
    {
      id: `#${LABEL_FRAGMENT}`,
      type: 'Multikey',
      controller: document.id,
      publicKeyMultibase: 'zQ3shLabeler'
    }
  ]);
  const labeler = document.service.find((entry) => entry.id === `#${LABELER_FRAGMENT}`);
  expect(labeler?.serviceEndpoint).toBe('https://biblio.livtet.olamaelcu.net');
});

test('the labeler service is published even without its key', () => {
  const document = buildServiceDidDocument({
    hostname: SERVICE_DID_HOSTNAME,
    interactionKeyMultibase: null,
    spaceManagerEndpoint: 'https://livtet.olamaelcu.net'
  });

  // A consumer reads the service entry first; the absent verification method is
  // how it learns the labels cannot be verified yet.
  expect(document.service.some((entry) => entry.type === 'AtprotoLabeler')).toBe(true);
});
