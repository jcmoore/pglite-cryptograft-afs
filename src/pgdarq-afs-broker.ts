import { connect, type Database } from '@tursodatabase/database-wasm/vite'
import {
  decodeSyncRequest,
  encodeSyncError,
  encodeSyncResponse,
  type PgdarqAfsBrokerInitMessage,
  type PgdarqAfsBrokerRequestMessage,
  type PgdarqAfsBrokerResponseMessage,
  type PgdarqAfsBrokerSyncMessage,
  type PgdarqAfsSyncChannel,
} from './pgdarq-afs-rpc.js'
import {
  createRootInode,
  dataTableIdentifier,
  dataTableName,
  getSchemaStatements,
  normalizeChunkSize,
  PGDARQ_AFS_SCHEMA_VERSION,
  PGDARQ_ROOT_INO,
  type PgdarqAfsChunkPayload,
  type PgdarqAfsChunkRecord,
  type PgdarqAfsDentryRecord,
  type PgdarqAfsFlushBatch,
  type PgdarqAfsInodeRecord,
  type PgdarqAfsSnapshot,
} from './pgdarq-afs-schema.js'
import type { PgdarqAFSBrokerOptions } from './pgdarq-afs-types.js'

type DatabaseRole = 'memory' | 'persistent'
type ResolvedBrokerOptions = PgdarqAFSBrokerOptions & {
  chunkSize: number
  persistentPath: string
}

interface BrokerState {
  channel: PgdarqAfsSyncChannel | null
  dbMemory: Database | null
  dbPersistent: Database | null
  knownTablesMemory: Set<string>
  knownTablesPersistent: Set<string>
  flushQueue: Promise<void>
  options: ResolvedBrokerOptions | null
}

const state: BrokerState = {
  channel: null,
  dbMemory: null,
  dbPersistent: null,
  knownTablesMemory: new Set<string>(),
  knownTablesPersistent: new Set<string>(),
  flushQueue: Promise.resolve(),
  options: null,
}

export function startPgdarqAFSBroker(): void {
  self.addEventListener('message', (event: MessageEvent<unknown>) => {
    void handleMessage(event.data)
  })
}

async function handleMessage(message: unknown): Promise<void> {
  if (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    message.type === 'pgdarq-afs:init'
  ) {
    await handleInit(message as PgdarqAfsBrokerInitMessage)
    return
  }

  if (
    typeof message === 'object' &&
    message !== null &&
    'type' in message &&
    message.type === 'pgdarq-afs:sync'
  ) {
    await handleSyncRead(message as PgdarqAfsBrokerSyncMessage)
    return
  }

  if (typeof message === 'object' && message !== null && 'id' in message) {
    const request = message as PgdarqAfsBrokerRequestMessage
    await respond(request.id, async () => {
      switch (request.payload.type) {
        case 'snapshot':
          return await loadSnapshot(state.dbPersistent!, normalizeChunkSize(state.options?.chunkSize))
        case 'flush':
          return await flushBatch(request.payload.batch, request.payload.strict)
        case 'close':
          await closeBroker()
          return { closed: true as const }
        default:
          throw new Error(`Unknown broker request: ${String((request as { payload?: { type?: string } }).payload?.type)}`)
      }
    })
  }
}

async function handleInit(message: PgdarqAfsBrokerInitMessage): Promise<void> {
  state.channel = message.channel
  state.options = normalizeBrokerOptions(message.options as PgdarqAFSBrokerOptions)
  const options = state.options
  const persistentConnectOptions =
    options.encryption !== undefined
      ? {
          encryption: options.encryption,
          experimental: ['encryption'] as Array<'encryption'>,
        }
      : {}

  state.dbPersistent = await connect(
    options.persistentPath ?? options.databaseName,
    persistentConnectOptions,
  )
  state.dbMemory = await connect(':memory:')

  await ensureDatabase(state.dbPersistent, options.chunkSize)
  await ensureDatabase(state.dbMemory, options.chunkSize)
  const snapshot = await loadSnapshot(state.dbPersistent, options.chunkSize)
  await seedMemoryDatabase(snapshot)
  state.knownTablesPersistent = await loadKnownTables(state.dbPersistent)
  state.knownTablesMemory = await loadKnownTables(state.dbMemory)

  postMessage({
    id: 0,
    ok: true,
    payload: snapshot,
  } satisfies PgdarqAfsBrokerResponseMessage)
}

