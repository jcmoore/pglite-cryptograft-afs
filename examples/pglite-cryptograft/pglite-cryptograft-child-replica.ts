import { CryptograftAFS, initializeCryptograftDatabase } from '../../src/cryptograft-afs.js'
import {
  buildExamplePaths,
  loadExampleEnv,
  replicaSwitchExpr,
} from './pglite-cryptograft-utils.js'

async function main(): Promise<void> {
  const env = loadExampleEnv()
  const paths = buildExamplePaths(env.exampleRoot)

  const db = initializeCryptograftDatabase(paths.clientTwoPgliteDir, {
    sqlitePageSize: env.sqlitePageSize,
    chunkSize: env.chunkSize,
    sqliteLibraryPath: env.sqlite3mcPath,
    graftExtensionPath: env.graftExtPath,
    graftTag: env.graftTag,
    graftSwitch: replicaSwitchExpr(env),
    graftRemoteType: 'fs',
    graftRemoteRoot: paths.remoteRoot,
  }, env.sqlitePageSize)
  let fs: CryptograftAFS | null = null

  try {
    const pullRow = db.query('PRAGMA graft_pull;').get() as Record<string, unknown> | null
    const pullText = pullRow ? String(Object.values(pullRow)[0]) : ''
    console.log('[replica] graft pull:', pullText)

    fs = new CryptograftAFS(
      paths.clientTwoPgliteDir,
      env.cryptograftPassphrase,
      {
        sqlitePageSize: env.sqlitePageSize,
        chunkSize: env.chunkSize,
      },
      db,
    )
  } finally {
    if (fs) {
      await fs.destroy()
    } else {
      db.close()
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
