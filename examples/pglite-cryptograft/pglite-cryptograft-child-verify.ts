import { PGlite } from '@electric-sql/pglite'
import { CryptograftAFS } from '../../src/index.js'
import {
  EXPECTED_SYNC_ROWS,
  buildExamplePaths,
  loadExampleEnv,
  replicaSwitchExpr,
} from './pglite-cryptograft-utils.js'

async function main(): Promise<void> {
  const env = loadExampleEnv()
  const paths = buildExamplePaths(env.exampleRoot)

  const fs = new CryptograftAFS(paths.clientTwoPgliteDir, env.cryptograftPassphrase, {
    sqlitePageSize: env.sqlitePageSize,
    chunkSize: env.chunkSize,
    sqliteLibraryPath: env.sqlite3mcPath,
    graftExtensionPath: env.graftExtPath,
    graftTag: env.graftTag,
    graftSwitch: replicaSwitchExpr(env),
    graftRemoteType: 'fs',
    graftRemoteRoot: paths.remoteRoot,
  })

  let db: PGlite | null = null

  try {
    db = await PGlite.create({ dataDir: paths.clientTwoPgliteDir, fs })
    const result = await db.query<{ id: number; payload: string }>(
      'SELECT id, payload FROM sync_demo ORDER BY id',
    )

    if (JSON.stringify(result.rows) !== JSON.stringify(EXPECTED_SYNC_ROWS)) {
      throw new Error(
        `Unexpected replicated rows.\nExpected: ${JSON.stringify(EXPECTED_SYNC_ROWS)}\nActual: ${JSON.stringify(result.rows)}`,
      )
    }

    console.log('[verify] sqlite page_size:', env.sqlitePageSize)
    console.log('[verify] chunk_size:', env.chunkSize)
    console.log('[verify] rows:', result.rows)
    console.log('[verify] sync verified')
  } finally {
    if (db) await db.close()
    await fs.destroy()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
