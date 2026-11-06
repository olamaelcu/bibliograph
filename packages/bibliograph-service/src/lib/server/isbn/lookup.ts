import { isbnValueFromIdentifier, type Identifier } from '../identifiers';

/**
 * The ISBN an identifier list carries, in its canonical wire form: hyphenless
 * ISBN-13, or undefined when the list holds no ISBN.
 */
export function isbnFromIdentifiers(identifiers: readonly Identifier[]): string | undefined {
  for (const identifier of identifiers) {
    const isbn = isbnValueFromIdentifier(identifier);
    if (isbn) return isbn;
  }
  return undefined;
}
