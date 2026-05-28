import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../dist/review-app',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        // When the companion Node server isn't running (e.g. `npm run dev`
        // standalone, or a reframe audit booting just the Vite shell), the
        // default proxy reply is a noisy 500. Convert it to a clean 503 +
        // `{offline:true}` JSON so the React app's offline-mock path takes
        // over without scaring the console.
        configure: (proxy) => {
          proxy.on('error', (_err, _req, res) => {
            try {
              if (res && !res.headersSent) {
                res.writeHead(503, { 'Content-Type': 'application/json' });
              }
              if (res && !res.writableEnded) {
                res.end(JSON.stringify({ offline: true }));
              }
            } catch {
              /* socket already closed — nothing to do */
            }
          });
        },
      },
    },
  },
});
