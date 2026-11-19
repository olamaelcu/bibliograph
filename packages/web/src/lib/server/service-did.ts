/**
 * The `did:web` document this host publishes at `/.well-known/did.json`.
 *
 * It identifies the Livtet platform, not this app: the platform signs the
 * `oauth_interaction` assertion that lets an MCP client sign in, and its space
 * manager (the service that mints club spaces and checks members' access) is
 * advertised here so a PDS resolving the managing app finds an endpoint.
 *
 * `alsoKnownAs` is deliberately omitted. The hostname is also a Livtet user
 * handle resolving to a `did:plc`, and a second claimant on a service DID is a
 * conflict. `#atproto` is omitted too: the key signs interaction assertions,
 * never repository operations.
 */

export const SERVICE_DID_HOSTNAME = 'biblio.livtet.olamaelcu.net';
export const INTERACTION_FRAGMENT = 'oauth_interaction';
export const SPACE_MANAGER_FRAGMENT = 'livtet_space_manager';
/** The labeler's signing key, and the service entry that advertises it. */
export const LABEL_FRAGMENT = 'atproto_label';
export const LABELER_FRAGMENT = 'atproto_labeler';

/** `did:web` identifier for a host; a port's colon is percent-encoded. */
export function didWeb(hostname: string): string {
  return `did:web:${hostname.replaceAll(':', '%3A')}`;
}

export interface ServiceDidEnv {
  hostname: string;
  interactionKeyMultibase: string | null;
  spaceManagerEndpoint: string;
  /** The labeler's public key, published as `#atproto_label`; unset omits it. */
  labelerKeyMultibase?: string | null;
  /** Origin the labeler answers on (`https://biblio.livtet.olamaelcu.net`). */
  labelerEndpoint?: string;
}

export function buildServiceDidDocument(env: ServiceDidEnv) {
  const id = didWeb(env.hostname);
  const key = env.interactionKeyMultibase?.trim();
  const labelerKey = env.labelerKeyMultibase?.trim();
  return {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/multikey/v1'
    ],
    id,
    verificationMethod: [
      ...(key
        ? [
            {
              id: `#${INTERACTION_FRAGMENT}`,
              type: 'Multikey',
              controller: id,
              publicKeyMultibase: key
            }
          ]
        : []),
      ...(labelerKey
        ? [
            {
              id: `#${LABEL_FRAGMENT}`,
              type: 'Multikey',
              controller: id,
              publicKeyMultibase: labelerKey
            }
          ]
        : [])
    ],
    service: [
      {
        id: `#${SPACE_MANAGER_FRAGMENT}`,
        type: 'AtprotoSpaceManager',
        serviceEndpoint: env.spaceManagerEndpoint
      },
      // Always published: the labeler is part of this host whether or not its
      // key is configured yet, and a consumer that reads the service entry and
      // finds no key learns that from the empty verificationMethod list.
      {
        id: `#${LABELER_FRAGMENT}`,
        type: 'AtprotoLabeler',
        serviceEndpoint: env.labelerEndpoint ?? `https://${SERVICE_DID_HOSTNAME}`
      }
    ]
  };
}
