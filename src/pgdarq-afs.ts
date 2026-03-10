import {
  BaseFilesystem,
  ERRNO_CODES,
  type FsStats,
} from '@electric-sql/pglite/basefs'
import type { PGlite } from '@electric-sql/pglite'
import { PgdarqAfsBatchBuilder } from './pgdarq-afs-batch.js'
import {
  assertPgdarqAfsBrowserSupport,
  createPgdarqAFSBrokerWorker,
} from './pgdarq-afs-browser.js'
import {
  createSyncChannel,
  decodeSyncResponse,
  encodeSyncRequest,
  PGDARQ_SYNC_STATE_IDLE,
  type PgdarqAfsBrokerInitMessage,
  type PgdarqAfsBrokerRequestMessage,
  type PgdarqAfsBrokerResponseMessage,
  type PgdarqAfsSyncChannel,
} from './pgdarq-afs-rpc.js'
import {
  normalizeChunkSize,
  PGDARQ_ROOT_INO,
  type PgdarqAfsChunkPayload,
  type PgdarqAfsInodeRecord,
  type PgdarqAfsSnapshot,
} from './pgdarq-afs-schema.js'
import type { PgdarqAFSOptions } from './pgdarq-afs-types.js'
import type { PgdarqAfsBrokerEndpoint } from './pgdarq-afs-broker.js'

const EIO = 5
const O_WRONLY = 1
const O_RDWR = 2
const O_CREAT = 64
const O_EXCL = 128
const O_TRUNC = 512
const O_APPEND = 1024
const BROKER_INIT_TIMEOUT_MS = 15000

interface FilesystemError extends Error {
  pgSymbol: string
  codeSym: string
  code: string
  errno: number
}

interface OpenFile {
  flags: ParsedFlags
  ino: number
  isDirectory: boolean
  path: string
  position: number
}

interface ParsedFlags {
  append: boolean
  create: boolean
  exclusive: boolean
  read: boolean
  truncate: boolean
  write: boolean
}

export class PgdarqAFS extends BaseFilesystem {
  private readonly options: PgdarqAFSOptions
  private readonly inodes = new Map<number, PgdarqAfsInodeRecord>()
  private readonly children = new Map<number, Map<string, number>>()
  private readonly batch = new PgdarqAfsBatchBuilder()
  private readonly dirtyChunks = new Map<string, PgdarqAfsChunkPayload>()
  private readonly pendingRequests = new Map<
    number,
    {
      reject: (error: unknown) => void
      resolve: (value: unknown) => void
    }
  >()

  private brokerEndpoint: PgdarqAfsBrokerEndpoint | undefined
  private createdBrokerWorker = false
  private syncChannel?: PgdarqAfsSyncChannel
  private cwd = '/'
  private nextFd = 100
  private nextIno = PGDARQ_ROOT_INO + 1
  private nextRequestId = 1
  private openFiles = new Map<number, OpenFile>()

  constructor(dataDir: string, options: PgdarqAFSOptions = {}) {
    super(dataDir, options.debug !== undefined ? { debug: options.debug } : {})
    this.options = {
      ...options,
      chunkSize: normalizeChunkSize(options.chunkSize),
    }
  }

