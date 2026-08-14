import type { Context } from 'hono'
import { logger } from './logger.js'

const PLACEHOLDER_KEY_MULTIBASE = 'z6MkplaceholderDidWebOnlyKeyNotFunctional'

let warnedMissingKey = false

export function getServiceDid(): string {
  return process.env.ATP_SERVICE_DID || `did:web:${process.env.ATP_SERVICE_HOST || 'localhost'}`
}

export function buildDidDocument(host: string, proto: string) {
  const did = `did:web:${host}`
  const publicKeyMultibase = process.env.ATP_SERVICE_KEY_MULTIBASE
  if (!publicKeyMultibase && !warnedMissingKey) {
    warnedMissingKey = true
    logger.warn(
      'ATP_SERVICE_KEY_MULTIBASE is not set; the DID document serves a placeholder publicKeyMultibase and is not functional. Set ATP_SERVICE_KEY_MULTIBASE.'
    )
  }
  return {
    '@context': 'https://www.w3.org/ns/did/v1',
    id: did,
    alsoKnownAs: [`at://${host}`],
    verificationMethod: [
      {
        id: `${did}#atproto`,
        type: 'Multikey',
        controller: did,
        publicKeyMultibase: publicKeyMultibase || PLACEHOLDER_KEY_MULTIBASE,
      },
    ],
    service: [
      {
        id: '#atproto_pds',
        type: 'AtprotoPersonalDataServer',
        serviceEndpoint: `${proto}://${host}/xrpc`,
      },
    ],
  }
}

export function didDocumentHandler(ctx: Context) {
  const host = ctx.req.header('host') || new URL(ctx.req.url).host
  const forwardedProto = ctx.req.header('x-forwarded-proto')
  const proto = forwardedProto || (host.startsWith('localhost') ? 'http' : 'https')
  return ctx.json(buildDidDocument(host, proto))
}
