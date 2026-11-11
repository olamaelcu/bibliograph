import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// SvelteKit 3 reads its configuration here rather than from `svelte.config.js`
// (`config_file_unsupported`); `adapter` sits at the top level of the plugin
// options.
export default defineConfig(({ command }) => ({
  plugins: [sveltekit({ adapter: adapter({ out: 'build' }) })],
  // adapter-node's output is shipped without node_modules (see
  // .mise/tasks/package-web-payload), so every server import must be bundled.
  // Vite auto-externalizes package.json `dependencies` for SSR, and an explicit
  // external entry wins over noExternal — hence `pg` and the UI libraries live
  // in devDependencies here, and the SSR environment is told to bundle them.
  environments: {
    ssr: {
      resolve: {
        noExternal: true,
        // `pg` is CommonJS, and Vite's dev module runner evaluates an inlined
        // module as ESM, where `require` does not exist — the catalog handlers
        // answered `Internal server error: require is not defined` until this
        // entry let Node load `pg` itself. The packaged build still bundles it
        // (rollup handles CJS), so this is a dev-only escape hatch.
        external: command === 'build' ? [] : ['pg']
      }
    }
  },
  resolve: {
    // `$lib` is SvelteKit's own alias, but declaring it here makes it
    // explicit for code that Vite resolves outside the plugin's reach — the
    // route handlers import `$lib/server/...` like the rest of the app.
    alias: {
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url))
    }
  },
  server: {
    // The seeded HappyView client's `client_uri` is http://127.0.0.1:5176;
    // binding the name `localhost` would leave Vite on ::1 only.
    host: '127.0.0.1',
    port: 5176,
    strictPort: true
  }
}));