async function handleSyncRead(_message: PgdarqAfsBrokerSyncMessage): Promise<void> {
  if (!state.channel || !state.dbMemory || !state.dbPersistent) {
    return
  }

  try {
    const request = decodeSyncRequest(state.channel)
    switch (request.kind) {
      case 'readChunk': {
        const payload = await readChunk(request.ino, request.chunkIndex)
        encodeSyncResponse(state.channel, {
          kind: 'readChunk',
          found: payload !== null,
          payload,
        })
        return
      }
      default:
        throw new Error(`Unknown sync request: ${String((request as { kind?: string }).kind)}`)
    }
  } catch (error) {
    encodeSyncError(state.channel, error)
  }
}

function normalizeBrokerOptions(options: PgdarqAFSBrokerOptions): ResolvedBrokerOptions {
  return {
    ...options,
    chunkSize: normalizeChunkSize(options.chunkSize),
    persistentPath: options.persistentPath ?? options.databaseName,
  }
}

async function respond(
  id: number,
  fn: () => Promise<PgdarqAfsSnapshot | { strictCompleted: boolean } | { closed: true }>,
): Promise<void> {
  try {
    const payload = await fn()
    postMessage({
      id,
      ok: true,
      payload,
    } satisfies PgdarqAfsBrokerResponseMessage)
  } catch (error) {
    postMessage({
      id,
      ok: false,
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    } satisfies PgdarqAfsBrokerResponseMessage)
  }
}

async function ensureDatabase(db: Database, chunkSize: number): Promise<void> {
  for (const statement of getSchemaStatements(chunkSize)) {
    await db.exec(statement)
  }

  await db.prepare(
    `INSERT OR REPLACE INTO fs_config (key, value) VALUES ('schema_version', ?)`,
  ).run(String(PGDARQ_AFS_SCHEMA_VERSION))
  await db.prepare(
    `INSERT OR REPLACE INTO fs_config (key, value) VALUES ('chunk_size', ?)`,
  ).run(String(chunkSize))

  const root = (await db.prepare(
    'SELECT ino FROM fs_inode WHERE ino = ?',
  ).get(PGDARQ_ROOT_INO)) as { ino: number } | undefined

  if (!root) {
    const inode = createRootInode(Math.floor(Date.now() / 1000), chunkSize)
    await upsertInodeRecord(db, inode)
  }
}

async function loadSnapshot(db: Database, chunkSize: number): Promise<PgdarqAfsSnapshot> {
  const config = (await db.prepare(
    "SELECT value FROM fs_config WHERE key = 'schema_version'",
  ).get()) as { value?: string } | undefined

  const schemaVersion = Number(config?.value ?? PGDARQ_AFS_SCHEMA_VERSION)
  if (schemaVersion !== PGDARQ_AFS_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported pgdarq-afs schema version: ${schemaVersion}`,
    )
  }

  const inodes = (await db.prepare(
    `SELECT ino, mode, nlink, uid, gid, size, atime, mtime, ctime, rdev,
            atime_nsec, mtime_nsec, ctime_nsec, chunk_size, header
       FROM fs_inode
      ORDER BY ino`,
  ).all()) as PgdarqAfsInodeRecord[]

  const dentries = (await db.prepare(
    `SELECT name, parent_ino, ino
       FROM fs_dentry
      ORDER BY parent_ino, name`,
  ).all()) as PgdarqAfsDentryRecord[]

  const maxInoRow = (await db.prepare(
    `SELECT COALESCE(MAX(ino), 0) AS max_ino FROM fs_inode`,
  ).get()) as { max_ino: number }

  return {
    chunkSize,
    schemaVersion,
    nextIno: maxInoRow.max_ino + 1,
    inodes,
    dentries,
  }
}

async function seedMemoryDatabase(snapshot: PgdarqAfsSnapshot): Promise<void> {
  const db = state.dbMemory!
  await db.exec('BEGIN')
  try {
    await db.exec('DELETE FROM fs_dentry')
    await db.exec('DELETE FROM fs_inode')

    for (const inode of snapshot.inodes) {
      await upsertInodeRecord(db, inode)
    }
    for (const dentry of snapshot.dentries) {
      await upsertDentryRecord(db, dentry)
    }

    await db.exec('COMMIT')
  } catch (error) {
    await db.exec('ROLLBACK')
    throw error
  }
}

async function loadKnownTables(db: Database): Promise<Set<string>> {
  const rows = (await db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'fs_data_inode_%'`,
  ).all()) as Array<{ name: string }>

  return new Set(rows.map((row) => row.name))
}

