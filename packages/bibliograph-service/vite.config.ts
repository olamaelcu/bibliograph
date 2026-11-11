import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// SvelteKit 3 takes its configuration here instead of `svelte.config.js`, which
// is no longer read (`config_file_unsupported`). The `kit` wrapper is gone with
// it: `adapter` and the rest sit at the top level of the plugin options.
export default defineConfig({
  plugins: [
    sveltekit({
      adapter: adapter({ out: 'build' }),
      // Kit 3 removed the implicit `$lib` module. The durable fix is subpath
      // imports (`#lib/*` in package.json `imports`); this alias keeps the ~120
      // existing specifiers working until that rename lands. Deprecated
      // (`config_option_deprecated_alias`), and it is the last use of it.
      alias: { $lib: 'src/lib' },
    }),
  ],
  server: {
    port: Number(process.env.WEB_PORT ?? 5176),
    strictPort: true,
  },
});
