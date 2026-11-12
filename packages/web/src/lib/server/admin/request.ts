import { error } from '@sveltejs/kit';

/**
 * Read a JSON object body for an admin API route.
 *
 * Every admin POST is a JSON object; a parse failure or a non-object body is a
 * 400 rather than a 500, so the browser sees a message it can display.
 */
export async function readAdminBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    error(400, 'request body must be JSON');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    error(400, 'request body must be an object');
  }
  return body as Record<string, unknown>;
}
