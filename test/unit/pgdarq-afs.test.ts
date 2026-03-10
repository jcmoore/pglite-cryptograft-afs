import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PgdarqAFS } from '../../src/pgdarq-afs.js'
import {
  decodeSyncRequest,
  encodeSyncResponse,
  type PgdarqAfsBrokerInitMessage,
  type PgdarqAfsBrokerRequestMessage,
  type PgdarqAfsBrokerResponseMessage,
  type PgdarqAfsSyncChannel,
} from '../../src/pgdarq-afs-rpc.js'
import {
  createRootInode,
  PGDARQ_DEFAULT_CHUNK_SIZE,
  PGDARQ_ROOT_INO,
  type PgdarqAfsChunkPayload,
  type PgdarqAfsChunkRecord,
  type PgdarqAfsDentryRecord,
  type PgdarqAfsFlushBatch,
  type PgdarqAfsInodeRecord,
  type PgdarqAfsSnapshot,
} from '../../src/pgdarq-afs-schema.js'

class FakeBrokerStore {
  readonly chunkSize = PGDARQ_DEFAULT_CHUNK_SIZE
  readonly chunks = new Map<string, PgdarqAfsChunkPayload>()
  readonly dentries = new Map<string, PgdarqAfsDentryRecord>()
  readonly inodes = new Map<number, PgdarqAfsInodeRecord>([
    [PGDARQ_ROOT_INO, createRootInode(1, this.chunkSize)],
  ])

  snapshot(): PgdarqAfsSnapshot {
    return {
      chunkSize: this.chunkSize,
      schemaVersion: 1,
      nextIno: Math.max(...this.inodes.keys()) + 1,
      inodes: [...this.inodes.values()].map(cloneInode),
      dentries: [...this.dentries.values()].map((value) => ({ ...value })),
    }
  }

  readChunk(ino: number, chunkIndex: number): PgdarqAfsChunkPayload | null {
    const payload = this.chunks.get(chunkKey(ino, chunkIndex))
    return payload
      ? {
          meta: payload.meta ? new Uint8Array(payload.meta) : null,
          data: new Uint8Array(payload.data),
        }
      : null
  }

  apply(batch: PgdarqAfsFlushBatch): void {
    for (const deleted of batch.deletedDentries) {
      this.dentries.delete(dentryKey(deleted.parentIno, deleted.name))
    }
    for (const dentry of batch.upsertDentries) {
      this.dentries.set(dentryKey(dentry.parent_ino, dentry.name), { ...dentry })
    }
    for (const deleted of batch.deletedChunks) {
      this.chunks.delete(chunkKey(deleted.ino, deleted.chunkIndex))
    }
    for (const chunk of batch.upsertChunks) {
      this.chunks.set(chunkKey(chunk.ino, chunk.chunkIndex), cloneChunk(chunk))
    }
    for (const inode of batch.upsertInodes) {
      this.inodes.set(inode.ino, cloneInode(inode))
    }
    for (const ino of batch.deletedInodes) {
      this.inodes.delete(ino)
      for (const key of [...this.chunks.keys()]) {
        if (key.startsWith(`${ino}:`)) {
          this.chunks.delete(key)
        }
      }
      for (const [key, dentry] of this.dentries.entries()) {
        if (dentry.ino === ino || dentry.parent_ino === ino) {
          this.dentries.delete(key)
        }
      }
    }
  }
}

class FakeBrokerWorker extends EventTarget {
  readonly strictValues: boolean[] = []

  private channel?: PgdarqAfsSyncChannel

  constructor(private readonly store: FakeBrokerStore) {
    super()
  }

