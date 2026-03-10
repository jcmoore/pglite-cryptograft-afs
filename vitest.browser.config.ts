import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

const isolationHeaders = {
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin',
}

export default defineConfig({
  optimizeDeps: {
    exclude: ['@tursodatabase/database-wasm'],
  },
  server: {
    headers: isolationHeaders,
  },
  preview: {
    headers: isolationHeaders,
  },
  test: {
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
    globals: true,
    include: ['test/browser/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