  override async init(
    pg: PGlite,
    emscriptenOptions: Parameters<BaseFilesystem['init']>[1],
  ): Promise<{ emscriptenOpts: Parameters<BaseFilesystem['init']>[1] }> {
    assertPgdarqAfsBrowserSupport()

    this.pg = pg
    this.syncChannel = createSyncChannel()
    this.brokerEndpoint =
      this.options.brokerPort ??
      this.options.brokerWorker ??
      createPgdarqAFSBrokerWorker()
    this.createdBrokerWorker = !this.options.brokerPort && !this.options.brokerWorker
    this.brokerEndpoint.start?.()
    this.brokerEndpoint.addEventListener('message', this.onBrokerMessage as EventListener)

    const snapshotPromise = new Promise<PgdarqAfsSnapshot>((resolve, reject) => {
      const brokerEndpoint = this.brokerEndpoint!
      const timeout = setTimeout(() => {
        cleanup()
        reject(
          new Error(
            `PgdarqAFS broker worker initialization timed out after ${BROKER_INIT_TIMEOUT_MS}ms`,
          ),
        )
      }, BROKER_INIT_TIMEOUT_MS)

      const onError = (event: ErrorEvent): void => {
        cleanup()
        reject(
          new Error(
            `PgdarqAFS broker worker failed during init: ${event.message || 'Unknown worker error'}`,
          ),
        )
      }

      const cleanup = (): void => {
        clearTimeout(timeout)
        brokerEndpoint.removeEventListener?.('error', onError as EventListener)
        this.pendingRequests.delete(0)
      }

      brokerEndpoint.addEventListener('error', onError as EventListener)
      this.pendingRequests.set(0, {
        resolve: (value) => {
          cleanup()
          resolve(value as PgdarqAfsSnapshot)
        },
        reject: (error) => {
          cleanup()
          reject(error)
        },
      })
    })

    const initMessage: PgdarqAfsBrokerInitMessage = {
      type: 'pgdarq-afs:init',
      channel: this.syncChannel,
      options: {
        chunkSize: this.options.chunkSize,
        databaseName: this.options.databaseName ?? sanitizeDatabaseName(this.dataDir ?? 'pgdarq-afs'),
        debug: this.debug,
        encryption: this.options.encryption,
      },
    }

    this.brokerEndpoint.postMessage(initMessage)
    const snapshot = await snapshotPromise
    this.hydrateSnapshot(snapshot)

    return await super.init(pg, emscriptenOptions)
  }

  override async initialSyncFs(): Promise<void> {}

  override async syncToFs(relaxedDurability = false): Promise<void> {
    if (!this.batch.hasChanges()) {
      return
    }

    const batch = this.batch.build()
    await this.callBroker({
      id: this.nextRequestId++,
      payload: {
        type: 'flush',
        batch,
        strict: !(relaxedDurability || this.options.relaxedDurability),
      },
    })
    this.batch.reset()
    this.dirtyChunks.clear()
  }

  override async closeFs(): Promise<void> {
    if (this.batch.hasChanges()) {
      await this.syncToFs(false)
    }

    if (this.brokerEndpoint) {
      try {
        await this.callBroker({
          id: this.nextRequestId++,
          payload: { type: 'close' },
        })
      } catch (_error) {
        // Ignore shutdown errors while tearing the worker down.
      }
      this.brokerEndpoint.removeEventListener?.('message', this.onBrokerMessage as EventListener)
      if (this.createdBrokerWorker) {
        this.brokerEndpoint.terminate?.()
      }
      this.brokerEndpoint = undefined
    }
  }

  chdir(pathStr: string): void {
    this.cwd = normalizeFsPath(pathStr, this.cwd)
  }

  chmod(pathStr: string, mode: number): void {
    const inode = this.getInodeByPath(pathStr)
    inode.mode = mode
    touchInode(inode)
    this.batch.upsertInode(cloneInode(inode))
  }

  close(fd: number): void {
    if (!this.openFiles.delete(fd)) {
      throw this.createError('EBADF', `close '${fd}'`)
    }
  }

  fstat(fd: number): FsStats {
    const file = this.openFiles.get(fd)
    if (!file) {
      throw this.createError('EBADF', `fstat '${fd}'`)
    }
    return this.toFsStats(this.requireInode(file.ino))
  }

  lstat(pathStr: string): FsStats {
    return this.toFsStats(this.getInodeByPath(pathStr))
  }

  mkdir(pathStr: string, options?: { recursive?: boolean; mode?: number }): void {
    const path = normalizeFsPath(pathStr, this.cwd)
    if (path === '/') {
      return
    }

    if (options?.recursive) {
      let current = '/'
      for (const segment of splitPath(path)) {
        current = joinPath(current, segment)
        if (!this.pathExists(current)) {
          this.createDirectory(current, options.mode ?? 0o040755)
        }
      }
      return
    }

    if (this.pathExists(path)) {
      throw this.createError('EEXIST', `mkdir '${path}'`)
    }

    this.createDirectory(path, options?.mode ?? 0o040755)
  }

