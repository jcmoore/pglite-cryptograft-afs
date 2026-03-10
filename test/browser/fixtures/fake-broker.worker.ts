import {
  decodeSyncRequest,
  encodeSyncResponse,
  type PgdarqAfsBrokerInitMessage,
  type PgdarqAfsBrokerRequestMessage,
  type PgdarqAfsBrokerResponseMessage,
  type PgdarqAfsSyncChannel,
} from '../../../src/pgdarq-afs-rpc.js'
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
} from '../../../src/pgdarq-afs-schema.js'

const chunkSize = PGDARQ_DEFAULT_CHUNK_SIZE
let channel: PgdarqAfsSyncChannel | undefined

const chunks = new Map<string, PgdarqAfsChunkPayload>()
const dentries = new Map<string, PgdarqAfsDentryRecord>()
const inodes = new Map<number, PgdarqAfsInodeRecord>([
  [PGDARQ_ROOT_INO, createRootInode(1, chunkSize)],
])

self.addEventListener('message', (event: MessageEvent<unknown>) => {
  const message = event.data

  if (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    message.type === 'pgdarq-afs:init'
  ) {
    channel = (message as PgdarqAfsBrokerInitMessage).channel
    postMessage({
      id: 0,
      ok: true,
      payload: snapshot(),
    } satisfies PgdarqAfsBrokerResponseMessage)
    return
  }

  if (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    message.type === 'pgdarq-afs:sync'
  ) {
    const request = decodeSyncRequest(channel!)
    if (request.kind === 'readChunk') {
      const payload = chunks.get(chunkKey(request.ino, request.chunkIndex)) ?? null
      encodeSyncResponse(channel!, {
        kind: 'readChunk',
        found: payload !== null,
        payload: payload
          ? {
              meta: payload.meta ? new Uint8Array(payload.meta) : null,
              data: new Uint8Array(payload.data),
            }
          : null,
      })
    }
    return
  }

  const request = message as PgdarqAfsBrokerRequestMessage
  switch (request.payload.type) {
    case 'flush':
      applyBatch(request.payload.batch)
      postMessage({
        id: request.id,
        ok: true,
        payload: { strictCompleted: request.payload.strict },
      } satisfies PgdarqAfsBrokerResponseMessage)
      return
    case 'close':
      postMessage({
        id: request.id,
        ok: true,
        payload: { closed: true },
      } satisfies PgdarqAfsBrokerResponseMessage)
      return
    case 'snapshot':
      postMessage({
        id: request.id,
        ok: true,
        payload: snapshot(),
      } satisfies PgdarqAfsBrokerResponseMessage)
      return
    default:
      throw new Error('Unknown fake broker message')
  }
})

function snapshot(): PgdarqAfsSnapshot {
  return {
    chunkSize,
    schemaVersion: 1,
    nextIno: Math.max(...inodes.keys()) + 1,
    inodes: [...inodes.values()].map((inode) => ({
      ...inode,
      header: inode.header ? new Uint8Array(inode.header) : null,
    })),
    dentries: [...dentries.values()].map((dentry) => ({ ...dentry })),
  }
}

function applyBatch(batch: PgdarqAfsFlushBatch): void {
  for (const deleted of batch.deletedDentries) {
    dentries.delete(dentryKey(deleted.parentIno, deleted.name))
  }
  for (const dentry of batch.upsertDentries) {
    dentries.set(dentryKey(dentry.parent_ino, dentry.name), { ...dentry })
  }
  for (const deleted of batch.deletedChunks) {
    chunks.delete(chunkKey(deleted.ino, deleted.chunkIndex))
  }
  for (const chunk of batch.upsertChunks) {
    chunks.set(chunkKey(chunk.ino, chunk.chunkIndex), cloneChunk(chunk))
  }
  for (const inode of batch.upsertInodes) {
    inodes.set(inode.ino, {
      ...inode,
      header: inode.header ? new Uint8Array(inode.header) : null,
    })
  }
  for (const ino of batch.deletedInodes) {
    inodes.delete(ino)
    for (const key of [...chunks.keys()]) {
      if (key.startsWith(`${ino}:`)) {
        chunks.delete(key)
      }
    }
    for (const [key, dentry] of dentries.entries()) {
      if (dentry.ino === ino || dentry.parent_ino === ino) {
        dentries.delete(key)
      }
    }
  }
}

function chunkKey(ino: number, chunkIndex: number): string {
  return `${ino}:${chunkIndex}`
}

function dentryKey(parentIno: number, name: string): string {
  return `${parentIno}:${name}`
}

function cloneChunk(chunk: PgdarqAfsChunkRecord): PgdarqAfsChunkPayload {
  return {
    meta: chunk.meta ? new Uint8Array(chunk.meta) : null,
    data: new Uint8Array(chunk.data),
  }
}
