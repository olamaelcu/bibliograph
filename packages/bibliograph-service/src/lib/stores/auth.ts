// Client-side session state.
//
// One generic store that answers "is anyone signed in, and who" so components do
// not have to reach through `page.data` to find out. TanStack Store is
// framework-agnostic state; `@tanstack/svelte-store` exposes it as a rune-backed
// holder (`.current`) that re-renders when the store changes.
//
// SSR note: the store starts `null` and is hydrated from layout data in an
// `$effect`, which only runs in the browser. That is deliberate —
//
//   * a module-level store is shared by every request in one Node process, so
//     writing to it during SSR could leak one visitor's identity into another
//     request's HTML;
//   * keeping the server render anonymous keeps hydration deterministic.
//
// The cost is that a signed-in visitor sees the server-rendered anonymous state
// for one frame. Server code that must be authoritative (form actions, label
// gates) reads the DID from `locals`, never from this store.

import { Store } from '@tanstack/store';
import { useSelector } from '@tanstack/svelte-store';

export interface Viewer {
  did: string;
  handle: string | null;
}

export interface AuthState {
  viewer: Viewer | null;
}

/** The single source of client-side truth about the current session. */
export const authStore = new Store<AuthState>({ viewer: null });

/**
 * Replace the current viewer. No-ops when nothing changed, so hydrating on every
 * navigation does not wake up subscribers.
 */
export function setViewer(viewer: Viewer | null): void {
  authStore.setState((prev) => {
    if (prev.viewer === viewer) return prev;
    if (prev.viewer?.did === viewer?.did && prev.viewer?.handle === viewer?.handle) return prev;
    return { viewer };
  });
}

export function clearViewer(): void {
  setViewer(null);
}

/**
 * Reactive selection helpers. Call these during component initialisation (they
 * allocate rune state), then read `.current` in markup.
 *
 *   const isLoggedIn = useIsLoggedIn();
 *   {#if isLoggedIn.current} … {/if}
 */
export function useViewer() {
  return useSelector(authStore, (state) => state.viewer);
}

export function useIsLoggedIn() {
  return useSelector(authStore, (state) => state.viewer !== null);
}

/** The signed-in DID, or null. Convenience for guards in markup. */
export function useViewerDid() {
  return useSelector(authStore, (state) => state.viewer?.did ?? null);
}