  open(pathStr: string, flags: string | number = 'r', mode = 0o100666): number {
    const path = normalizeFsPath(pathStr, this.cwd)
    const parsed = parseFlags(flags)
    let inode = this.lookupPath(path)

    if (!inode) {
      if (!parsed.create) {
        throw this.createError('ENOENT', `open '${path}'`)
      }
      inode = this.createFile(path, mode)
    } else if (parsed.exclusive && parsed.create) {
      throw this.createError('EEXIST', `open '${path}'`)
    }

    if (isDirectoryMode(inode.mode)) {
      const fd = this.nextFd++
      this.openFiles.set(fd, {
        flags: parsed,
        ino: inode.ino,
        isDirectory: true,
        path,
        position: 0,
      })
      return fd
    }

    if (parsed.truncate) {
      this.truncateInode(inode.ino, 0)
      inode = this.requireInode(inode.ino)
    }

    const fd = this.nextFd++
    this.openFiles.set(fd, {
      flags: parsed,
      ino: inode.ino,
      isDirectory: false,
      path,
      position: parsed.append ? inode.size : 0,
    })
    return fd
  }

  readdir(pathStr: string): string[] {
    const inode = this.getInodeByPath(pathStr)
    if (!isDirectoryMode(inode.mode)) {
      throw this.createError('ENOTDIR', `readdir '${pathStr}'`)
    }
    return [...(this.children.get(inode.ino)?.keys() ?? [])].sort((a, b) =>
      a.localeCompare(b),
    )
  }

