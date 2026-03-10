export const PGDARQ_AFS_SCHEMA_VERSION = 1
export const PGDARQ_DEFAULT_CHUNK_SIZE = 8192
export const PGDARQ_ROOT_INO = 1

export interface PgdarqAfsInodeRecord {
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
  atime_nsec: number
  mtime_nsec: number
  ctime_nsec: number
  chunk_size: number
  header: Uint8Array | null
}

export interface PgdarqAfsDentryRecord {
  name: string
  parent_ino: number
  ino: number
}

export interface PgdarqAfsChunkRecord {
  ino: number
  chunkIndex: number
  meta: Uint8Array | null
  data: Uint8Array
}

export interface PgdarqAfsSnapshot {
  chunkSize: number
  schemaVersion: number
  nextIno: number
  inodes: PgdarqAfsInodeRecord[]
  dentries: PgdarqAfsDentryRecord[]
}

export interface PgdarqAfsChunkPayload {
  meta: Uint8Array | null
  data: Uint8Array
}

export interface PgdarqAfsDentryDelete {
  parentIno: number
  name: string
}

export interface PgdarqAfsFlushBatch {
  createdTables: number[]
  deletedInodes: number[]
  deletedChunks: Array<{ ino: number; chunkIndex: number }>
  deletedDentries: PgdarqAfsDentryDelete[]
  upsertInodes: PgdarqAfsInodeRecord[]
  upsertDentries: PgdarqAfsDentryRecord[]
  upsertChunks: PgdarqAfsChunkRecord[]
}

export function createEmptyFlushBatch(): PgdarqAfsFlushBatch {
  return {
    createdTables: [],
    deletedInodes: [],
    deletedChunks: [],
    deletedDentries: [],
    upsertInodes: [],
    upsertDentries: [],
    upsertChunks: [],
  }
}

export function dataTableName(ino: number): string {
  assertValidIno(ino)
  return `fs_data_inode_${ino}`
}

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

export function dataTableIdentifier(ino: number): string {
  return quoteIdentifier(dataTableName(ino))
}

export function assertValidIno(ino: number): void {
  if (!Number.isInteger(ino) || ino < 1) {
    throw new Error(`Invalid inode number: ${ino}`)
  }
}

export function normalizeChunkSize(chunkSize?: number): number {
  if (chunkSize === undefined) {
    return PGDARQ_DEFAULT_CHUNK_SIZE
  }
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error(`Invalid chunk size: ${chunkSize}`)
  }
  return chunkSize
}

export function getSchemaStatements(chunkSize = PGDARQ_DEFAULT_CHUNK_SIZE): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS fs_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS fs_inode (
      ino INTEGER PRIMARY KEY,
      mode INTEGER NOT NULL,
      nlink INTEGER NOT NULL DEFAULT 0,
      uid INTEGER NOT NULL DEFAULT 0,
      gid INTEGER NOT NULL DEFAULT 0,
      size INTEGER NOT NULL DEFAULT 0,
      atime INTEGER NOT NULL,
      mtime INTEGER NOT NULL,
      ctime INTEGER NOT NULL,
      rdev INTEGER NOT NULL DEFAULT 0,
      atime_nsec INTEGER NOT NULL DEFAULT 0,
      mtime_nsec INTEGER NOT NULL DEFAULT 0,
      ctime_nsec INTEGER NOT NULL DEFAULT 0,
      chunk_size INTEGER NOT NULL DEFAULT ${normalizeChunkSize(chunkSize)},
      header BLOB NULL
    )`,
    `CREATE TABLE IF NOT EXISTS fs_dentry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      parent_ino INTEGER NOT NULL,
      ino INTEGER NOT NULL,
      UNIQUE(parent_ino, name)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_fs_dentry_parent
      ON fs_dentry(parent_ino, name)`,
  ]
}

export function createRootInode(
  now = Math.floor(Date.now() / 1000),
  chunkSize = PGDARQ_DEFAULT_CHUNK_SIZE,
): PgdarqAfsInodeRecord {
  return {
    ino: PGDARQ_ROOT_INO,
    mode: 0o040755,
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
    chunk_size: chunkSize,
    header: null,
  }
}
