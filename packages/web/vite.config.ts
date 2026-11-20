import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// SvelteKit's `version.name` defaults to the build time (`Date.now()`), which
// lands in `build/client/_app/version.json` and in every chunk that inlines it.
// The deploy compares package payloads by md5sums to skip reinstalling an
// unchanged package, and a per-build stamp made the web package always differ.
// The commit is stable for a given tree and still changes when the code does.
function buildVersion() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'dev';
  }
}

// SvelteKit 3 reads its configuration here rather than from `svelte.config.js`
// (`config_file_unsupported`); `adapter` sits at the top level of the plugin
// options.
export default defineConfig(({ command }) => ({
  plugins: [sveltekit({ adapter: adapter({ out: 'build' }), version: { name: buildVersion() } })],
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
        // `@atproto/oauth-client-node` and its `@atproto/oauth-types` companion
        // are the same shape — CommonJS bundles that reference `exports` — and
        // only the librarian sign-in imports them, so they failed the same way
        // the first time that action ran.
        external:
          command === 'build'
            ? []
            : ['pg', '@atproto/oauth-client-node', '@atproto/oauth-types']
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
    // The seeded HappyView client's `client_uri` is http://127.0.0.1:5176 and
    // stays that way, because a loopback client has to be the loopback host's.
    // The name the compose Caddy proxies to (`biblio.172-17-0-1.sslip.io`) comes
    // in through `host.docker.internal`, which arrives on this machine's own
    // address rather than on loopback — so the server listens on every
    // interface and accepts the `.sslip.io` names those requests carry.
    host: '0.0.0.0',
    allowedHosts: ['.sslip.io'],
    port: 5176,
    strictPort: true
  }
}));
