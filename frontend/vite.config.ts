import { defineConfig, build as viteBuild, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))

/** Bundle the Pages `_worker.js` that rewrites per-route OG / meta tags. */
function pagesMetaWorker(): Plugin {
  return {
    name: 'pages-meta-worker',
    apply: 'build',
    async writeBundle(outputOptions) {
      const outDir = outputOptions.dir ?? path.join(root, 'dist')
      await viteBuild({
        configFile: false,
        root,
        publicDir: false,
        logLevel: 'warn',
        plugins: [],
        ssr: { noExternal: true },
        build: {
          emptyOutDir: false,
          copyPublicDir: false,
          ssr: path.join(root, 'src/metaWorker.ts'),
          minify: false,
          target: 'es2022',
          outDir,
          rollupOptions: {
            output: {
              entryFileNames: '_worker.js',
              format: 'es',
              codeSplitting: false,
            },
          },
        },
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), pagesMetaWorker()],
  server: {
    port: 5173,
    // Proxy API HTTP (including /api/auth) and Agent WebSocket traffic to the
    // local Worker. When VITE_API_BASE is set, both clients connect to that
    // origin directly (credentialed fetches so the session cookie is sent).
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
      '/agents': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
