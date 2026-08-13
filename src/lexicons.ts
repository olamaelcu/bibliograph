import { fileURLToPath } from 'node:url';
import { serveStatic } from '@hono/node-server/serve-static';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));

export const lexiconsStatic = serveStatic({ root: PROJECT_ROOT });
