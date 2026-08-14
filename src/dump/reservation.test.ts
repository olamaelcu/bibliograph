import { describe, expect, it } from 'vitest';
import { createTestDb } from '../test-utils/db.js';
import { Reservation } from './reservation.js';

describe('Reservation', () => {
  it('acquire / isHeld / release', () => {
    const { db } = createTestDb();
    const r = new Reservation(db, 'ol-editions', 123);
    expect(r.acquire()).toBe(true);
    expect(r.isHeld()).toBe(true);
    r.release();
    expect(r.isHeld()).toBe(false);
  });

  it('second acquirer cannot steal', () => {
    const { db } = createTestDb();
    const r1 = new Reservation(db, 'ol-editions', 1);
    const r2 = new Reservation(db, 'ol-editions', 2);
    expect(r1.acquire()).toBe(true);
    expect(r2.acquire()).toBe(false);
  });
});
