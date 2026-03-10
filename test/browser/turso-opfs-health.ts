import { connect } from '@tursodatabase/database-wasm'
import { canInstallPgdarqAFSHost } from '../../src/browser.js'

export async function canReopenTursoOpfsDatabase(): Promise<boolean> {
  if (!(await canInstallPgdarqAFSHost())) {
    return false
  }

  const databaseName = `turso-opfs-health-${crypto.randomUUID()}.db`

  try {
    const db = await connect(databaseName)
    await db.exec('CREATE TABLE IF NOT EXISTS healthcheck (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)')
    await db.prepare('INSERT INTO healthcheck (id, payload) VALUES (?, ?)').run(
      1,
      createBlob(8_192, 13),
    )
    await db.close()

    const reopened = await connect(databaseName)
    await reopened.close()
    return true
  } catch {
    return false
  }
}

function createBlob(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = (seed + i * 31) % 256
  }
  return bytes
}
