import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// SvelteKit 3 reads its configuration here rather than from `svelte.config.js`
// (`config_file_unsupported`); `adapter` sits at the top level of the plugin
// options.
export default defineConfig({
  plugins: [sveltekit({ adapter: adapter({ out: 'build' }) })],
  server: {
    // The seeded HappyView client's `client_uri` is http://127.0.0.1:5176;
    // binding the name `localhost` would leave Vite on ::1 only.
    host: '127.0.0.1',
    port: 5176,
    strictPort: true
  }
});
