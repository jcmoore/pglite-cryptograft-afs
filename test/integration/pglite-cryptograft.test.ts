import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createTestDir,
  cleanupTestDir,
  createCryptograftPGlite,
  reopenCryptograftPGlite,
} from '../helpers/test-utils.js'

describe('PGlite CryptograftAFS Integration', () => {
  let testDir: string

  beforeEach(() => {
    testDir = createTestDir()
  })

  afterEach(() => {
    cleanupTestDir(testDir)
  })

  it('creates table and roundtrips data', async () => {
    const { db } = await createCryptograftPGlite(testDir)

    await db.exec(`
      CREATE TABLE items (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL
      );
      INSERT INTO items (name) VALUES ('one'), ('two');
    `)

    const result = await db.query('SELECT name FROM items ORDER BY id')
    expect(result.rows).toEqual([{ name: 'one' }, { name: 'two' }])

    await db.close()
  })

  it('persists data across reopen', async () => {
    {
      const { db } = await createCryptograftPGlite(testDir)
      await db.exec(`
        CREATE TABLE persist_test (
          id SERIAL PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO persist_test (value) VALUES ('kept');
      `)
      await db.close()
    }

    {
      const { db } = await reopenCryptograftPGlite(testDir)
      const result = await db.query('SELECT value FROM persist_test')
      expect(result.rows).toEqual([{ value: 'kept' }])
      await db.close()
    }
  })
})
