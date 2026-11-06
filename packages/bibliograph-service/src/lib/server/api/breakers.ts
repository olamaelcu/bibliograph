import { CircuitBreaker } from './breaker';

export const openLibraryBreaker = new CircuitBreaker('openlibrary', 5, 60_000);
export const googleBooksBreaker = new CircuitBreaker('googlebooks', 5, 60_000);
export const wikipediaBreaker = new CircuitBreaker('wikipedia', 5, 60_000);
export const isbndbBreaker = new CircuitBreaker('isbndb', 5, 60_000);
export const wikidataBreaker = new CircuitBreaker('wikidata', 5, 60_000);
export const commonsBreaker = new CircuitBreaker('commons', 5, 60_000);