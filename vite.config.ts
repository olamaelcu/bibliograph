import { defineConfig } from 'vite';
import devServer from '@hono/vite-dev-server';
import nodeAdapter from '@hono/vite-dev-server/node';

export default defineConfig(({ mode }) => {
  // `vite build --mode client` -> build the client bundle only
  if (mode === 'client') {
    return {
      build: {
        outDir: 'static',
        emptyOutDir: true,
        copyPublicDir: false,
        manifest: true,
        rolldownOptions: {
          input: './src/client/main.ts',
          output: {
            entryFileNames: 'assets/client-[hash].js',
            chunkFileNames: 'assets/[name]-[hash].js',
            assetFileNames: 'assets/[name]-[hash].[ext]',
          },
        },
      },
    };
  }

  // `vite` -> dev server: Vite owns the server, Hono app is the middleware
  return {
    plugins: [
      devServer({
        entry: 'src/vite-dev.ts',
        adapter: nodeAdapter,
      }),
    ],
  };
});
