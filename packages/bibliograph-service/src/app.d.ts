import type { Viewer } from '$lib/server/auth/session';

declare global {
  namespace App {
    interface Locals {
      /** The signed-in ATProto identity, or null for anonymous requests. */
      viewer: Viewer | null;
    }
  }
}
export {};
