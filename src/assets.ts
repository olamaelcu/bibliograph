import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type ClientAssets = { js: string; css: string[] };

let cached: ClientAssets | null = null;

export function getClientAssets(): ClientAssets {
  if (cached) return cached;

  if (process.env.NODE_ENV !== 'production') {
    // Dev: Vite serves the entry directly and injects CSS via JS
    cached = { js: '/src/client/main.ts', css: [] };
    return cached;
  }

  const manifestPath = fileURLToPath(new URL('../static/.vite/manifest.json', import.meta.url));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<
    string,
    { file: string; css?: string[] }
  >;
  const entry = manifest['src/client/main.ts'];
  cached = {
    js: `/static/${entry.file}`,
    css: (entry.css ?? []).map((f) => `/static/${f}`),
  };
  return cached;
}