  read(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number {
    const file = this.requireOpenFile(fd)
    if (file.isDirectory) {
      throw this.createError('EISDIR', `read '${file.path}'`)
    }

    const inode = this.requireInode(file.ino)
    const start = resolvePosition(file, position)
    if (start >= inode.size || length === 0) {
      file.position = start
      return 0
    }

    const end = Math.min(inode.size, start + length)
    let bytesRead = 0
    let cursor = start

    while (cursor < end) {
      const chunkIndex = Math.floor(cursor / inode.chunk_size)
      const chunkOffset = cursor % inode.chunk_size
      const bytesToCopy = Math.min(end - cursor, inode.chunk_size - chunkOffset)
      const payload = this.getChunkPayloadSync(inode.ino, chunkIndex)
      const source = payload?.data ?? new Uint8Array(0)

      for (let i = 0; i < bytesToCopy; i++) {
        buffer[offset + bytesRead + i] = source[chunkOffset + i] ?? 0
      }

      bytesRead += bytesToCopy
      cursor += bytesToCopy
    }

    file.position = start + bytesRead
    return bytesRead
  }

  rename(oldPathStr: string, newPathStr: string): void {
    const oldPath = normalizeFsPath(oldPathStr, this.cwd)
    const newPath = normalizeFsPath(newPathStr, this.cwd)
    const source = this.getInodeByPath(oldPath)
    const { parentIno: oldParentIno, name: oldName } = this.getParentEntry(oldPath)
    const { parentIno: newParentIno, name: newName } = this.getParentEntry(newPath, true)

    this.ensurePathParents(newPath)

    const newParent = this.requireInode(newParentIno)
    if (!isDirectoryMode(newParent.mode)) {
      throw this.createError('ENOTDIR', `rename '${newPath}'`)
    }

    const newChildren = this.children.get(newParentIno) ?? new Map<string, number>()
    const existingIno = newChildren.get(newName)
    if (existingIno !== undefined) {
      const existing = this.requireInode(existingIno)
      if (isDirectoryMode(existing.mode)) {
        if ((this.children.get(existingIno)?.size ?? 0) > 0) {
          throw this.createError('ENOTEMPTY', `rename '${newPath}'`)
        }
        this.rmdir(newPath)
      } else {
        this.unlink(newPath)
      }
    }

    this.children.get(oldParentIno)?.delete(oldName)
    this.batch.deleteDentry(oldParentIno, oldName)
    newChildren.set(newName, source.ino)
    this.children.set(newParentIno, newChildren)
    this.batch.upsertDentry({ name: newName, parent_ino: newParentIno, ino: source.ino })
  }

  rmdir(pathStr: string): void {
    const path = normalizeFsPath(pathStr, this.cwd)
    if (path === '/') {
      throw this.createError('EINVAL', `rmdir '${path}'`)
    }

    const inode = this.getInodeByPath(path)
    if (!isDirectoryMode(inode.mode)) {
      throw this.createError('ENOTDIR', `rmdir '${path}'`)
    }
    if ((this.children.get(inode.ino)?.size ?? 0) > 0) {
      throw this.createError('ENOTEMPTY', `rmdir '${path}'`)
    }

    const { parentIno, name } = this.getParentEntry(path)
    this.children.get(parentIno)?.delete(name)
    this.children.delete(inode.ino)
    this.inodes.delete(inode.ino)
    this.batch.deleteDentry(parentIno, name)
    this.batch.deleteInode(inode.ino)
  }

  truncate(pathStr: string, len: number): void {
    const inode = this.getInodeByPath(pathStr)
    this.truncateInode(inode.ino, len)
  }

  unlink(pathStr: string): void {
    const path = normalizeFsPath(pathStr, this.cwd)
    const inode = this.getInodeByPath(path)
    if (isDirectoryMode(inode.mode)) {
      throw this.createError('EISDIR', `unlink '${path}'`)
    }

    const { parentIno, name } = this.getParentEntry(path)
    this.children.get(parentIno)?.delete(name)
    this.inodes.delete(inode.ino)
    this.batch.deleteDentry(parentIno, name)
    this.batch.deleteInode(inode.ino)

    for (const key of [...this.dirtyChunks.keys()]) {
      if (key.startsWith(`${inode.ino}:`)) {
        this.dirtyChunks.delete(key)
      }
    }
  }

  utimes(pathStr: string, atime: number, mtime: number): void {
    const inode = this.getInodeByPath(pathStr)
    inode.atime = Math.trunc(atime)
    inode.mtime = Math.trunc(mtime)
    this.batch.upsertInode(cloneInode(inode))
  }

  writeFile(
    pathStr: string,
    data: string | Uint8Array,
    options?: { encoding?: string; mode?: number; flag?: string },
  ): void {
    const encoding = (options?.encoding ?? 'utf8') as BufferEncoding
    if (typeof data === 'string' && encoding !== 'utf8') {
      throw new Error(`Unsupported encoding: ${encoding}`)
    }
    const bytes =
      typeof data === 'string' ? new TextEncoder().encode(data) : data
    const fd = this.open(pathStr, options?.flag ?? 'w', options?.mode ?? 0o100666)
    try {
      this.write(fd, bytes, 0, bytes.length, 0)
    } finally {
      this.close(fd)
    }
  }

  write(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number {
    const file = this.requireOpenFile(fd)
    if (file.isDirectory) {
      throw this.createError('EISDIR', `write '${file.path}'`)
    }
    if (!file.flags.write) {
      throw this.createError('EBADF', `write '${file.path}'`)
    }

    const inode = this.requireInode(file.ino)
    const start = file.flags.append ? inode.size : resolvePosition(file, position)
    let cursor = start
    let bytesWritten = 0

    while (bytesWritten < length) {
      const chunkIndex = Math.floor(cursor / inode.chunk_size)
      const chunkOffset = cursor % inode.chunk_size
      const bytesToCopy = Math.min(length - bytesWritten, inode.chunk_size - chunkOffset)
      const existing = this.getChunkPayloadSync(inode.ino, chunkIndex)
      const nextLength = Math.max(existing?.data.length ?? 0, chunkOffset + bytesToCopy)
      const chunk = new Uint8Array(nextLength)
      if (existing?.data) {
        chunk.set(existing.data)
      }
      chunk.set(
        buffer.subarray(offset + bytesWritten, offset + bytesWritten + bytesToCopy),
        chunkOffset,
      )

      const payload = { meta: existing?.meta ?? null, data: chunk }
      this.dirtyChunks.set(chunkKey(inode.ino, chunkIndex), payload)
      this.batch.markTableCreated(inode.ino)
      this.batch.upsertChunk(inode.ino, chunkIndex, payload)

      bytesWritten += bytesToCopy
      cursor += bytesToCopy
    }

    inode.size = Math.max(inode.size, start + bytesWritten)
    touchInode(inode)
    this.batch.upsertInode(cloneInode(inode))
    file.position = start + bytesWritten
    return bytesWritten
  }

  private onBrokerMessage = (event: MessageEvent<PgdarqAfsBrokerResponseMessage>): void => {
    const message = event.data
    if (!message || typeof message.id !== 'number') {
      return
    }

    const pending = this.pendingRequests.get(message.id)
    if (!pending) {
      return
    }

    this.pendingRequests.delete(message.id)
    if (message.ok) {
      pending.resolve(message.payload)
    } else {
      pending.reject(new Error(message.error?.message ?? 'Unknown broker error'))
    }
  }

  private async callBroker<T>(request: PgdarqAfsBrokerRequestMessage): Promise<T> {
    if (!this.brokerEndpoint) {
      throw new Error('PgdarqAFS broker worker is not initialized')
    }

    return await new Promise<T>((resolve, reject) => {
      this.pendingRequests.set(request.id, { resolve: resolve as (value: unknown) => void, reject })
      this.brokerEndpoint!.postMessage(request)
    })
  }

  private hydrateSnapshot(snapshot: PgdarqAfsSnapshot): void {
    this.inodes.clear()
    this.children.clear()

    for (const inode of snapshot.inodes) {
      this.inodes.set(inode.ino, cloneInode(inode))
      if (isDirectoryMode(inode.mode)) {
        this.children.set(inode.ino, new Map<string, number>())
      }
    }

    for (const dentry of snapshot.dentries) {
      let children = this.children.get(dentry.parent_ino)
      if (!children) {
        children = new Map<string, number>()
        this.children.set(dentry.parent_ino, children)
      }
      children.set(dentry.name, dentry.ino)
    }

    if (!this.inodes.has(PGDARQ_ROOT_INO)) {
      throw new Error('PgdarqAFS snapshot is missing the root inode')
    }

    this.nextIno = snapshot.nextIno
  }

  private getChunkPayloadSync(ino: number, chunkIndex: number): PgdarqAfsChunkPayload | null {
    const key = chunkKey(ino, chunkIndex)
    const dirty = this.dirtyChunks.get(key)
    if (dirty) {
      return dirty
    }

    if (!this.syncChannel || !this.brokerEndpoint) {
      return null
    }

    encodeSyncRequest(this.syncChannel, {
      kind: 'readChunk',
      ino,
      chunkIndex,
    })
    this.brokerEndpoint.postMessage({ type: 'pgdarq-afs:sync' })

    const control = new Int32Array(this.syncChannel.control)
    const result = Atomics.wait(control, 0, PGDARQ_SYNC_STATE_IDLE, 10000)
    if (result === 'timed-out') {
      throw this.createError('EIO', `Timed out reading chunk ${ino}:${chunkIndex}`)
    }
    return decodeSyncResponse(this.syncChannel).payload
  }

  private requireOpenFile(fd: number): OpenFile {
    const file = this.openFiles.get(fd)
    if (!file) {
      throw this.createError('EBADF', `fd '${fd}'`)
    }
    return file
  }

  private requireInode(ino: number): PgdarqAfsInodeRecord {
    const inode = this.inodes.get(ino)
    if (!inode) {
      throw this.createError('ENOENT', `ino '${ino}'`)
    }
    return inode
  }

  private lookupPath(pathStr: string): PgdarqAfsInodeRecord | null {
    const path = normalizeFsPath(pathStr, this.cwd)
    if (path === '/') {
      return this.requireInode(PGDARQ_ROOT_INO)
    }

    let current = PGDARQ_ROOT_INO
    for (const segment of splitPath(path)) {
      const next = this.children.get(current)?.get(segment)
      if (next === undefined) {
        return null
      }
      current = next
    }
    return this.requireInode(current)
  }

  private getInodeByPath(pathStr: string): PgdarqAfsInodeRecord {
    const inode = this.lookupPath(pathStr)
    if (!inode) {
      throw this.createError('ENOENT', `path '${normalizeFsPath(pathStr, this.cwd)}'`)
    }
    return inode
  }

  private getParentEntry(pathStr: string, allowMissingParent = false): { name: string; parentIno: number } {
    const path = normalizeFsPath(pathStr, this.cwd)
    if (path === '/') {
      throw this.createError('EINVAL', `path '${path}'`)
    }
    const parentPath = dirname(path)
    const name = basename(path)
    const parent = this.lookupPath(parentPath)
    if (!parent) {
      if (allowMissingParent) {
        return { name, parentIno: this.ensurePathParents(path) }
      }
      throw this.createError('ENOENT', `parent '${parentPath}'`)
    }
    return { name, parentIno: parent.ino }
  }

  private ensurePathParents(pathStr: string): number {
    let parentIno = PGDARQ_ROOT_INO
    let current = '/'
    for (const segment of splitPath(dirname(pathStr))) {
      current = joinPath(current, segment)
      const existing = this.lookupPath(current)
      if (existing) {
        parentIno = existing.ino
        continue
      }
      const created = this.createDirectory(current, 0o040755)
      parentIno = created.ino
    }
    return parentIno
  }

  private createDirectory(pathStr: string, mode: number): PgdarqAfsInodeRecord {
    const { parentIno, name } = this.getParentEntry(pathStr, false)
    if (this.children.get(parentIno)?.has(name)) {
      throw this.createError('EEXIST', `mkdir '${pathStr}'`)
    }

    const inode = this.createInode(mode | 0o040000)
    this.inodes.set(inode.ino, inode)
    this.children.set(inode.ino, new Map<string, number>())
    this.children.get(parentIno)?.set(name, inode.ino)
    this.batch.upsertInode(cloneInode(inode))
    this.batch.upsertDentry({ name, parent_ino: parentIno, ino: inode.ino })
    return inode
  }

  private createFile(pathStr: string, mode: number): PgdarqAfsInodeRecord {
    const parentIno = this.ensurePathParents(pathStr)
    const name = basename(normalizeFsPath(pathStr, this.cwd))
    const children = this.children.get(parentIno) ?? new Map<string, number>()
    if (children.has(name)) {
      throw this.createError('EEXIST', `create '${pathStr}'`)
    }

    const inode = this.createInode((mode & 0o7777) | 0o100000)
    this.inodes.set(inode.ino, inode)
    children.set(name, inode.ino)
    this.children.set(parentIno, children)
    this.batch.upsertInode(cloneInode(inode))
    this.batch.upsertDentry({ name, parent_ino: parentIno, ino: inode.ino })
    return inode
  }

  private createInode(mode: number): PgdarqAfsInodeRecord {
    const now = Math.floor(Date.now() / 1000)
    return {
      ino: this.nextIno++,
      mode,
      nlink: 1,
      uid: 0,
      gid: 0,
      size: 0,
      atime: now,
      mtime: now,
      ctime: now,
      rdev: 0,
      atime_nsec: 0,
      mtime_nsec: 0,
      ctime_nsec: 0,
      chunk_size: this.options.chunkSize ?? 8192,
      header: null,
    }
  }

  private truncateInode(ino: number, len: number): void {
    if (len < 0) {
      throw this.createError('EINVAL', `truncate '${ino}'`)
    }

    const inode = this.requireInode(ino)
    const oldChunkCount = Math.ceil(inode.size / inode.chunk_size)
    const newChunkCount = Math.ceil(len / inode.chunk_size)

    for (let chunkIndex = newChunkCount; chunkIndex < oldChunkCount; chunkIndex++) {
      this.dirtyChunks.delete(chunkKey(ino, chunkIndex))
      this.batch.deleteChunk(ino, chunkIndex)
    }

    if (len > 0 && len % inode.chunk_size !== 0) {
      const chunkIndex = Math.floor((len - 1) / inode.chunk_size)
      const payload = this.getChunkPayloadSync(ino, chunkIndex)
      if (payload) {
        const trimmed = {
          meta: payload.meta,
          data: payload.data.subarray(0, len % inode.chunk_size),
        }
        this.dirtyChunks.set(chunkKey(ino, chunkIndex), trimmed)
        this.batch.markTableCreated(ino)
        this.batch.upsertChunk(ino, chunkIndex, trimmed)
      }
    }

    inode.size = len
    touchInode(inode)
    this.batch.upsertInode(cloneInode(inode))
  }

  private pathExists(pathStr: string): boolean {
    return this.lookupPath(pathStr) !== null
  }

  private toFsStats(inode: PgdarqAfsInodeRecord): FsStats {
    return {
      dev: 0,
      ino: inode.ino,
      mode: inode.mode,
      nlink: inode.nlink,
      uid: inode.uid,
      gid: inode.gid,
      rdev: inode.rdev,
      size: inode.size,
      blksize: inode.chunk_size,
      blocks: Math.ceil(inode.size / 512),
      atime: inode.atime,
      mtime: inode.mtime,
      ctime: inode.ctime,
    }
  }

  private createError(
    code: keyof typeof ERRNO_CODES | 'EIO',
    message: string,
  ): FilesystemError {
    const errno = code === 'EIO' ? EIO : ERRNO_CODES[code]
    return Object.assign(new Error(`${code}: ${message}`), {
      pgSymbol: code,
      codeSym: code,
      code,
      errno,
    })
  }
}

function chunkKey(ino: number, chunkIndex: number): string {
  return `${ino}:${chunkIndex}`
}

function cloneInode(inode: PgdarqAfsInodeRecord): PgdarqAfsInodeRecord {
  return {
    ...inode,
    header: inode.header ? new Uint8Array(inode.header) : null,
  }
}

function touchInode(inode: PgdarqAfsInodeRecord): void {
  const now = Math.floor(Date.now() / 1000)
  inode.mtime = now
  inode.ctime = now
}

function resolvePosition(file: OpenFile, position: number): number {
  if (position === undefined || position === null || position < 0) {
    return file.position
  }
  return position
}

function parseFlags(flags: string | number): ParsedFlags {
  if (typeof flags === 'string') {
    return {
      append: flags.includes('a'),
      create: flags.includes('w') || flags.includes('a'),
      exclusive: flags.includes('x'),
      read: flags.includes('+') || flags.includes('r'),
      truncate: flags.includes('w'),
      write: flags.includes('w') || flags.includes('a') || flags.includes('+'),
    }
  }

  return {
    append: (flags & O_APPEND) === O_APPEND,
    create: (flags & O_CREAT) === O_CREAT,
    exclusive: (flags & O_EXCL) === O_EXCL,
    read: (flags & O_RDWR) === O_RDWR || (flags & O_WRONLY) !== O_WRONLY,
    truncate: (flags & O_TRUNC) === O_TRUNC,
    write: (flags & O_WRONLY) === O_WRONLY || (flags & O_RDWR) === O_RDWR,
  }
}

function normalizeFsPath(pathStr: string, cwd = '/'): string {
  let path = pathStr
  if (!path.startsWith('/')) {
    path = joinPath(cwd, path)
  }

  const parts: string[] = []
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') {
      continue
    }
    if (segment === '..') {
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  return '/' + parts.join('/')
}

function splitPath(pathStr: string): string[] {
  const normalized = normalizeFsPath(pathStr)
  if (normalized === '/') {
    return []
  }
  return normalized.slice(1).split('/')
}

function dirname(pathStr: string): string {
  const parts = splitPath(pathStr)
  if (parts.length <= 1) {
    return '/'
  }
  return '/' + parts.slice(0, -1).join('/')
}

function basename(pathStr: string): string {
  const parts = splitPath(pathStr)
  return parts[parts.length - 1] ?? ''
}

function joinPath(base: string, child: string): string {
  return normalizeFsPath(`${base}/${child}`)
}

function sanitizeDatabaseName(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'pgdarq-afs'
}

function isDirectoryMode(mode: number): boolean {
  return (mode & 0o170000) === 0o040000
}