  postMessage(message: unknown): void {
    if (
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'pgdarq-afs:init'
    ) {
      const init = message as PgdarqAfsBrokerInitMessage
      this.channel = init.channel
      queueMicrotask(() => this.emit({ id: 0, ok: true, payload: this.store.snapshot() }))
      return
    }

    if (
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === 'pgdarq-afs:sync'
    ) {
      const request = decodeSyncRequest(this.channel!)
      if (request.kind === 'readChunk') {
        const payload = this.store.readChunk(request.ino, request.chunkIndex)
        encodeSyncResponse(this.channel!, {
          kind: 'readChunk',
          found: payload !== null,
          payload,
        })
      }
      return
    }

    const request = message as PgdarqAfsBrokerRequestMessage
    switch (request.payload.type) {
      case 'flush':
        this.strictValues.push(request.payload.strict)
        this.store.apply(request.payload.batch)
        queueMicrotask(() =>
          this.emit({ id: request.id, ok: true, payload: { strictCompleted: request.payload.strict } }),
        )
        return
      case 'close':
        queueMicrotask(() =>
          this.emit({ id: request.id, ok: true, payload: { closed: true } }),
        )
        return
      case 'snapshot':
        queueMicrotask(() =>
          this.emit({ id: request.id, ok: true, payload: this.store.snapshot() }),
        )
        return
      default:
        throw new Error(`Unknown fake broker message`)
    }
  }

  terminate(): void {}

  private emit(message: PgdarqAfsBrokerResponseMessage): void {
    this.dispatchEvent(new MessageEvent('message', { data: message }))
  }
}

describe('PgdarqAFS', () => {
  const originalWorker = globalThis.Worker

  beforeEach(() => {
    globalThis.Worker = FakeBrokerWorker as unknown as typeof Worker
  })

  afterEach(() => {
    globalThis.Worker = originalWorker
  })

  it('persists file contents through broker flush and reopen', async () => {
    const store = new FakeBrokerStore()
    const worker = new FakeBrokerWorker(store) as unknown as Worker
    const fs = new PgdarqAFS('/db', { brokerWorker: worker })
    await fs.init({} as never, {})

    fs.writeFile('/base/test.txt', 'hello world')
    await fs.syncToFs(false)
    await fs.closeFs()

    const reopened = new PgdarqAFS('/db', {
      brokerWorker: new FakeBrokerWorker(store) as unknown as Worker,
    })
    await reopened.init({} as never, {})
    const fd = reopened.open('/base/test.txt', 'r')
    const buffer = new Uint8Array(11)
    const bytesRead = reopened.read(fd, buffer, 0, buffer.length, 0)
    reopened.close(fd)

    expect(bytesRead).toBe(11)
    expect(new TextDecoder().decode(buffer)).toBe('hello world')
  })

  it('records relaxed durability flushes as non-strict', async () => {
    const store = new FakeBrokerStore()
    const broker = new FakeBrokerWorker(store)
    const fs = new PgdarqAFS('/db', {
      brokerWorker: broker as unknown as Worker,
      relaxedDurability: true,
    })
    await fs.init({} as never, {})

    fs.writeFile('/file.txt', 'abc')
    await fs.syncToFs(true)

    expect(broker.strictValues.at(-1)).toBe(false)
  })

  it('supports rename and truncate before flush', async () => {
    const store = new FakeBrokerStore()
    const fs = new PgdarqAFS('/db', {
      brokerWorker: new FakeBrokerWorker(store) as unknown as Worker,
    })
    await fs.init({} as never, {})

    fs.writeFile('/docs/file.txt', 'abcdef')
    fs.rename('/docs/file.txt', '/docs/renamed.txt')
    fs.truncate('/docs/renamed.txt', 3)
    await fs.syncToFs(false)

    const reopened = new PgdarqAFS('/db', {
      brokerWorker: new FakeBrokerWorker(store) as unknown as Worker,
    })
    await reopened.init({} as never, {})
    const fd = reopened.open('/docs/renamed.txt', 'r')
    const buffer = new Uint8Array(3)
    reopened.read(fd, buffer, 0, 3, 0)
    reopened.close(fd)

    expect(new TextDecoder().decode(buffer)).toBe('abc')
    expect(() => reopened.lstat('/docs/file.txt')).toThrow(/ENOENT/)
  })
})

function chunkKey(ino: number, chunkIndex: number): string {
  return `${ino}:${chunkIndex}`
}

function dentryKey(parentIno: number, name: string): string {
  return `${parentIno}:${name}`
}

function cloneInode(inode: PgdarqAfsInodeRecord): PgdarqAfsInodeRecord {
  return {
    ...inode,
    header: inode.header ? new Uint8Array(inode.header) : null,
  }
}

function cloneChunk(chunk: PgdarqAfsChunkRecord): PgdarqAfsChunkPayload {
  return {
    meta: chunk.meta ? new Uint8Array(chunk.meta) : null,
    data: new Uint8Array(chunk.data),
  }
}
