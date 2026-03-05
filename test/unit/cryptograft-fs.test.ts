import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Database as BunDatabase } from 'bun:sqlite'
import * as path from 'node:path'
import {
  createTestDir,
  cleanupTestDir,
  createCryptograftAFS,
} from '../helpers/test-utils.js'

describe('CryptograftAFS', () => {
  let testDir: string

  beforeEach(() => {
    testDir = createTestDir()
  })

  afterEach(() => {
    cleanupTestDir(testDir)
  })

  it('creates and reads a file', () => {
    const fs = createCryptograftAFS(testDir)

    const fd = fs.open('/hello.txt', 'w')
    const data = Buffer.from('hello cryptograft')
    fs.write(fd, data, 0, data.length, 0)
    fs.close(fd)

    const fd2 = fs.open('/hello.txt', 'r')
    const out = new Uint8Array(data.length)
    const n = fs.read(fd2, out, 0, out.length, 0)
    fs.close(fd2)

    expect(n).toBe(data.length)
    expect(Buffer.from(out).toString()).toBe('hello cryptograft')
  })

  it('supports sparse writes and zero-filled reads', () => {
    const fs = createCryptograftAFS(testDir)

    const fd = fs.open('/sparse.bin', 'w')
    const data = Buffer.from([1, 2, 3, 4])
    fs.write(fd, data, 0, data.length, 8192)
    fs.close(fd)

    const fd2 = fs.open('/sparse.bin', 'r')
    const out = new Uint8Array(8200)
    const n = fs.read(fd2, out, 0, out.length, 0)
    fs.close(fd2)

    expect(n).toBe(8196)
    expect(out.slice(0, 8192).every((b) => b === 0)).toBe(true)
    expect(Array.from(out.slice(8192, 8196))).toEqual([1, 2, 3, 4])
  })

  it('persists data across filesystem instances', () => {
    const fs1 = createCryptograftAFS(testDir)
    const fd1 = fs1.open('/persist.txt', 'w')
    const data = Buffer.from('persist me')
    fs1.write(fd1, data, 0, data.length, 0)
    fs1.close(fd1)

    void fs1.closeFs()

    const fs2 = createCryptograftAFS(testDir)
    const fd2 = fs2.open('/persist.txt', 'r')
    const out = new Uint8Array(data.length)
    const n = fs2.read(fd2, out, 0, out.length, 0)
    fs2.close(fd2)

    expect(n).toBe(data.length)
    expect(Buffer.from(out).toString()).toBe('persist me')
  })

  it('renames and unlinks files correctly', () => {
    const fs = createCryptograftAFS(testDir)

    fs.writeFile('/a.txt', 'abc')
    fs.rename('/a.txt', '/b.txt')

    const fd = fs.open('/b.txt', 'r')
    const out = new Uint8Array(3)
    fs.read(fd, out, 0, 3, 0)
    fs.close(fd)
    expect(Buffer.from(out).toString()).toBe('abc')

    fs.unlink('/b.txt')
    expect(() => fs.open('/b.txt', 'r')).toThrow()
  })

  it('initializes metadata sqlite with 64KB page size', async () => {
    const fs = createCryptograftAFS(testDir)
    await fs.closeFs()

    const dbPath = path.join(testDir, '.cryptograft-fs.sqlite')
    const db = new BunDatabase(dbPath)
    const row = db.query('PRAGMA page_size').get() as { page_size: number }
    db.close()

    expect(row.page_size).toBe(65536)
  })
})
