import type { PgdarqAFSBrokerOptions } from './pgdarq-afs-types.js'

export function createPgdarqAFSBrokerWorker(_options?: PgdarqAFSBrokerOptions): Worker {
  return new Worker(new URL('./pgdarq-afs-broker-worker.js', import.meta.url), {
    type: 'module',
  })
}

export function assertPgdarqAfsBrowserSupport(): void {
  if (typeof Worker === 'undefined') {
    throw new Error('PgdarqAFS requires Worker support')
  }
  if (typeof SharedArrayBuffer === 'undefined') {
    throw new Error(
      'PgdarqAFS requires SharedArrayBuffer. Configure COOP/COEP and cross-origin isolation.',
    )
  }
  if (typeof crossOriginIsolated !== 'undefined' && !crossOriginIsolated) {
    throw new Error(
      'PgdarqAFS requires a cross-origin isolated browser context (COOP/COEP).',
    )
  }
}
