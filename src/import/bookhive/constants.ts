export const BOOKHIVE_CATALOG_NSID = 'buzz.bookhive.catalogBook';

/** Default PDS for @bookhive.buzz; override via BOOKHIVE_PDS_URL. */
export function bookhivePdsUrl(): string {
  return process.env.BOOKHIVE_PDS_URL ?? 'https://bluesky.nickthesick.com';
}

/** The catalog DID; override via BOOKHIVE_CATALOG_DID. */
export function bookhiveCatalogDid(): string {
  return process.env.BOOKHIVE_CATALOG_DID ?? 'did:plc:enu2j5xjlqsjaylv3du4myh4';
}
