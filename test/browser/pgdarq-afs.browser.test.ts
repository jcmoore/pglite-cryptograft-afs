import { describe, expect, it } from 'vitest'
import { PgdarqAFS } from '../../src/browser.js'

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

    await rpc(worker, { type: 'init' }, 'ready')
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
})

function rpc<T extends { type: string }>(
  worker: Worker,
  request: Record<string, unknown>,
  responseType: T['type'],
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onMessage = (event: MessageEvent<T>) => {
      if (event.data.type !== responseType) {
        return
      }
      cleanup()
      resolve(event.data)
    }
    const onError = (error: ErrorEvent) => {
      cleanup()
      reject(error.error ?? new Error(error.message))
    }
    const cleanup = () => {
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
    }
    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)
    worker.postMessage(request)
  })
}
