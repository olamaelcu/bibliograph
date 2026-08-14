import { defineConfig } from 'vite';
import devServer from '@hono/vite-dev-server';
import nodeAdapter from '@hono/vite-dev-server/node';

// @hono/vite-dev-server lets requests matching `exclude` fall through to Vite's
// own static middleware instead of the Hono app. The defaults already exclude
// `.*\.css$` / `.*\.js$` / `.*\.mjs$`, which would swallow the Web Awesome
// assets served by Hono under `/webawesome/*` and 404 them. Re-declare the
// defaults with those three rules scoped to skip `/webawesome/` paths.
const exclude = [
  /^(?!\/webawesome\/).*\.css$/,
  /.*\.ts$/,
  /.*\.tsx$/,
  /.*\.mdx?$/,
  /^\/@.+$/,
  /\?t\=\d+$/,
  /^\/favicon\.ico$/,
  /^\/static\/.+/,
  /^\/node_modules\/.*/,
  /^\/\.vite\/.*/,
  /.*\.svelte$/,
  /.*\.vue$/,
  /^(?!\/webawesome\/).*\.js$/,
  /.*\.jsx$/,
  /^(?!\/webawesome\/).*\.mjs$/,
];

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
      exclude,
    }),
  ],
});
