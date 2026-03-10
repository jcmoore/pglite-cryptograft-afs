import { PgdarqAFS } from '../../../src/browser.js'

let fs: PgdarqAFS | undefined
let brokerPort: MessagePort | undefined
let brokerWorker: Worker | undefined

self.addEventListener('message', async (event: MessageEvent<any>) => {
  try {
    const message = event.data

    switch (message.type) {
      case 'init': {
        brokerPort = message.brokerPort ?? brokerPort
        brokerWorker = message.useFakeBroker
          ? new Worker(new URL('./fake-broker.worker.ts', import.meta.url), {
              type: 'module',
            })
          : undefined
        fs = new PgdarqAFS('/browser-db', {
          brokerPort,
          brokerWorker,
          databaseName: message.databaseName,
          relaxedDurability: message.relaxedDurability,
        })
        await fs.init({} as never, {})
        postMessage({ type: 'ready' })
        return
      }
      case 'writeFile': {
        fs!.writeFile(message.path, message.contents)
        await fs!.syncToFs(false)
        postMessage({ type: 'wrote' })
        return
      }
      case 'readFile': {
        const stat = fs!.lstat(message.path)
        const fd = fs!.open(message.path, 'r')
        const buffer = new Uint8Array(stat.size)
        fs!.read(fd, buffer, 0, buffer.length, 0)
        fs!.close(fd)
        postMessage({
          type: 'read',
          contents: new TextDecoder().decode(buffer),
        })
        return
      }
      case 'stat': {
        const stat = fs!.lstat(message.path)
        postMessage({
          type: 'statResult',
          size: stat.size,
        })
        return
      }
      case 'truncate': {
        fs!.truncate(message.path, message.length)
        await fs!.syncToFs(false)
        postMessage({ type: 'truncated' })
        return
      }
      case 'close': {
        await fs?.closeFs()
        brokerWorker?.terminate()
        brokerWorker = undefined
        fs = undefined
        postMessage({ type: 'closed' })
        return
      }
      default:
        throw new Error(`Unknown runtime message: ${String(message?.type)}`)
    }
  } catch (error) {
    postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    })
  }
})
