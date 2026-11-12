/**
 * JSON error envelope shared by the contributor and publisher admin routes.
 *
 * `EntityEditError` carries the status the editor expects (400 validation, 404
 * unknown row, 409 stale revision or identity conflict); a missing or
 * unreachable catalog is a 503 on read and a 503 on write (the transaction was
 * rolled back), and any other failure keeps the edition editor's split: 503 for
 * a read, 500 `UpdateFailed` for a write.
 */

import { json } from '@sveltejs/kit';
import type { EntityKind } from '../../admin/entity-edit.ts';
import { CatalogUnavailableError } from '../catalog/errors.ts';
import { EntityEditError } from './entity-edit.ts';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export function entityErrorResponse(
  error: unknown,
  kind: EntityKind,
  action: 'read' | 'update'
): Response {
  if (error instanceof EntityEditError) {
    return json(
      { error: error.code, message: error.message, field: error.field },
      { status: error.status, headers: NO_STORE }
    );
  }
  if (error instanceof CatalogUnavailableError) {
    return json(
      { error: 'ServiceUnavailable', message: error.message },
      { status: 503, headers: NO_STORE }
    );
  }
  console.error(`[admin] ${kind} ${action} failed`, error);
  if (action === 'read') {
    return json(
      { error: 'ServiceUnavailable', message: 'catalog lookup failed' },
      { status: 503, headers: NO_STORE }
    );
  }
  return json(
    { error: 'UpdateFailed', message: 'the update failed and was rolled back' },
    { status: 500, headers: NO_STORE }
  );
}
