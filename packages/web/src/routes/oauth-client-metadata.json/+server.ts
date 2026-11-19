/**
 * The librarian client's OAuth metadata document.
 *
 * Served per request from the request's own origin: `client_id` must equal the
 * URL an authorization server fetched the document from, and the same code runs
 * on the dev server and the production edge. The OAuth client builds its
 * metadata from `librarianClientMetadata`, and this route serves that function's
 * output, so the two cannot drift.
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

import { librarianClientMetadata } from '$lib/server/librarian/oauth';

export const GET: RequestHandler = ({ url }) =>
  json(librarianClientMetadata(url.origin), {
    // The document is origin-specific and can change with a deploy.
    headers: { 'cache-control': 'no-cache' }
  });
