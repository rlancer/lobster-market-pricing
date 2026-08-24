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
  // Vite 8 defaults cssMinify to lightningcss, which drops unprefixed
  // `backdrop-filter` when a `-webkit-` twin is present (lightningcss#785 /
  // vite#22649). Chromium then computes `backdrop-filter: none` and every
  // frosted surface (mobile bottom nav, composers) loses its blur.
  build: {
    cssMinify: 'esbuild',
  },
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
