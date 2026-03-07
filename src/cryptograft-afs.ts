import {
  BaseFilesystem,
  type FsStats,
  ERRNO_CODES,
} from '@electric-sql/pglite/basefs'
import type { PGlite } from '@electric-sql/pglite'
import { Database as BunDatabase } from 'bun:sqlite'
import sodium from 'libsodium-wrappers-sumo'
import { pbkdf2Sync, randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

const EIO = 5

const S_IFMT = 0o170000
const S_IFREG = 0o100000
const S_IFDIR = 0o040000

const DEFAULT_DIR_MODE = S_IFDIR | 0o755
const DEFAULT_CHUNK_SIZE = 8192
const DEFAULT_SQLITE_PAGE_SIZE = 4096
const DEFAULT_GRAFT_TAG = 'cryptograft-afs.main'
const DEFAULT_GRAFT_STATE_DIRNAME = '.cryptograft-graft'
const ALLOWED_SQLITE_PAGE_SIZES = new Set([4096, 8192, 16384, 32768, 65536])
const CHUNK_HEADER_SALT_SIZE = 16
const CHUNK_HEADER_FILE_ID_SIZE = 32
const CHUNK_HEADER_SIZE = CHUNK_HEADER_SALT_SIZE + CHUNK_HEADER_FILE_ID_SIZE
const CHUNK_NONCE_SIZE = 24
const CHUNK_TAG_SIZE = 16
const CHUNK_META_SIZE = CHUNK_NONCE_SIZE + CHUNK_TAG_SIZE
const KDF_ITERATIONS = 256000
const KDF_DIGEST = 'sha512'
const VERIFICATION_TOKEN_NAME = '.encryption-verify'
const VERIFICATION_MAGIC = Buffer.from('CRYPTOGRAFT_VERIFY_V1')

const O_WRONLY = 1
const O_RDWR = 2
const O_CREAT = 64
const O_EXCL = 128
const O_TRUNC = 512
const O_APPEND = 1024

const WASM_PREFIX = '/tmp/pglite'
const PGDATA = WASM_PREFIX + '/base'
let bunSQLiteInitialized = false
let configuredSQLiteLibraryPath: string | null = null

await sodium.ready

interface EmModule {
  FS: EmFS
  HEAP8: Int8Array
  mmapAlloc(length: number): number
}

interface EmFS {
  isDir(mode: number): boolean
  isFile(mode: number): boolean
  createNode(
    parent: EmNode | null,
    name: string,
    mode: number,
    dev: number,
  ): EmNode
  ErrnoError: new (errno: number) => Error
  mkdir(path: string): void
  mount(
    type: unknown,
    opts: Record<string, unknown>,
    mountpoint: string,
  ): void
}

interface EmNode {
  id: number
  rdev: number
  name: string
  parent: EmNode
  mount: { opts: { root?: string } }
  node_ops: unknown
  stream_ops: unknown
  mode: number
}

interface EmStream {
  node: EmNode
  flags: number
  position: number
  nfd?: number
  shared?: { refcount: number }
}

interface EmNodeAttr {
  mode?: number
  size?: number
  timestamp?: number
}

interface FilesystemError extends Error {
  pgSymbol: string
  codeSym: string
  code: string
  errno: number
}

interface InodeRow {
  ino: number
  mode: number
  nlink: number
  uid: number
  gid: number
  size: number
  atime: number
  mtime: number
  ctime: number
  rdev: number
  chunk_size: number
}

interface OpenFile {
  ino: number
  path: string
  flags: string
  position: number
  mode: number
  size: number
  chunkSize: number
  isDir: boolean
}

interface FileHeaderParts {
  salt: Buffer
  fileId: Buffer
}

interface FileCryptoContext {
  fileId: Buffer
}

export interface CryptograftAFSOptions {
  debug?: boolean
  sqliteLibraryPath?: string
  sqlitePageSize?: number
  chunkSize?: number
  initializeSchema?: boolean
  pragmas?: string[]
  graftExtensionPath?: string
  graftTag?: string
  graftSwitch?: string
  graftConfigPath?: string
  graftDataDir?: string
  graftRemoteType?: 'memory' | 'fs'
  graftRemoteRoot?: string
}

function resolveSqlitePageSize(value: number | undefined): number {
  const pageSize = value ?? DEFAULT_SQLITE_PAGE_SIZE
  if (!ALLOWED_SQLITE_PAGE_SIZES.has(pageSize)) {
    throw new Error(
      `Unsupported sqlitePageSize '${pageSize}'. Allowed values: 4096, 8192, 16384, 32768, 65536.`,
    )
  }
  return pageSize
}

function emFlagsToNode(flags: number | string): string {
  if (typeof flags === 'string') {
    return flags
  }

  const isWrite = (flags & O_WRONLY) === O_WRONLY
  const isReadWrite = (flags & O_RDWR) === O_RDWR
  const isAppend = (flags & O_APPEND) === O_APPEND
  const isTrunc = (flags & O_TRUNC) === O_TRUNC
  const isCreate = (flags & O_CREAT) === O_CREAT
  const isExcl = (flags & O_EXCL) === O_EXCL

  let base: string
  if (isAppend) {
    base = isReadWrite ? 'a+' : 'a'
  } else if (isTrunc) {
    base = isReadWrite ? 'w+' : isWrite ? 'w' : 'w'
  } else if (isCreate && isWrite && !isReadWrite) {
    base = 'w'
  } else if (isReadWrite) {
    base = 'r+'
  } else if (isWrite) {
    base = 'w'
  } else {
    base = 'r'
  }

  if (isExcl && isCreate) {
    if (base === 'w') base = 'wx'
    else if (base === 'w+') base = 'wx+'
    else if (base === 'a') base = 'ax'
    else if (base === 'a+') base = 'ax+'
  }

  return base
}

function chunkTableName(ino: number): string {
  return `fs_data_inode_${Math.trunc(ino)}`
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function tomlEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function sqlEscape(value: string): string {
  return value.replace(/'/g, "''")
}

function buildChunkAad(fileId: Buffer, chunkIndex: number): Buffer {
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    throw new Error(`Invalid chunk index: ${chunkIndex}`)
  }
  const indexBuf = Buffer.alloc(8)
  indexBuf.writeBigUInt64BE(BigInt(chunkIndex))
  return Buffer.concat([fileId, indexBuf])
}

function parseChunkMeta(meta: Uint8Array): { nonce: Buffer; tag: Buffer } {
  const buf = Buffer.from(meta)
  if (buf.length !== CHUNK_META_SIZE) {
    throw new Error(`Invalid chunk meta length: ${buf.length}`)
  }
  return {
    nonce: buf.subarray(0, CHUNK_NONCE_SIZE),
    tag: buf.subarray(CHUNK_NONCE_SIZE),
  }
}

function buildChunkMeta(nonce: Buffer, tag: Buffer): Buffer {
  if (nonce.length !== CHUNK_NONCE_SIZE) {
    throw new Error(`Invalid nonce length: ${nonce.length}`)
  }
  if (tag.length !== CHUNK_TAG_SIZE) {
    throw new Error(`Invalid auth tag length: ${tag.length}`)
  }
  return Buffer.concat([nonce, tag])
}

function parseFileHeader(header: Uint8Array): FileHeaderParts {
  const buf = Buffer.from(header)
  if (buf.length !== CHUNK_HEADER_SIZE) {
    throw new Error(`Invalid fs_inode.header length: ${buf.length}`)
  }
  return {
    salt: buf.subarray(0, CHUNK_HEADER_SALT_SIZE),
    fileId: buf.subarray(CHUNK_HEADER_SALT_SIZE),
  }
}

export function initializeCryptograftDatabase(
  baseDir: string,
  options: CryptograftAFSOptions,
  sqlitePageSize: number
): BunDatabase {
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true })
  }

  const graftStateDir = path.join(baseDir, DEFAULT_GRAFT_STATE_DIRNAME)
  const graftDataDir = options.graftDataDir ?? path.join(graftStateDir, 'data')
  const graftConfigPath =
    options.graftConfigPath ?? path.join(graftStateDir, 'graft.toml')
  const graftRemoteType =
    options.graftRemoteType ?? (options.graftRemoteRoot ? 'fs' : 'memory')
  const graftRemoteRoot = options.graftRemoteRoot ?? path.join(graftStateDir, 'remote')

  if (!fs.existsSync(path.dirname(graftConfigPath))) {
    fs.mkdirSync(path.dirname(graftConfigPath), { recursive: true })
  }
  if (!fs.existsSync(graftDataDir)) {
    fs.mkdirSync(graftDataDir, { recursive: true })
  }
  if (graftRemoteType === 'fs' && !fs.existsSync(graftRemoteRoot)) {
    fs.mkdirSync(graftRemoteRoot, { recursive: true })
  }

  if (!fs.existsSync(graftConfigPath)) {
    const remoteConfig =
      graftRemoteType === 'fs'
        ? `[remote]\ntype = "fs"\nroot = "${tomlEscape(graftRemoteRoot)}"\n`
        : `[remote]\ntype = "memory"\n`
    fs.writeFileSync(
      graftConfigPath,
      `data_dir = "${tomlEscape(graftDataDir)}"\n\n${remoteConfig}`,
    )
  }

  process.env.GRAFT_CONFIG = graftConfigPath
  process.env.GRAFT_DATA_DIR = graftDataDir
  process.env.GRAFT_REMOTE__TYPE = graftRemoteType
  if (graftRemoteType === 'fs') {
    process.env.GRAFT_REMOTE__ROOT = graftRemoteRoot
  } else {
    delete process.env.GRAFT_REMOTE__ROOT
  }

  const graftExtensionPath = options.graftExtensionPath ?? process.env.GRAFT_EXT_DYLIB
  if (!graftExtensionPath) {
    throw new Error(
      'CryptograftAFS requires graft extension path. Set options.graftExtensionPath (or GRAFT_EXT_DYLIB).',
    )
  }

  if (options.sqliteLibraryPath) {
    if (configuredSQLiteLibraryPath) {
      if (configuredSQLiteLibraryPath !== options.sqliteLibraryPath) {
        throw new Error(
          `Custom SQLite already configured with '${configuredSQLiteLibraryPath}'. ` +
            `Requested '${options.sqliteLibraryPath}'.`,
        )
      }
    } else if (bunSQLiteInitialized) {
      throw new Error(
        'Cannot set custom SQLite after SQLite has already been initialized. ' +
          'Construct CryptograftAFS with sqliteLibraryPath before opening any SQLite databases.',
      )
    } else {
      BunDatabase.setCustomSQLite(options.sqliteLibraryPath)
      configuredSQLiteLibraryPath = options.sqliteLibraryPath
    }
  }

  const bootstrap = new BunDatabase(':memory:')
  bootstrap.loadExtension(graftExtensionPath)
  bootstrap.close()

  const graftTag = options.graftTag ?? DEFAULT_GRAFT_TAG
  const dbUri = `file:${graftTag}?vfs=graft`
  const db = new BunDatabase(dbUri)
  bunSQLiteInitialized = true

  if (options.graftSwitch) {
    db.exec(`PRAGMA graft_switch = '${sqlEscape(options.graftSwitch)}';`)
  }

  for (const pragma of options.pragmas ?? []) {
    db.exec(pragma)
  }

  const hasSchema = db
    .query("SELECT 1 as one FROM sqlite_master WHERE type='table' AND name='fs_inode'")
    .get() as { one: number } | undefined
  if (!hasSchema) {
    db.exec(`PRAGMA page_size=${sqlitePageSize};`)
  }
  db.exec('PRAGMA journal_mode=MEMORY; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;')

  return db
}

