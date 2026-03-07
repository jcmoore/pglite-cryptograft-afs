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

  try {
    const pushText = fs.graftPush()
    console.log('[publish] graft push:', pushText)
  } finally {
    await fs.destroy()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
