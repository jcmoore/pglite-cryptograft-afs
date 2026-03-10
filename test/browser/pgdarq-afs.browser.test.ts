import { describe, expect, it } from 'vitest'
import {
  canInstallPgdarqAFSHost,
  installPgdarqAFSHost,
  PgdarqAFS,
} from '../../src/browser.js'
import { canReopenTursoOpfsDatabase } from './turso-opfs-health.js'

const realHostIt = (await canInstallPgdarqAFSHost()) ? it : it.skip
const stableReopenIt = (await canReopenTursoOpfsDatabase()) ? realHostIt : it.skip

describe('PgdarqAFS browser worker smoke', () => {
  it('fails fast when the browser context is not cross-origin isolated', async () => {
    if (globalThis.crossOriginIsolated) {
      return
    }
    const fs = new PgdarqAFS('/browser-db')
    await expect(fs.init({} as never, {})).rejects.toThrow(
      /SharedArrayBuffer|cross-origin isolated/i,
    )
  })

  const isolatedIt = globalThis.crossOriginIsolated ? it : it.skip
  isolatedIt('uses a real browser Worker and SharedArrayBuffer transport', async () => {
    const worker = new Worker(
      new URL('./fixtures/fs-runtime.worker.ts', import.meta.url),
      { type: 'module' },
    )

    await rpc(worker, { type: 'init', useFakeBroker: true }, 'ready')
    await rpc(
      worker,
      { type: 'writeFile', path: '/docs/browser.txt', contents: 'hello browser' },
      'wrote',
    )
    const read = await rpc(worker, { type: 'readFile', path: '/docs/browser.txt' }, 'read')

    expect(read.contents).toBe('hello browser')

    await rpc(worker, { type: 'close' }, 'closed')
    worker.terminate()
  })

  stableReopenIt('persists data through the real broker worker across reopen', async () => {
    const databaseName = `pgdarq-afs-browser-${crypto.randomUUID()}`
    const initialHost = await installPgdarqAFSHost()
    const initialWorker = new Worker(
      new URL('./fixtures/fs-runtime.worker.ts', import.meta.url),
      { type: 'module' },
    )

    await rpc(
      initialWorker,
      { type: 'init', brokerPort: initialHost.port, databaseName },
      'ready',
      [initialHost.port],
    )

    const contents = 'persisted-'.repeat(1024)
    await rpc(
      initialWorker,
      { type: 'writeFile', path: '/docs/persist.txt', contents },
      'wrote',
    )
    await rpc(initialWorker, { type: 'close' }, 'closed')
    initialWorker.terminate()
    await initialHost.close()

    const reopenedHost = await installPgdarqAFSHost()
    const reopenedWorker = new Worker(
      new URL('./fixtures/fs-runtime.worker.ts', import.meta.url),
      { type: 'module' },
    )
    await rpc(
      reopenedWorker,
      { type: 'init', brokerPort: reopenedHost.port, databaseName },
      'ready',
      [reopenedHost.port],
    )
    const stat = await rpc(reopenedWorker, { type: 'stat', path: '/docs/persist.txt' }, 'statResult')
    const read = await rpc(reopenedWorker, { type: 'readFile', path: '/docs/persist.txt' }, 'read')

    expect(stat.size).toBe(contents.length)
    expect(read.contents).toBe(contents)

    await rpc(reopenedWorker, { type: 'close' }, 'closed')
    reopenedWorker.terminate()
    await reopenedHost.close()
  })

  realHostIt('supports truncation with the real broker worker', async () => {
    const databaseName = `pgdarq-afs-browser-${crypto.randomUUID()}`
    const host = await installPgdarqAFSHost()
    const worker = new Worker(
      new URL('./fixtures/fs-runtime.worker.ts', import.meta.url),
      { type: 'module' },
    )

    await rpc(worker, { type: 'init', brokerPort: host.port, databaseName }, 'ready', [
      host.port,
    ])

    const original = 'abcdefghi'.repeat(1000)
    const truncated = original.slice(0, 4097)
    await rpc(
      worker,
      { type: 'writeFile', path: '/docs/truncate.txt', contents: original },
      'wrote',
    )
    await rpc(
      worker,
      { type: 'truncate', path: '/docs/truncate.txt', length: truncated.length },
      'truncated',
    )
    const stat = await rpc(worker, { type: 'stat', path: '/docs/truncate.txt' }, 'statResult')
    const read = await rpc(worker, { type: 'readFile', path: '/docs/truncate.txt' }, 'read')

    expect(stat.size).toBe(truncated.length)
    expect(read.contents).toBe(truncated)

    await rpc(worker, { type: 'close' }, 'closed')
    worker.terminate()
    await host.close()
  })
})

function rpc<T extends { type: string }>(
  worker: Worker,
  request: Record<string, unknown>,
  responseType: T['type'],
  transfer: Transferable[] = [],
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(
        new Error(
          `Timed out waiting for worker response '${responseType}' to request '${String(request.type)}'`,
        ),
      )
    }, 20000)
    const onMessage = (event: MessageEvent<T | { type: 'error'; message: string }>) => {
      if (event.data.type === 'error') {
        cleanup()
        reject(new Error(event.data.message))
        return
      }
      if (event.data.type !== responseType) {
        return
      }
      cleanup()
      resolve(event.data as T)
    }
    const onError = (error: ErrorEvent) => {
      cleanup()
      reject(error.error ?? new Error(error.message))
    }
    const cleanup = () => {
      clearTimeout(timeout)
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
    }
    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)
    worker.postMessage(request, transfer)
  })
}
