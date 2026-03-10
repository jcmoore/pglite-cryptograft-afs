import { describe, expect, it } from 'vitest'
import {
  createRootInode,
  dataTableName,
  getSchemaStatements,
  normalizeChunkSize,
  PGDARQ_AFS_SCHEMA_VERSION,
  PGDARQ_DEFAULT_CHUNK_SIZE,
  PGDARQ_ROOT_INO,
} from '../../src/pgdarq-afs-schema.js'

describe('pgdarq-afs schema helpers', () => {
  it('normalizes chunk size defaults and rejects invalid values', () => {
    expect(normalizeChunkSize()).toBe(PGDARQ_DEFAULT_CHUNK_SIZE)
    expect(normalizeChunkSize(4096)).toBe(4096)
    expect(() => normalizeChunkSize(0)).toThrow(/Invalid chunk size/)
  })

  it('produces per-inode table names', () => {
    expect(dataTableName(1)).toBe('fs_data_inode_1')
    expect(() => dataTableName(0)).toThrow(/Invalid inode/)
  })

  it('includes versioned schema statements and root inode defaults', () => {
    const statements = getSchemaStatements()
    expect(statements.join('\n')).toContain('fs_inode')
    expect(statements.join('\n')).toContain('header BLOB NULL')

    const root = createRootInode(123)
    expect(root.ino).toBe(PGDARQ_ROOT_INO)
    expect(root.chunk_size).toBe(PGDARQ_DEFAULT_CHUNK_SIZE)
    expect(PGDARQ_AFS_SCHEMA_VERSION).toBe(1)
  })
})
