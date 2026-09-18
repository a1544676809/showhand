import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5273,
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    // Off for shipped builds: the map is ~1.3 MB (14% of the iOS bundle) and
    // the source is published under the GPL anyway, so it buys nothing.
    sourcemap: false,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
