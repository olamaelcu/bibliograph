import { defineConfig } from 'vite';
import devServer from '@hono/vite-dev-server';
import nodeAdapter from '@hono/vite-dev-server/node';

export default defineConfig({
  // `vite` -> dev server: Vite owns the server, Hono app is the middleware
  server: {
    port: 5176,
    strictPort: true,
  },
  plugins: [
    devServer({
      entry: 'src/vite-dev.ts',
      adapter: nodeAdapter,
    }),
  ],
});
