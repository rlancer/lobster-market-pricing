import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // DuckDB-WASM ships its own worker + wasm assets that Vite must not try to
  // pre-bundle or interop-transform.
  optimizeDeps: {
    exclude: ['@duckdb/duckdb-wasm'],
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
  },
})
