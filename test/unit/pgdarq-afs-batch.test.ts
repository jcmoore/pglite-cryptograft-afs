import { describe, expect, it } from 'vitest'
import { PgdarqAfsBatchBuilder } from '../../src/pgdarq-afs-batch.js'
import type { PgdarqAfsInodeRecord } from '../../src/pgdarq-afs-schema.js'

const baseInode: PgdarqAfsInodeRecord = {
  ino: 2,
  mode: 0o100644,
  nlink: 1,
  uid: 0,
  gid: 0,
  size: 0,
  atime: 1,
  mtime: 1,
  ctime: 1,
  rdev: 0,
  atime_nsec: 0,
  mtime_nsec: 0,
  ctime_nsec: 0,
  chunk_size: 8192,
  header: null,
}

describe('PgdarqAfsBatchBuilder', () => {
  it('coalesces inode, dentry, and chunk updates', () => {
    const batch = new PgdarqAfsBatchBuilder()
    batch.markTableCreated(2)
    batch.upsertInode(baseInode)
    batch.upsertDentry({ name: 'file', parent_ino: 1, ino: 2 })
    batch.upsertChunk(2, 0, {
      meta: null,
      data: new Uint8Array([1, 2, 3]),
    })

    const result = batch.build()
    expect(result.createdTables).toEqual([2])
    expect(result.upsertInodes).toHaveLength(1)
    expect(result.upsertDentries).toHaveLength(1)
    expect(result.upsertChunks).toHaveLength(1)
  })

  it('drops superseded writes when a delete wins', () => {
    const batch = new PgdarqAfsBatchBuilder()
    batch.upsertChunk(2, 0, {
      meta: null,
      data: new Uint8Array([1]),
    })
    batch.deleteChunk(2, 0)
    batch.upsertDentry({ name: 'file', parent_ino: 1, ino: 2 })
    batch.deleteDentry(1, 'file')
    batch.upsertInode(baseInode)
    batch.deleteInode(2)

    const result = batch.build()
    expect(result.upsertChunks).toHaveLength(0)
    expect(result.deletedChunks).toEqual([{ ino: 2, chunkIndex: 0 }])
    expect(result.upsertDentries).toHaveLength(0)
    expect(result.deletedDentries).toEqual([{ parentIno: 1, name: 'file' }])
    expect(result.upsertInodes).toHaveLength(0)
    expect(result.deletedInodes).toEqual([2])
  })
})
