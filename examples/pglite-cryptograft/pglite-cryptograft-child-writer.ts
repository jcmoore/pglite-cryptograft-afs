import { PGlite } from '@electric-sql/pglite'
import { CryptograftAFS } from '../../src/index.js'
import {
  buildExamplePaths,
  loadExampleEnv,
  writerSwitchExpr,
} from './pglite-cryptograft-utils.js'

async function main(): Promise<void> {
  const env = loadExampleEnv()
  const paths = buildExamplePaths(env.exampleRoot)

  const fs = new CryptograftAFS(paths.clientOnePgliteDir, env.cryptograftPassphrase, {
    sqlitePageSize: env.sqlitePageSize,
    chunkSize: env.chunkSize,
    sqliteLibraryPath: env.sqlite3mcPath,
    graftExtensionPath: env.graftExtPath,
    graftTag: env.graftTag,
    graftSwitch: writerSwitchExpr(env),
    graftRemoteType: 'fs',
    graftRemoteRoot: paths.remoteRoot,
  })

  let db: PGlite | null = null

  try {
    db = await PGlite.create({ dataDir: paths.clientOnePgliteDir, fs })

    await db.exec(`
      CREATE TABLE sync_demo (
        id INTEGER PRIMARY KEY,
        payload TEXT NOT NULL
      );
    `)

    await db.exec(`
      INSERT INTO sync_demo (id, payload) VALUES
      (1, 'alpha'),
      (2, 'beta'),
      (3, 'gamma');
    `)

    console.log('[writer] seeded client-1 pglite data')
    console.log('[writer] graft info:', fs.graftInfo())
  } finally {
    if (db) await db.close()
    await fs.destroy()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
