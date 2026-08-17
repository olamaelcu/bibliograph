import { describe, expect, it } from 'vitest';
import { createTestDb } from '../test-utils/db.js';
import { Reservation } from './reservation.js';

describe('Reservation', () => {
  it('acquire / isHeld / release', async () => {
    const { db } = await createTestDb();
    const r = new Reservation(db, 'ol-editions', 123);
    expect(await r.acquire()).toBe(true);
    expect(await r.isHeld()).toBe(true);
    await r.release();
    expect(await r.isHeld()).toBe(false);
  });

  it('second acquirer cannot steal', async () => {
    const { db } = await createTestDb();
    const r1 = new Reservation(db, 'ol-editions', 1);
    const r2 = new Reservation(db, 'ol-editions', 2);
    expect(await r1.acquire()).toBe(true);
    expect(await r2.acquire()).toBe(false);
  });
});
