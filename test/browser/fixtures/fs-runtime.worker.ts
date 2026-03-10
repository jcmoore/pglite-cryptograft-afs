import { PgdarqAFS } from '../../../src/browser.js'

let fs: PgdarqAFS | undefined
let brokerWorker: Worker | undefined

self.addEventListener('message', async (event: MessageEvent<any>) => {
  const message = event.data

  switch (message.type) {
    case 'init': {
      brokerWorker = new Worker(
        new URL('./fake-broker.worker.ts', import.meta.url),
        { type: 'module' },
      )
      fs = new PgdarqAFS('/browser-db', { brokerWorker })
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
    case 'close': {
      await fs?.closeFs()
      brokerWorker?.terminate()
      postMessage({ type: 'closed' })
      return
    }
    default:
      throw new Error(`Unknown runtime message: ${String(message?.type)}`)
  }
})
