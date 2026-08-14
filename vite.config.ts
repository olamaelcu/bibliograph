import { defineConfig, loadEnv } from 'vite';
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

export default defineConfig(({ mode }) => {
	// Vite does not populate process.env from .env files, but the server reads
	// process.env directly (DID signing keys, DB path, etc.). Load every .env
	// value into process.env so `pnpm run dev` behaves like the tsx server.
	const env = loadEnv(mode, process.cwd(), '');
	Object.assign(process.env, env);

	// `vite` -> dev server: Vite owns the server, Hono app is the middleware
	return {
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
	};
});
