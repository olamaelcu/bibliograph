import { describe, it, expect } from 'vitest';
import { HttpError } from './errors.js';

describe('HttpError', () => {
  it('is an instance of Error', () => {
    const err = new HttpError(404, 'NotFound', 'Resource not found');
    expect(err).toBeInstanceOf(Error);
  });

  it('has name "HttpError"', () => {
    const err = new HttpError(400, 'BadRequest', 'Invalid input');
    expect(err.name).toBe('HttpError');
  });

  it('sets the status property', () => {
    const err = new HttpError(401, 'AuthenticationRequired', 'Not logged in');
    expect(err.status).toBe(401);
  });

  it('sets the error property', () => {
    const err = new HttpError(500, 'InternalServerError', 'Something broke');
    expect(err.error).toBe('InternalServerError');
  });

  it('sets the message property', () => {
    const err = new HttpError(403, 'Forbidden', 'Access denied');
    expect(err.message).toBe('Access denied');
  });

  it('captures stack trace', () => {
    const err = new HttpError(418, "ImATeapot", "Short and stout");
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain('HttpError');
  });

  it('works with numeric status codes', () => {
    const err = new HttpError(200, 'OK', 'All good');
    expect(err.status).toBe(200);
  });

  it('works with minimal message', () => {
    const err = new HttpError(404, 'NotFound', '');
    expect(err.message).toBe('');
  });
});
