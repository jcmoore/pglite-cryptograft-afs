import { connect } from '@tursodatabase/database-wasm'
import { describe, expect, it } from 'vitest'
import { canInstallPgdarqAFSHost } from '../../src/browser.js'

const opfsReproIt = (await canInstallPgdarqAFSHost()) ? it.fails : it.skip

describe('Turso OPFS browser repro', () => {
  opfsReproIt('reopens after a large write', async () => {
    const databaseName = `turso-opfs-reopen-${crypto.randomUUID()}.db`
    const expected = createBlob(16_384, 17)

    const db = await connect(databaseName)
    await db.exec('CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)')
    await db.prepare('INSERT INTO chunks (id, payload) VALUES (?, ?)').run(1, expected)
    await db.close()

    const reopened = await connect(databaseName)
    const row = (await reopened.prepare('SELECT payload FROM chunks WHERE id = 1').get()) as
      | { payload: Uint8Array }
      | undefined
    await reopened.close()

    expect(row?.payload).toEqual(expected)
  })

  opfsReproIt('reopens after a truncate-related WAL workflow', async () => {
    const databaseName = `turso-opfs-truncate-${crypto.randomUUID()}.db`
    const original = createBlob(16_384, 23)
    const truncated = createBlob(4_097, 91)

    const db = await connect(databaseName)
    await db.exec('CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)')
    await db.prepare('INSERT INTO chunks (id, payload) VALUES (?, ?)').run(1, original)
    await db.prepare('UPDATE chunks SET payload = ? WHERE id = 1').run(truncated)
    await db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    await db.close()

    const reopened = await connect(databaseName)
    const row = (await reopened.prepare('SELECT payload FROM chunks WHERE id = 1').get()) as
      | { payload: Uint8Array }
      | undefined
    await reopened.close()

    expect(row?.payload).toEqual(truncated)
  })
})

function createBlob(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = (seed + i * 31) % 256
  }
  return bytes
}