async function readChunk(
  ino: number,
  chunkIndex: number,
): Promise<PgdarqAfsChunkPayload | null> {
  const memoryTable = dataTableName(ino)
  const persistentTable = dataTableName(ino)

  if (state.knownTablesMemory.has(memoryTable)) {
    const payload = await getChunkFromDatabase(state.dbMemory!, ino, chunkIndex)
    if (payload) {
      return payload
    }
  }

  if (!state.knownTablesPersistent.has(persistentTable)) {
    return null
  }

  const payload = await getChunkFromDatabase(state.dbPersistent!, ino, chunkIndex)
  if (!payload) {
    return null
  }

  await ensureChunkTable(state.dbMemory!, 'memory', ino)
  await upsertChunkRecord(state.dbMemory!, {
    ino,
    chunkIndex,
    meta: payload.meta,
    data: payload.data,
  })
  return payload
}

async function getChunkFromDatabase(
  db: Database,
  ino: number,
  chunkIndex: number,
): Promise<PgdarqAfsChunkPayload | null> {
  const table = dataTableIdentifier(ino)
  const row = (await db.prepare(
    `SELECT meta, data FROM ${table} WHERE chunk_index = ?`,
  ).get(chunkIndex)) as { meta?: Uint8Array | null; data?: Uint8Array } | undefined

  if (!row?.data) {
    return null
  }

  return {
    meta: row.meta ?? null,
    data: row.data,
  }
}

async function flushBatch(
  batch: PgdarqAfsFlushBatch,
  strict: boolean,
): Promise<{ strictCompleted: boolean }> {
  await applyBatchToDatabase(state.dbMemory!, 'memory', batch)

  if (strict) {
    await applyBatchToDatabase(state.dbPersistent!, 'persistent', batch)
    return { strictCompleted: true }
  }

  state.flushQueue = state.flushQueue.then(async () => {
    await applyBatchToDatabase(state.dbPersistent!, 'persistent', batch)
  })
  return { strictCompleted: false }
}

async function applyBatchToDatabase(
  db: Database,
  role: DatabaseRole,
  batch: PgdarqAfsFlushBatch,
): Promise<void> {
  await db.exec('BEGIN')
  try {
    for (const ino of batch.createdTables) {
      await ensureChunkTable(db, role, ino)
    }

    for (const deleted of batch.deletedDentries) {
      await db.prepare(
        `DELETE FROM fs_dentry WHERE parent_ino = ? AND name = ?`,
      ).run(deleted.parentIno, deleted.name)
    }

    for (const dentry of batch.upsertDentries) {
      await upsertDentryRecord(db, dentry)
    }

    for (const deleted of batch.deletedChunks) {
      if (!hasKnownTable(role, deleted.ino)) {
        continue
      }
      await db.prepare(
        `DELETE FROM ${dataTableIdentifier(deleted.ino)} WHERE chunk_index = ?`,
      ).run(deleted.chunkIndex)
    }

    for (const chunk of batch.upsertChunks) {
      await ensureChunkTable(db, role, chunk.ino)
      await upsertChunkRecord(db, chunk)
    }

    for (const inode of batch.upsertInodes) {
      await upsertInodeRecord(db, inode)
    }

    for (const ino of batch.deletedInodes) {
      if (hasKnownTable(role, ino)) {
        await db.exec(`DROP TABLE IF EXISTS ${dataTableIdentifier(ino)}`)
        knownTables(role).delete(dataTableName(ino))
      }
      await db.prepare(`DELETE FROM fs_inode WHERE ino = ?`).run(ino)
      await db.prepare(`DELETE FROM fs_dentry WHERE ino = ? OR parent_ino = ?`).run(
        ino,
        ino,
      )
    }

    await db.exec('COMMIT')
  } catch (error) {
    await db.exec('ROLLBACK')
    throw error
  }
}

