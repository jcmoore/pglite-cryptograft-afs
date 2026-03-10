import type { PgdarqAFSBrokerOptions } from './pgdarq-afs-types.js'

export interface PgdarqAFSHost {
  port: MessagePort
  close: () => Promise<void>
}

const HOST_PROBE_TIMEOUT_MS = 5000

export function createPgdarqAFSBrokerWorker(_options?: PgdarqAFSBrokerOptions): Worker {
  return new Worker(new URL('./pgdarq-afs-broker-worker.js', import.meta.url), {
    type: 'module',
  })
}

export async function canInstallPgdarqAFSHost(
  timeoutMs = HOST_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const { connect } = await import('@tursodatabase/database-wasm')
    const probeName = `pgdarq-afs-host-probe-${Math.random().toString(36).slice(2)}.db`
    const db = await withTimeout(connect(probeName), timeoutMs)
    await db.close()
    return true
  } catch {
    return false
  }
}

export async function installPgdarqAFSHost(): Promise<PgdarqAFSHost> {
  if (typeof MessageChannel === 'undefined') {
    throw new Error('PgdarqAFS host installation requires MessageChannel support')
  }
  if (!(await canInstallPgdarqAFSHost())) {
    throw new Error(
      'PgdarqAFS host installation requires a browser context where @tursodatabase/database-wasm can initialize successfully.',
    )
  }

  const { attachPgdarqAFSBroker } = await import('./pgdarq-afs-broker.js')
  const channel = new MessageChannel()
  const broker = attachPgdarqAFSBroker(channel.port1)
  return {
    port: channel.port2,
    close: async () => {
      await broker.close()
    },
  }
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(
            new Error(
              `Timed out waiting ${timeoutMs}ms for @tursodatabase/database-wasm initialization`,
            ),
          )
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout)
    }
  }
}
