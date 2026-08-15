// Node 22+ exposes a global `WebSocket` (undici) at runtime, but this
// project's @types/node does not yet ship ambient types for it. Minimal
// surface covering what `src/jetstream/ingest.ts` actually uses.
declare class WebSocket {
	constructor(url: string | URL);
	readonly readyState: number;
	close(code?: number, reason?: string): void;
	addEventListener(type: 'open', listener: () => void): void;
	addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
	addEventListener(type: 'close', listener: (event: { code: number; reason: string }) => void): void;
	addEventListener(type: 'error', listener: (event: unknown) => void): void;
}