export function initializeSchema(db: BunDatabase): BunDatabase {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fs_inode (
      ino INTEGER PRIMARY KEY AUTOINCREMENT,
      mode INTEGER NOT NULL,
      nlink INTEGER NOT NULL DEFAULT 0,
      uid INTEGER NOT NULL DEFAULT 0,
      gid INTEGER NOT NULL DEFAULT 0,
      size INTEGER NOT NULL DEFAULT 0,
      atime INTEGER NOT NULL,
      mtime INTEGER NOT NULL,
      ctime INTEGER NOT NULL,
      rdev INTEGER NOT NULL DEFAULT 0,
      chunk_size INTEGER NOT NULL DEFAULT ${DEFAULT_CHUNK_SIZE},
      header BLOB NULL
    );

    CREATE TABLE IF NOT EXISTS fs_dentry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      parent_ino INTEGER NOT NULL,
      ino INTEGER NOT NULL,
      UNIQUE(parent_ino, name)
    );

    CREATE INDEX IF NOT EXISTS idx_fs_dentry_parent
    ON fs_dentry(parent_ino, name);

    CREATE TABLE IF NOT EXISTS fs_symlink (
      ino INTEGER PRIMARY KEY,
      target TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fs_config (
      key TEXT PRIMARY KEY CHECK (key IN ('schema_version')),
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fs_verification (
      name TEXT PRIMARY KEY CHECK (name IN ('.encryption-verify')),
      header BLOB NOT NULL CHECK (length(header) = ${CHUNK_HEADER_SIZE}),
      meta BLOB NOT NULL CHECK (length(meta) = ${CHUNK_META_SIZE}),
      data BLOB NOT NULL
    );
  `)

  db
    .query(`
      INSERT OR REPLACE INTO fs_config (key, value)
      VALUES ('schema_version', '0.5-cryptograft-basefs')
    `)
    .run()

  const root = db
    .query('SELECT ino FROM fs_inode WHERE ino = 1')
    .get() as { ino: number } | undefined

  if (!root) {
    const now = nowSec()
    db
      .query(`
        INSERT INTO fs_inode (ino, mode, nlink, uid, gid, size, atime, mtime, ctime, chunk_size, header)
        VALUES (1, ?, 1, 0, 0, 0, ?, ?, ?, 0, NULL)
      `)
      .run(DEFAULT_DIR_MODE, now, now, now)
  }

  return db;
}

export class CryptograftAFS extends BaseFilesystem {
  private readonly db: BunDatabase
  private readonly chunkSize: number
  private readonly sqlitePageSize: number
  private cryptoSalt: Buffer
  private keys : { encKey: Buffer }
  private readonly fileCryptoCache = new Map<number, FileCryptoContext>()
  private openFiles: Map<number, OpenFile> = new Map()
  private cwd = '/'
  private nextFd = 100

  private destroyed = false

  constructor(dataDir: string, passphrase: string, options: CryptograftAFSOptions = {}, db?: BunDatabase) {
    super(dataDir, options.debug === undefined ? {} : { debug: options.debug })

    const baseDir = this.dataDir ?? dataDir
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE
    this.sqlitePageSize = resolveSqlitePageSize(options.sqlitePageSize)

    if (db) {
      const hasVerificationTable = db
        .query("SELECT 1 as one FROM sqlite_master WHERE type='table' AND name='fs_verification'")
        .get() as { one: number } | undefined

      if (!hasVerificationTable) {
        throw this.createError('EIO', "Pre-initialized database is missing required table 'fs_verification'")
      }

      this.db = db;
    } else {
      this.db = initializeSchema(
        initializeCryptograftDatabase(
          baseDir,
          options,
          this.sqlitePageSize
        )
      );
    }

    const existingVerificationHeader = this.db
      .query('SELECT header FROM fs_verification WHERE name = ?')
      .get(VERIFICATION_TOKEN_NAME) as { header: Uint8Array } | undefined

    if (existingVerificationHeader) {
      const parsedHeader = parseFileHeader(existingVerificationHeader.header)
      this.cryptoSalt = Buffer.from(parsedHeader.salt)
    } else if (!db) {
      this.cryptoSalt = Buffer.from(randomBytes(CHUNK_HEADER_SALT_SIZE))
    } else {
      throw this.createError('EIO', "Pre-initialized database is missing '.encryption-verify' token")
    }

    this.keys = {
      encKey: pbkdf2Sync(
        passphrase,
        this.cryptoSalt,
        KDF_ITERATIONS,
        sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
        KDF_DIGEST,
      )
    }

    this.verifyOrCreateToken()

    if (this.debug) {
      console.log('CryptograftAFS initialized with dataDir:', baseDir)
    }
  }

  /**
   * Zeros key material from memory. Call this after closing PGlite.
   * While JavaScript cannot guarantee complete erasure (the GC may have
   * copied data), this reduces the window of exposure in heap dumps.
   */
  destroy(): void {
    if (this.destroyed) return

    this.keys.encKey.fill(0)
    this.cryptoSalt.fill(0)

    for (const context of this.fileCryptoCache.values()) {
      context.fileId.fill(0)
    }

    this.fileCryptoCache.clear()

    this.db.close()

    this.destroyed = true
  }

  /**
   * On first init, creates a verification token.
   * On reopen, decrypts it to verify the passphrase is correct.
   * Throws immediately if the passphrase is wrong.
   */
  private verifyOrCreateToken(): void {
    const row = this.db
      .query('SELECT header, meta, data FROM fs_verification WHERE name = ?')
      .get(VERIFICATION_TOKEN_NAME) as
      | { header: Uint8Array; meta: Uint8Array; data: Uint8Array }
      | undefined

    if (!row) {
      const existingUserData = this.db
        .query('SELECT 1 as one FROM fs_inode WHERE ino > 1 LIMIT 1')
        .get() as { one: number } | undefined

      if (existingUserData) {
        throw new Error('Invalid passphrase or corrupted encryption keys')
      }

      const fileId = Buffer.from(randomBytes(CHUNK_HEADER_FILE_ID_SIZE))
      const header = Buffer.concat([this.cryptoSalt, fileId])
      const nonce = Buffer.from(randomBytes(CHUNK_NONCE_SIZE))
      const aad = buildChunkAad(fileId, 0)
      const encrypted = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt_detached(
        VERIFICATION_MAGIC,
        aad,
        null,
        nonce,
        this.keys.encKey,
      )
      const meta = buildChunkMeta(nonce, Buffer.from(encrypted.mac))
      const data = Buffer.from(encrypted.ciphertext)

      this.db
        .query('INSERT INTO fs_verification (name, header, meta, data) VALUES (?, ?, ?, ?)')
        .run(VERIFICATION_TOKEN_NAME, header, meta, data)
    } else {
      try {
        const parsedHeader = parseFileHeader(row.header)
        if (!parsedHeader.salt.equals(this.cryptoSalt)) {
          throw new Error('Verification token salt mismatch')
        }
  
        const parsedMeta = parseChunkMeta(row.meta)
        const aad = buildChunkAad(Buffer.from(parsedHeader.fileId), 0)
        const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt_detached(
          null,
          row.data,
          parsedMeta.tag,
          aad,
          parsedMeta.nonce,
          this.keys.encKey,
        )
  
        if (!Buffer.from(plaintext).equals(VERIFICATION_MAGIC)) {
          throw new Error('Verification token mismatch')
        }
      } catch (cause) {
        throw Object.assign(
          new Error('Invalid passphrase or corrupted encryption keys'),
          { cause },
        )
      }
    }
  }

  private graftPragma(name: string): string {
    const row = this.db.query(`PRAGMA ${name};`).get() as Record<string, unknown> | null
    if (!row) return ''
    const first = Object.values(row)[0]
    return typeof first === 'string' ? first : String(first)
  }

  graftPush(): string {
    return this.graftPragma('graft_push')
  }

  graftPull(): string {
    return this.graftPragma('graft_pull')
  }

  graftInfo(): string {
    return this.graftPragma('graft_info')
  }

  private newFileHeaderBlob(): Buffer {
    const fileId = Buffer.from(randomBytes(CHUNK_HEADER_FILE_ID_SIZE))
    return Buffer.concat([this.cryptoSalt, fileId])
  }

  private loadFileCryptoContext(ino: number, createHeaderIfMissing: boolean): FileCryptoContext | null {
    const cached = this.fileCryptoCache.get(ino)
    if (cached) {
      return cached
    }

    const row = this.db
      .query('SELECT header FROM fs_inode WHERE ino = ?')
      .get(ino) as { header: Uint8Array | null } | undefined
    if (!row) {
      throw this.createError('ENOENT', `inode ${ino} not found`)
    }

    let headerBlob = row.header
    if (!headerBlob) {
      if (!createHeaderIfMissing) {
        return null
      }
      const newHeader = this.newFileHeaderBlob()
      this.db.query('UPDATE fs_inode SET header = ? WHERE ino = ?').run(newHeader, ino)
      headerBlob = newHeader
    }

    const parsed = parseFileHeader(headerBlob)
    if (!parsed.salt.equals(this.cryptoSalt)) {
      throw this.createError(
        'EIO',
        `Header salt mismatch for inode ${ino}; unsupported database format`,
      )
    }

    const context: FileCryptoContext = {
      fileId: Buffer.from(parsed.fileId),
    }
    this.fileCryptoCache.set(ino, context)
    return context
  }

  private resetFileCryptoContext(ino: number): void {
    const existing = this.fileCryptoCache.get(ino)
    if (!existing) return
    existing.fileId.fill(0)
    this.fileCryptoCache.delete(ino)
  }

  private encryptChunk(plaintext: Buffer, chunkIndex: number, context: FileCryptoContext): { meta: Buffer; data: Buffer } {
    const key = this.keys.encKey
    const nonce = Buffer.from(randomBytes(CHUNK_NONCE_SIZE))
    const aad = buildChunkAad(context.fileId, chunkIndex)
    const encrypted = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt_detached(
      plaintext,
      aad,
      null,
      nonce,
      key,
    )
    return {
      meta: buildChunkMeta(nonce, Buffer.from(encrypted.mac)),
      data: Buffer.from(encrypted.ciphertext),
    }
  }

  private decryptChunk(
    ciphertext: Uint8Array,
    meta: Uint8Array,
    chunkIndex: number,
    context: FileCryptoContext,
  ): Buffer {
    const key = this.keys.encKey
    const parsed = parseChunkMeta(meta)
    const aad = buildChunkAad(context.fileId, chunkIndex)
    const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt_detached(
      null,
      ciphertext,
      parsed.tag,
      aad,
      parsed.nonce,
      key,
    )
    return Buffer.from(plaintext)
  }

  private normalizePath(p: string): string {
    if (!p) return '/'
    if (!p.startsWith('/')) {
      p = path.join(this.cwd, p)
    }
    const normalized = path.posix.normalize(p.replace(/\\/g, '/'))
    return normalized === '' ? '/' : normalized
  }

  chdir(newPath: string): void {
    this.cwd = this.normalizePath(newPath)
  }

  private splitPath(p: string): string[] {
    const normalized = this.normalizePath(p)
    if (normalized === '/') return []
    return normalized.split('/').filter(Boolean)
  }

  private resolvePathToIno(p: string): number | null {
    const normalized = this.normalizePath(p)
    if (normalized === '/') return 1

    const parts = this.splitPath(normalized)
    let current = 1
    const stmt = this.db.query(
      'SELECT ino FROM fs_dentry WHERE parent_ino = ? AND name = ?',
    )

    for (const part of parts) {
      const row = stmt.get(current, part) as { ino: number } | undefined
      if (!row) return null
      current = Number(row.ino)
    }
    return current
  }

  private resolveParent(p: string): { parentIno: number; name: string } | null {
    const normalized = this.normalizePath(p)
    if (normalized === '/') return null

    const parts = this.splitPath(normalized)
    const name = parts[parts.length - 1]
    if (!name) return null
    const parentPath = parts.length === 1 ? '/' : `/${parts.slice(0, -1).join('/')}`
    const parentIno = this.resolvePathToIno(parentPath)
    if (parentIno === null) return null
    return { parentIno, name }
  }

  private getInode(ino: number): InodeRow | null {
    const row = this.db
      .query(`
        SELECT ino, mode, nlink, uid, gid, size, atime, mtime, ctime, rdev, chunk_size
        FROM fs_inode
        WHERE ino = ?
      `)
      .get(ino) as InodeRow | undefined
    return row ?? null
  }

  private isDirMode(mode: number): boolean {
    return (mode & S_IFMT) === S_IFDIR
  }

  private isFileMode(mode: number): boolean {
    return (mode & S_IFMT) === S_IFREG
  }

  private ensureChunkTable(ino: number): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${chunkTableName(ino)} (
        chunk_index INTEGER PRIMARY KEY,
        meta BLOB NULL,
        data BLOB NOT NULL
      )
    `)
  }

  private dropChunkTable(ino: number): void {
    this.db.exec(`DROP TABLE IF EXISTS ${chunkTableName(ino)}`)
  }

  private createInode(mode: number): number {
    const now = nowSec()
    const header = this.isFileMode(mode) ? this.newFileHeaderBlob() : null
    const result = this.db
      .query(`
        INSERT INTO fs_inode (mode, nlink, uid, gid, size, atime, mtime, ctime, rdev, chunk_size, header)
        VALUES (?, 0, 0, 0, 0, ?, ?, ?, 0, ?, ?)
      `)
      .run(mode, now, now, now, this.chunkSize, header)

    const ino = Number(result.lastInsertRowid)
    if (this.isFileMode(mode)) {
      this.ensureChunkTable(ino)
    }
    return ino
  }

  private createDentry(parentIno: number, name: string, ino: number): void {
    this.db
      .query('INSERT INTO fs_dentry (name, parent_ino, ino) VALUES (?, ?, ?)')
      .run(name, parentIno, ino)
    this.db
      .query('UPDATE fs_inode SET nlink = nlink + 1 WHERE ino = ?')
      .run(ino)
  }

  private removeDentryAndMaybeInode(parentIno: number, name: string, ino: number): void {
    this.db
      .query('DELETE FROM fs_dentry WHERE parent_ino = ? AND name = ?')
      .run(parentIno, name)
    this.db.query('UPDATE fs_inode SET nlink = nlink - 1 WHERE ino = ?').run(ino)

    const row = this.db
      .query('SELECT mode, nlink FROM fs_inode WHERE ino = ?')
      .get(ino) as { mode: number; nlink: number } | undefined

    if (!row || row.nlink > 0) return

    if (this.isFileMode(row.mode)) {
      this.dropChunkTable(ino)
      this.resetFileCryptoContext(ino)
    }
    this.db.query('DELETE FROM fs_symlink WHERE ino = ?').run(ino)
    this.db.query('DELETE FROM fs_inode WHERE ino = ?').run(ino)
  }

  private getOpenFile(fd: number): OpenFile {
    const file = this.openFiles.get(fd)
    if (!file) {
      throw this.createError('EBADF', `fd ${fd} is not open`)
    }
    return file
  }

  open(pathStr: string, flags: string | number = 'r', mode = 0o666): number {
    if (this.destroyed) {
      throw this.createError('EIO', 'filesystem has been destroyed')
    }

    const normalized = this.normalizePath(pathStr)
    const nodeFlags = emFlagsToNode(flags)

    const createIfMissing = nodeFlags.includes('w') || nodeFlags.includes('a')
    const truncate = nodeFlags.startsWith('w')
    const exclusive = nodeFlags.includes('x')
    const append = nodeFlags.startsWith('a')

    const existingIno = this.resolvePathToIno(normalized)

    if (existingIno === null && !createIfMissing) {
      throw this.createError('ENOENT', `open '${normalized}'`)
    }

    let ino = existingIno

    this.db.exec('BEGIN')
    try {
      if (ino === null) {
        const parent = this.resolveParent(normalized)
        if (!parent) {
          throw this.createError('ENOENT', `open '${normalized}'`)
        }
        const parentInode = this.getInode(parent.parentIno)
        if (!parentInode || !this.isDirMode(parentInode.mode)) {
          throw this.createError('ENOTDIR', `open '${normalized}'`)
        }

        ino = this.createInode((mode & 0o777) | S_IFREG)
        this.createDentry(parent.parentIno, parent.name, ino)
      } else if (exclusive && createIfMissing) {
        throw this.createError('EEXIST', `open '${normalized}'`)
      }

      const inode = this.getInode(ino)
      if (!inode) {
        throw this.createError('ENOENT', `open '${normalized}'`)
      }

      if (truncate && this.isFileMode(inode.mode)) {
        this.ensureChunkTable(ino)
        this.db.query(`DELETE FROM ${chunkTableName(ino)}`).run()
        this.resetFileCryptoContext(ino)
        this.db
          .query('UPDATE fs_inode SET header = ? WHERE ino = ?')
          .run(this.newFileHeaderBlob(), ino)
        const now = nowSec()
        this.db
          .query('UPDATE fs_inode SET size = 0, mtime = ?, ctime = ? WHERE ino = ?')
          .run(now, now, ino)
      }

      this.db.exec('COMMIT')

      const refreshed = this.getInode(ino)
      if (!refreshed) {
        throw this.createError('ENOENT', `open '${normalized}'`)
      }

      const fd = this.nextFd++
      this.openFiles.set(fd, {
        ino,
        path: normalized,
        flags: nodeFlags,
        position: append ? refreshed.size : 0,
        mode: refreshed.mode,
        size: refreshed.size,
        chunkSize: refreshed.chunk_size || this.chunkSize,
        isDir: this.isDirMode(refreshed.mode),
      })
      return fd
    } catch (e) {
      this.db.exec('ROLLBACK')
      if (e instanceof Error && 'code' in e) {
        throw e
      }
      throw this.createError('EIO', `open '${normalized}'`, e)
    }
  }

  close(fd: number): void {
    this.getOpenFile(fd)
    this.openFiles.delete(fd)
  }

  read(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): number {
    if (this.destroyed) {
      throw this.createError('EIO', 'filesystem has been destroyed')
    }

    const file = this.getOpenFile(fd)
    if (file.isDir) {
      throw this.createError('EISDIR', 'read from directory')
    }

    const inode = this.getInode(file.ino)
    if (!inode) {
      throw this.createError('ENOENT', `read '${file.path}'`)
    }

    const logicalPos = position === null || position < 0 ? file.position : position
    if (logicalPos >= inode.size || length === 0) {
      return 0
    }

    const toRead = Math.min(length, inode.size - logicalPos)
    const chunkSize = inode.chunk_size || this.chunkSize
    const table = chunkTableName(file.ino)

    const out = Buffer.from(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength,
    )
    let copied = 0

    const cryptoContext = this.loadFileCryptoContext(file.ino, false)
    const selectStmt = this.db.query(
      `SELECT meta, data FROM ${table} WHERE chunk_index = ?`,
    )

    while (copied < toRead) {
      const absolute = logicalPos + copied
      const chunkIndex = Math.floor(absolute / chunkSize)
      const offsetInChunk = absolute % chunkSize
      const take = Math.min(toRead - copied, chunkSize - offsetInChunk)

      const row = selectStmt.get(chunkIndex) as
        | { meta: Uint8Array | null; data: Uint8Array }
        | undefined
      if (row?.data) {
        let chunk: Buffer
        if (row.meta) {
          if (!cryptoContext) {
            throw this.createError(
              'EIO',
              `Encrypted chunk found without passphrase for '${file.path}'`,
            )
          }
          try {
            chunk = Buffer.from(
              this.decryptChunk(row.data, row.meta, chunkIndex, cryptoContext),
            )
          } catch (cause) {
            throw this.createError('EIO', `Chunk authentication failed for '${file.path}'`, cause)
          }
        } else {
          chunk = Buffer.from(row.data)
        }
        if (offsetInChunk < chunk.length) {
          const available = Math.min(take, chunk.length - offsetInChunk)
          chunk.copy(out, offset + copied, offsetInChunk, offsetInChunk + available)
          if (available < take) {
            out.fill(0, offset + copied + available, offset + copied + take)
          }
        } else {
          out.fill(0, offset + copied, offset + copied + take)
        }
      } else {
        out.fill(0, offset + copied, offset + copied + take)
      }

      copied += take
    }

    file.position = logicalPos + copied
    file.size = inode.size
    file.chunkSize = chunkSize

    return copied
  }

  write(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): number {
    if (this.destroyed) {
      throw this.createError('EIO', 'filesystem has been destroyed')
    }

    const file = this.getOpenFile(fd)
    if (file.isDir) {
      throw this.createError('EISDIR', 'write to directory')
    }

    if (length === 0) return 0

    const inode = this.getInode(file.ino)
    if (!inode) {
      throw this.createError('ENOENT', `write '${file.path}'`)
    }

    let logicalPos = position === null || position < 0 ? file.position : position
    if (file.flags.startsWith('a')) {
      logicalPos = inode.size
    }

    const chunkSize = inode.chunk_size || this.chunkSize
    const table = chunkTableName(file.ino)
    this.ensureChunkTable(file.ino)

    const src = Buffer.from(buffer)
    let written = 0

    this.db.exec('BEGIN')
    try {
      const cryptoContext = this.loadFileCryptoContext(file.ino, true)
      const selectStmt = this.db.query(
        `SELECT meta, data FROM ${table} WHERE chunk_index = ?`,
      )
      const upsertStmt = this.db.query(`
        INSERT INTO ${table} (chunk_index, meta, data)
        VALUES (?, ?, ?)
        ON CONFLICT(chunk_index) DO UPDATE SET
          meta = excluded.meta,
          data = excluded.data
      `)

      while (written < length) {
        const absolute = logicalPos + written
        const chunkIndex = Math.floor(absolute / chunkSize)
        const offsetInChunk = absolute % chunkSize
        const take = Math.min(length - written, chunkSize - offsetInChunk)

        const existing = selectStmt.get(chunkIndex) as
          | { meta: Uint8Array | null; data: Uint8Array }
          | undefined

        let existingBuf = Buffer.alloc(0)
        if (existing?.data) {
          if (existing.meta) {
            if (!cryptoContext) {
              throw this.createError(
                'EIO',
                `Encrypted chunk found without passphrase for '${file.path}'`,
              )
            }
            try {
              existingBuf = Buffer.from(
                this.decryptChunk(existing.data, existing.meta, chunkIndex, cryptoContext),
              )
            } catch (cause) {
              throw this.createError('EIO', `Chunk authentication failed for '${file.path}'`, cause)
            }
          } else {
            existingBuf = Buffer.from(existing.data)
          }
        }

        const needed = offsetInChunk + take
        const chunk = Buffer.alloc(Math.max(existingBuf.length, needed))
        if (existingBuf.length) {
          existingBuf.copy(chunk)
        }

        src.copy(chunk, offsetInChunk, offset + written, offset + written + take)

        if (cryptoContext) {
          const encrypted = this.encryptChunk(chunk, chunkIndex, cryptoContext)
          upsertStmt.run(chunkIndex, encrypted.meta, encrypted.data)
        } else {
          upsertStmt.run(chunkIndex, null, chunk)
        }
        written += take
      }

      const newSize = Math.max(inode.size, logicalPos + written)
      const now = nowSec()
      this.db
        .query('UPDATE fs_inode SET size = ?, mtime = ?, ctime = ? WHERE ino = ?')
        .run(newSize, now, now, file.ino)

      this.db.exec('COMMIT')

      file.position = logicalPos + written
      file.size = newSize
      file.chunkSize = chunkSize
      return written
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw this.createError('EIO', `write '${file.path}'`, e)
    }
  }

  chmod(pathStr: string, mode: number): void {
    const normalized = this.normalizePath(pathStr)
    const ino = this.resolvePathToIno(normalized)
    if (ino === null) {
      throw this.createError('ENOENT', `chmod '${normalized}'`)
    }
    const inode = this.getInode(ino)
    if (!inode) {
      throw this.createError('ENOENT', `chmod '${normalized}'`)
    }
    const newMode = (inode.mode & S_IFMT) | (mode & 0o777)
    this.db.query('UPDATE fs_inode SET mode = ? WHERE ino = ?').run(newMode, ino)
  }

  fstat(fd: number): FsStats {
    const file = this.getOpenFile(fd)
    const inode = this.getInode(file.ino)
    if (!inode) {
      throw this.createError('ENOENT', `fstat '${file.path}'`)
    }
    return this.toFsStats(inode)
  }

  lstat(pathStr: string): FsStats {
    const normalized = this.normalizePath(pathStr)
    const ino = this.resolvePathToIno(normalized)
    if (ino === null) {
      throw this.createError('ENOENT', `stat '${normalized}'`)
    }
    const inode = this.getInode(ino)
    if (!inode) {
      throw this.createError('ENOENT', `stat '${normalized}'`)
    }
    return this.toFsStats(inode)
  }

  mkdir(pathStr: string, options?: { recursive?: boolean; mode?: number }): void {
    if (this.destroyed) {
      throw this.createError('EIO', 'filesystem has been destroyed')
    }

    const normalized = this.normalizePath(pathStr)
    if (normalized === '/') return

    const mode = (options?.mode ?? 0o755) | S_IFDIR

    if (options?.recursive) {
      const parts = this.splitPath(normalized)
      let current = 1
      for (const part of parts) {
        const existing = this.db
          .query('SELECT ino FROM fs_dentry WHERE parent_ino = ? AND name = ?')
          .get(current, part) as { ino: number } | undefined

        if (existing) {
          const inode = this.getInode(existing.ino)
          if (!inode || !this.isDirMode(inode.mode)) {
            throw this.createError('ENOTDIR', `mkdir '${normalized}'`)
          }
          current = existing.ino
          continue
        }

        this.db.exec('BEGIN')
        try {
          const ino = this.createInode(mode)
          this.createDentry(current, part, ino)
          this.db.exec('COMMIT')
          current = ino
        } catch (e) {
          this.db.exec('ROLLBACK')
          throw e
        }
      }
      return
    }

    if (this.resolvePathToIno(normalized) !== null) {
      throw this.createError('EEXIST', `mkdir '${normalized}'`)
    }

    const parent = this.resolveParent(normalized)
    if (!parent) {
      throw this.createError('ENOENT', `mkdir '${normalized}'`)
    }
    const parentInode = this.getInode(parent.parentIno)
    if (!parentInode || !this.isDirMode(parentInode.mode)) {
      throw this.createError('ENOTDIR', `mkdir '${normalized}'`)
    }

    this.db.exec('BEGIN')
    try {
      const ino = this.createInode(mode)
      this.createDentry(parent.parentIno, parent.name, ino)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw this.createError('EIO', `mkdir '${normalized}'`, e)
    }
  }

  readdir(pathStr: string): string[] {
    const normalized = this.normalizePath(pathStr)
    const ino = this.resolvePathToIno(normalized)
    if (ino === null) {
      throw this.createError('ENOENT', `readdir '${normalized}'`)
    }
    const inode = this.getInode(ino)
    if (!inode || !this.isDirMode(inode.mode)) {
      throw this.createError('ENOTDIR', `readdir '${normalized}'`)
    }

    const rows = this.db
      .query('SELECT name FROM fs_dentry WHERE parent_ino = ? ORDER BY name ASC')
      .all(ino) as { name: string }[]

    return rows.map((r) => r.name)
  }

  rename(oldPath: string, newPath: string): void {
    const oldNormalized = this.normalizePath(oldPath)
    const newNormalized = this.normalizePath(newPath)

    if (oldNormalized === '/' || newNormalized === '/') {
      throw this.createError('EINVAL', 'cannot rename root')
    }

    if (oldNormalized === newNormalized) {
      return
    }

    const oldParent = this.resolveParent(oldNormalized)
    const newParent = this.resolveParent(newNormalized)
    if (!oldParent || !newParent) {
      throw this.createError('ENOENT', `rename '${oldNormalized}'`)
    }

    const oldIno = this.resolvePathToIno(oldNormalized)
    if (oldIno === null) {
      throw this.createError('ENOENT', `rename '${oldNormalized}'`)
    }

    const oldInode = this.getInode(oldIno)
    if (!oldInode) {
      throw this.createError('ENOENT', `rename '${oldNormalized}'`)
    }

    const newParentInode = this.getInode(newParent.parentIno)
    if (!newParentInode || !this.isDirMode(newParentInode.mode)) {
      throw this.createError('ENOTDIR', `rename '${newNormalized}'`)
    }

    this.db.exec('BEGIN')
    try {
      const existingNewIno = this.resolvePathToIno(newNormalized)
      if (existingNewIno !== null) {
        const existingInode = this.getInode(existingNewIno)
        if (!existingInode) {
          throw this.createError('ENOENT', `rename '${newNormalized}'`)
        }

        if (this.isDirMode(existingInode.mode) && !this.isDirMode(oldInode.mode)) {
          throw this.createError('EISDIR', `rename '${newNormalized}'`)
        }
        if (!this.isDirMode(existingInode.mode) && this.isDirMode(oldInode.mode)) {
          throw this.createError('ENOTDIR', `rename '${newNormalized}'`)
        }

        if (this.isDirMode(existingInode.mode)) {
          const child = this.db
            .query('SELECT 1 as one FROM fs_dentry WHERE parent_ino = ? LIMIT 1')
            .get(existingNewIno) as { one: number } | undefined
          if (child) {
            throw this.createError('ENOTEMPTY', `rename '${newNormalized}'`)
          }
        }

        this.removeDentryAndMaybeInode(
          newParent.parentIno,
          newParent.name,
          existingNewIno,
        )
      }

      this.db
        .query(
          'UPDATE fs_dentry SET parent_ino = ?, name = ? WHERE parent_ino = ? AND name = ?',
        )
        .run(newParent.parentIno, newParent.name, oldParent.parentIno, oldParent.name)

      const now = nowSec()
      this.db
        .query('UPDATE fs_inode SET ctime = ? WHERE ino = ?')
        .run(now, oldIno)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      if (e instanceof Error && 'code' in e) {
        throw e
      }
      throw this.createError('EIO', `rename '${oldNormalized}'`, e)
    }
  }

  rmdir(pathStr: string): void {
    const normalized = this.normalizePath(pathStr)
    if (normalized === '/') {
      throw this.createError('EINVAL', 'cannot remove root')
    }

    const ino = this.resolvePathToIno(normalized)
    if (ino === null) {
      throw this.createError('ENOENT', `rmdir '${normalized}'`)
    }

    const inode = this.getInode(ino)
    if (!inode || !this.isDirMode(inode.mode)) {
      throw this.createError('ENOTDIR', `rmdir '${normalized}'`)
    }

    const child = this.db
      .query('SELECT 1 as one FROM fs_dentry WHERE parent_ino = ? LIMIT 1')
      .get(ino) as { one: number } | undefined
    if (child) {
      throw this.createError('ENOTEMPTY', `rmdir '${normalized}'`)
    }

    const parent = this.resolveParent(normalized)
    if (!parent) {
      throw this.createError('ENOENT', `rmdir '${normalized}'`)
    }

    this.db.exec('BEGIN')
    try {
      this.removeDentryAndMaybeInode(parent.parentIno, parent.name, ino)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw this.createError('EIO', `rmdir '${normalized}'`, e)
    }
  }

  truncate(pathStr: string, len: number): void {
    if (this.destroyed) {
      throw this.createError('EIO', 'filesystem has been destroyed')
    }

    if (len < 0) {
      throw this.createError('EINVAL', `truncate '${pathStr}'`)
    }

    const normalized = this.normalizePath(pathStr)
    const ino = this.resolvePathToIno(normalized)
    if (ino === null) {
      throw this.createError('ENOENT', `truncate '${normalized}'`)
    }

    const inode = this.getInode(ino)
    if (!inode) {
      throw this.createError('ENOENT', `truncate '${normalized}'`)
    }
    if (!this.isFileMode(inode.mode)) {
      throw this.createError('EISDIR', `truncate '${normalized}'`)
    }

    const table = chunkTableName(ino)
    const chunkSize = inode.chunk_size || this.chunkSize

    this.db.exec('BEGIN')
    try {
      const cryptoContext = this.loadFileCryptoContext(ino, false)
      if (len === 0) {
        this.db.query(`DELETE FROM ${table}`).run()
      } else if (len < inode.size) {
        const lastChunk = Math.floor((len - 1) / chunkSize)
        this.db
          .query(`DELETE FROM ${table} WHERE chunk_index > ?`)
          .run(lastChunk)

        const keep = len % chunkSize
        if (keep > 0) {
          const row = this.db
            .query(`SELECT meta, data FROM ${table} WHERE chunk_index = ?`)
            .get(lastChunk) as
              | { meta: Uint8Array | null; data: Uint8Array }
              | undefined
          if (row?.data) {
            let chunk: Buffer
            if (row.meta) {
              if (!cryptoContext) {
                throw this.createError(
                  'EIO',
                  `Encrypted chunk found without passphrase for '${normalized}'`,
                )
              }
              try {
                chunk = Buffer.from(
                  this.decryptChunk(row.data, row.meta, lastChunk, cryptoContext),
                )
              } catch (cause) {
                throw this.createError('EIO', `Chunk authentication failed for '${normalized}'`, cause)
              }
            } else {
              chunk = Buffer.from(row.data)
            }

            const truncated = chunk.subarray(0, keep)
            if (cryptoContext) {
              const encrypted = this.encryptChunk(truncated, lastChunk, cryptoContext)
              this.db
                .query(`UPDATE ${table} SET meta = ?, data = ? WHERE chunk_index = ?`)
                .run(encrypted.meta, encrypted.data, lastChunk)
            } else {
              this.db
                .query(`UPDATE ${table} SET meta = NULL, data = ? WHERE chunk_index = ?`)
                .run(truncated, lastChunk)
            }
          }
        }
      }

      const now = nowSec()
      this.db
        .query('UPDATE fs_inode SET size = ?, mtime = ?, ctime = ? WHERE ino = ?')
        .run(len, now, now, ino)
      this.db.exec('COMMIT')

      for (const file of this.openFiles.values()) {
        if (file.ino === ino) {
          file.size = len
          if (file.position > len) {
            file.position = len
          }
        }
      }
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw this.createError('EIO', `truncate '${normalized}'`, e)
    }
  }

  unlink(pathStr: string): void {
    const normalized = this.normalizePath(pathStr)
    if (normalized === '/') {
      throw this.createError('EINVAL', 'cannot unlink root')
    }

    const ino = this.resolvePathToIno(normalized)
    if (ino === null) {
      throw this.createError('ENOENT', `unlink '${normalized}'`)
    }

    const inode = this.getInode(ino)
    if (!inode) {
      throw this.createError('ENOENT', `unlink '${normalized}'`)
    }
    if (this.isDirMode(inode.mode)) {
      throw this.createError('EISDIR', `unlink '${normalized}'`)
    }

    const parent = this.resolveParent(normalized)
    if (!parent) {
      throw this.createError('ENOENT', `unlink '${normalized}'`)
    }

    this.db.exec('BEGIN')
    try {
      this.removeDentryAndMaybeInode(parent.parentIno, parent.name, ino)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw this.createError('EIO', `unlink '${normalized}'`, e)
    }
  }

  utimes(pathStr: string, atime: number, mtime: number): void {
    const normalized = this.normalizePath(pathStr)
    const ino = this.resolvePathToIno(normalized)
    if (ino === null) {
      throw this.createError('ENOENT', `utimes '${normalized}'`)
    }

    const toSec = (v: number) => (v > 1e12 ? Math.floor(v / 1000) : Math.floor(v))
    this.db
      .query('UPDATE fs_inode SET atime = ?, mtime = ? WHERE ino = ?')
      .run(toSec(atime), toSec(mtime), ino)
  }

  writeFile(
    pathStr: string,
    data: string | Uint8Array,
    options?: { encoding?: string; mode?: number; flag?: string },
  ): void {
    const fd = this.open(pathStr, options?.flag ?? 'w', options?.mode)
    try {
      const buffer =
        typeof data === 'string'
          ? Buffer.from(data, (options?.encoding as BufferEncoding) || 'utf8')
          : Buffer.from(data)
      this.write(fd, buffer, 0, buffer.length, 0)
    } finally {
      this.close(fd)
    }
  }

  private toFsStats(inode: InodeRow): FsStats {
    return {
      dev: 0,
      ino: inode.ino,
      mode: inode.mode,
      nlink: inode.nlink,
      uid: inode.uid,
      gid: inode.gid,
      rdev: inode.rdev,
      size: inode.size,
      blksize: inode.chunk_size || this.chunkSize,
      blocks: Math.ceil(inode.size / 512),
      atime: inode.atime,
      mtime: inode.mtime,
      ctime: inode.ctime,
    }
  }

  private createError(
    code: keyof typeof ERRNO_CODES | 'EIO',
    message: string,
    cause?: unknown,
  ): FilesystemError {
    const errno = code === 'EIO' ? EIO : ERRNO_CODES[code]
    return Object.assign(new Error(`${code}: ${message}`), {
      pgSymbol: code,
      codeSym: code,
      code,
      errno,
      ...(cause !== undefined && { cause }),
    })
  }

  fcntl(fd: number, cmd: number, arg?: unknown): number {
    if (this.debug) {
      console.log('fcntl stub', fd, cmd, arg)
    }
    return 0
  }

  flock(fd: number, operation: number): number {
    if (this.debug) {
      console.log('flock stub', fd, operation)
    }
    return 0
  }

  access(pathStr: string, _mode: number): number {
    try {
      this.lstat(pathStr)
      return 0
    } catch {
      return -1
    }
  }

  async init(
    pg: PGlite,
    emscriptenOptions: Parameters<BaseFilesystem['init']>[1],
  ): ReturnType<BaseFilesystem['init']> {
    this.pg = pg
    const options: Parameters<BaseFilesystem['init']>[1] = {
      ...emscriptenOptions,
      preRun: [
        ...(emscriptenOptions.preRun ?? []),
        (mod) => {
          const emMod = mod as unknown as EmModule
          const EMFS = this.createEmscriptenFS(emMod)
          emMod.FS.mkdir(PGDATA)
          emMod.FS.mount(EMFS, {}, PGDATA)
          if (this.debug) {
            console.log(`[CryptograftAFS] Mounted at ${PGDATA}`)
          }
        },
      ],
    }
    return { emscriptenOpts: options }
  }

  private createEmscriptenFS(Module: EmModule) {
    const FS = Module.FS
    const baseFS = this
    const log = this.debug ? console.log : null

    const EMFS = {
      tryFSOperation<T>(f: () => T): T {
        try {
          return f()
        } catch (e: unknown) {
          if (e instanceof Error && 'pgSymbol' in e) {
            const sym = (e as FilesystemError).pgSymbol
            const num =
              ERRNO_CODES[sym as keyof typeof ERRNO_CODES] ?? ERRNO_CODES.EINVAL
            throw new FS.ErrnoError(num)
          }
          if (e instanceof Error && 'errno' in e) {
            throw new FS.ErrnoError((e as FilesystemError).errno)
          }
          if (e instanceof Error && 'code' in e) {
            const code = (e as NodeJS.ErrnoException).code
            if (code === 'ENOENT') {
              throw new FS.ErrnoError(ERRNO_CODES.ENOENT)
            }
            if (
              code !== undefined &&
              ERRNO_CODES[code as keyof typeof ERRNO_CODES] !== undefined
            ) {
              throw new FS.ErrnoError(
                ERRNO_CODES[code as keyof typeof ERRNO_CODES],
              )
            }
          }
          throw new FS.ErrnoError(ERRNO_CODES.EINVAL)
        }
      },
      mount(_mount: unknown) {
        return EMFS.createNode(null, '/', 16384 | 511, 0)
      },
      syncfs(
        _mount: unknown,
        _populate: unknown,
        _done: (err?: number | null) => unknown,
      ): void {},
      createNode(
        parent: EmNode | null,
        name: string,
        mode: number,
        _dev?: unknown,
      ): EmNode {
        if (!FS.isDir(mode) && !FS.isFile(mode)) {
          throw new FS.ErrnoError(ERRNO_CODES.EINVAL)
        }
        const node: EmNode = FS.createNode(parent, name, mode, 0)
        node.node_ops = EMFS.node_ops
        node.stream_ops = EMFS.stream_ops
        return node
      },
      getMode(path: string): number {
        log?.('getMode', path)
        return EMFS.tryFSOperation(() => {
          if (path.startsWith('//')) {
            path = path.substring(1)
          }
          const stats = baseFS.lstat(path)
          return stats.mode
        })
      },
      realPath(node: EmNode): string {
        const parts: string[] = []
        while (node.parent !== node) {
          parts.push(node.name)
          node = node.parent
        }
        parts.push(node.mount.opts.root || '')
        parts.reverse()
        return parts.join('/').replace(/\/+/g, '/') || '/'
      },
      node_ops: {
        getattr: (node: EmNode) => {
          log?.('getattr', EMFS.realPath(node))
          const p = EMFS.realPath(node)
          return EMFS.tryFSOperation(() => {
            const stats = baseFS.lstat(p)
            return {
              ...stats,
              dev: 0,
              ino: node.id,
              nlink: 1,
              rdev: node.rdev,
              atime: new Date(stats.atime),
              mtime: new Date(stats.mtime),
              ctime: new Date(stats.ctime),
            }
          })
        },
        setattr: (node: EmNode, attr: EmNodeAttr) => {
          log?.('setattr', EMFS.realPath(node), attr)
          const p = EMFS.realPath(node)
          EMFS.tryFSOperation(() => {
            if (attr.mode !== undefined) {
              baseFS.chmod(p, attr.mode)
            }
            if (attr.size !== undefined) {
              baseFS.truncate(p, attr.size)
            }
            if (attr.timestamp !== undefined) {
              baseFS.utimes(p, attr.timestamp, attr.timestamp)
            }
          })
        },
        lookup: (parent: EmNode, name: string) => {
          log?.('lookup', EMFS.realPath(parent), name)
          const full = [EMFS.realPath(parent), name].join('/')
          const mode = EMFS.getMode(full)
          return EMFS.createNode(parent, name, mode)
        },
        mknod: (parent: EmNode, name: string, mode: number, dev: unknown) => {
          log?.('mknod', EMFS.realPath(parent), name, mode, dev)
          const node = EMFS.createNode(parent, name, mode, dev)
          const full = EMFS.realPath(node)
          return EMFS.tryFSOperation(() => {
            if (FS.isDir(mode)) {
              baseFS.mkdir(full, { mode })
            } else {
              baseFS.writeFile(full, '', { mode })
            }
            return node
          })
        },
        rename: (oldNode: EmNode, newDir: EmNode, newName: string) => {
          log?.('rename', EMFS.realPath(oldNode), EMFS.realPath(newDir), newName)
          const oldP = EMFS.realPath(oldNode)
          const newP = [EMFS.realPath(newDir), newName].join('/')
          EMFS.tryFSOperation(() => {
            baseFS.rename(oldP, newP)
          })
          oldNode.name = newName
        },
        unlink: (parent: EmNode, name: string) => {
          log?.('unlink', EMFS.realPath(parent), name)
          const p = [EMFS.realPath(parent), name].join('/')
          try {
            baseFS.unlink(p)
          } catch (e: unknown) {
            if (
              !(
                e instanceof Error &&
                'code' in e &&
                (e as NodeJS.ErrnoException).code === 'ENOENT'
              )
            ) {
              throw e
            }
          }
        },
        rmdir: (parent: EmNode, name: string) => {
          log?.('rmdir', EMFS.realPath(parent), name)
          const p = [EMFS.realPath(parent), name].join('/')
          return EMFS.tryFSOperation(() => {
            baseFS.rmdir(p)
          })
        },
        readdir: (node: EmNode) => {
          log?.('readdir', EMFS.realPath(node))
          const p = EMFS.realPath(node)
          return EMFS.tryFSOperation(() => {
            return baseFS.readdir(p)
          })
        },
        symlink: (_parent: EmNode, _newName: string, _oldPath: string) => {
          log?.('symlink - not supported')
          throw new FS.ErrnoError(63)
        },
        readlink: (_node: EmNode) => {
          log?.('readlink - not supported')
          throw new FS.ErrnoError(63)
        },
      },
      stream_ops: {
        open: (stream: EmStream) => {
          log?.('open stream', EMFS.realPath(stream.node))
          const p = EMFS.realPath(stream.node)
          return EMFS.tryFSOperation(() => {
            if (FS.isFile(stream.node.mode)) {
              stream.shared = stream.shared || { refcount: 1 }
              stream.shared.refcount = 1
              stream.nfd = baseFS.open(p, stream.flags, stream.node.mode & 0o777)
            }
          })
        },
        close: (stream: EmStream) => {
          log?.('close stream', EMFS.realPath(stream.node))
          return EMFS.tryFSOperation(() => {
            if (stream.nfd && stream.shared && --stream.shared.refcount === 0) {
              baseFS.close(stream.nfd)
            }
          })
        },
        dup: (stream: EmStream) => {
          log?.('dup stream', EMFS.realPath(stream.node))
          stream.shared!.refcount++
        },
        read: (
          stream: EmStream,
          buffer: Uint8Array,
          offset: number,
          length: number,
          position: number,
        ) => {
          log?.('read stream', EMFS.realPath(stream.node), offset, length, position)
          if (length === 0) return 0
          return EMFS.tryFSOperation(() =>
            baseFS.read(stream.nfd!, buffer, offset, length, position),
          )
        },
        write: (
          stream: EmStream,
          buffer: Uint8Array,
          offset: number,
          length: number,
          position: number,
        ) => {
          log?.('write stream', EMFS.realPath(stream.node), offset, length, position)
          return EMFS.tryFSOperation(() => {
            if (buffer.buffer) {
              const actual = new Uint8Array(
                buffer.buffer,
                buffer.byteOffset + offset,
                length,
              )
              return baseFS.write(stream.nfd!, actual, 0, length, position)
            }
            return baseFS.write(stream.nfd!, buffer, offset, length, position)
          })
        },
        llseek: (stream: EmStream, offset: number, whence: number) => {
          log?.('llseek stream', EMFS.realPath(stream.node), offset, whence)
          let pos = offset
          if (whence === 1) {
            pos += stream.position
          } else if (whence === 2) {
            EMFS.tryFSOperation(() => {
              const stat = baseFS.fstat(stream.nfd!)
              pos += stat.size
            })
          }
          if (pos < 0) {
            throw new FS.ErrnoError(28)
          }
          return pos
        },
        mmap: (
          stream: EmStream,
          length: number,
          position: number,
          _prot: unknown,
          _flags: unknown,
        ) => {
          log?.('mmap stream', EMFS.realPath(stream.node), length, position, _prot, _flags)
          if (!FS.isFile(stream.node.mode)) {
            throw new FS.ErrnoError(ERRNO_CODES.ENODEV)
          }

          const ptr = Module.mmapAlloc(length)
          const heap = new Uint8Array(
            Module.HEAP8.buffer,
            Module.HEAP8.byteOffset,
            Module.HEAP8.byteLength,
          )

          EMFS.stream_ops.read(stream, heap, ptr, length, position)
          return { ptr, allocated: true }
        },
        msync: (
          stream: EmStream,
          buffer: Uint8Array,
          offset: number,
          length: number,
          _mmapFlags: unknown,
        ) => {
          log?.('msync stream', EMFS.realPath(stream.node), offset, length, _mmapFlags)
          EMFS.stream_ops.write(stream, buffer, 0, length, offset)
          return 0
        },
      },
    }

    return EMFS
  }
}
