import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

const isolationHeaders = {
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin',
}

export default defineConfig({
  server: {
    headers: isolationHeaders,
  },
  preview: {
    headers: isolationHeaders,
  },
  test: {
    benchmark: {
      include: ['bench/browser/**/*.bench.ts'],
    },
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
    },
    globals: true,
    testTimeout: 120000,
    hookTimeout: 60000,
  },
})
