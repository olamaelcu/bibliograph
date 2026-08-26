import { CircuitBreaker } from './breaker';

export const openLibraryBreaker = new CircuitBreaker('openlibrary', 5, 60_000);
export const googleBooksBreaker = new CircuitBreaker('googlebooks', 5, 60_000);
export const wikipediaBreaker = new CircuitBreaker('wikipedia', 5, 60_000);
export const isbndbBreaker = new CircuitBreaker('isbndb', 5, 60_000);