function knownTables(role: DatabaseRole): Set<string> {
  return role === 'memory' ? state.knownTablesMemory : state.knownTablesPersistent
}

function hasKnownTable(role: DatabaseRole, ino: number): boolean {
  return knownTables(role).has(dataTableName(ino))
}

async function ensureChunkTable(
  db: Database,
  role: DatabaseRole,
  ino: number,
): Promise<void> {
  const tableName = dataTableName(ino)
  if (knownTables(role).has(tableName)) {
    return
  }

  await db.exec(
    `CREATE TABLE IF NOT EXISTS ${dataTableIdentifier(ino)} (
      chunk_index INTEGER PRIMARY KEY,
      meta BLOB NULL,
      data BLOB NOT NULL
    )`,
  )
  knownTables(role).add(tableName)
}

async function upsertInodeRecord(db: Database, inode: PgdarqAfsInodeRecord): Promise<void> {
  await db.prepare(
    `INSERT INTO fs_inode (
        ino, mode, nlink, uid, gid, size, atime, mtime, ctime, rdev,
        atime_nsec, mtime_nsec, ctime_nsec, chunk_size, header
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(ino) DO UPDATE SET
        mode = excluded.mode,
        nlink = excluded.nlink,
        uid = excluded.uid,
        gid = excluded.gid,
        size = excluded.size,
        atime = excluded.atime,
        mtime = excluded.mtime,
        ctime = excluded.ctime,
        rdev = excluded.rdev,
        atime_nsec = excluded.atime_nsec,
        mtime_nsec = excluded.mtime_nsec,
        ctime_nsec = excluded.ctime_nsec,
        chunk_size = excluded.chunk_size,
        header = excluded.header`,
  ).run(
    inode.ino,
    inode.mode,
    inode.nlink,
    inode.uid,
    inode.gid,
    inode.size,
    inode.atime,
    inode.mtime,
    inode.ctime,
    inode.rdev,
    inode.atime_nsec,
    inode.mtime_nsec,
    inode.ctime_nsec,
    inode.chunk_size,
    inode.header,
  )
}

async function upsertDentryRecord(db: Database, dentry: PgdarqAfsDentryRecord): Promise<void> {
  await db.prepare(
    `INSERT INTO fs_dentry (name, parent_ino, ino)
      VALUES (?, ?, ?)
      ON CONFLICT(parent_ino, name) DO UPDATE SET ino = excluded.ino`,
  ).run(dentry.name, dentry.parent_ino, dentry.ino)
}

async function upsertChunkRecord(db: Database, chunk: PgdarqAfsChunkRecord): Promise<void> {
  await db.prepare(
    `INSERT INTO ${dataTableIdentifier(chunk.ino)} (chunk_index, meta, data)
      VALUES (?, ?, ?)
      ON CONFLICT(chunk_index) DO UPDATE SET
        meta = excluded.meta,
        data = excluded.data`,
  ).run(chunk.chunkIndex, chunk.meta, chunk.data)
}

async function closeBroker(): Promise<void> {
  await state.flushQueue
  await state.dbMemory?.close()
  await state.dbPersistent?.close()
  state.dbMemory = null
  state.dbPersistent = null
}
