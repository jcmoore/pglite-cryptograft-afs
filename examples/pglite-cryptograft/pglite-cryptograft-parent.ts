import path from 'node:path'
import {
  EXAMPLE_NAME,
  buildExamplePaths,
  loadExampleEnv,
  prepareExampleLayout,
} from './pglite-cryptograft-utils.js'

function runChildProcess(childFilename: string, childEnv: Record<string, string>): void {
  const childPath = path.join(import.meta.dir, childFilename)
  const proc = Bun.spawnSync({
    cmd: ['bun', childPath],
    env: childEnv,
    stdout: 'inherit',
    stderr: 'inherit',
  })

  if (proc.exitCode !== 0) {
    throw new Error(`Child failed (${childFilename}) with exit code ${proc.exitCode}`)
  }
}

async function main(): Promise<void> {
  const env = loadExampleEnv()
  const paths = buildExamplePaths(env.exampleRoot)

  prepareExampleLayout(paths)

  const childEnv: Record<string, string> = {
    ...process.env,
    SQLITE3MC_DYLIB: env.sqlite3mcPath,
    GRAFT_EXT_DYLIB: env.graftExtPath,
    SQLITE3MC_KEY: env.sqliteKey,
    SQLITE3MC_CIPHER: env.sqliteCipher,
    CRYPTOGRAFT_PASSPHRASE: env.cryptograftPassphrase,
    CRYPTOGRAFT_SQLITE_PAGE_SIZE: String(env.sqlitePageSize),
    CRYPTOGRAFT_CHUNK_SIZE: String(env.chunkSize),
    CRYPTOGRAFT_EXAMPLE_ROOT: paths.rootDir,
    CRYPTOGRAFT_GRAFT_TAG: env.graftTag,
    CRYPTOGRAFT_GRAFT_VOLUME_ID: env.graftVolumeId,
    CRYPTOGRAFT_GRAFT_WRITER_LOCAL_LOG_ID: env.graftWriterLocalLogId,
    CRYPTOGRAFT_GRAFT_REPLICA_LOCAL_LOG_ID: env.graftReplicaLocalLogId,
    CRYPTOGRAFT_GRAFT_REMOTE_LOG_ID: env.graftRemoteLogId,
  }

  const clientOneEnv: Record<string, string> = {
    ...childEnv,
    GRAFT_CONFIG: paths.clientOneGraftConfigPath,
  }
  const clientTwoEnv: Record<string, string> = {
    ...childEnv,
    GRAFT_CONFIG: paths.clientTwoGraftConfigPath,
  }

  console.log(`[${EXAMPLE_NAME}] artifacts root: ${paths.rootDir}`)
  console.log(`[${EXAMPLE_NAME}] step 1/4: writer`)
  runChildProcess('pglite-cryptograft-child-writer.ts', clientOneEnv)

  console.log(`[${EXAMPLE_NAME}] step 2/4: publish`)
  runChildProcess('pglite-cryptograft-child-publish.ts', clientOneEnv)

  console.log(`[${EXAMPLE_NAME}] step 3/4: replica`)
  runChildProcess('pglite-cryptograft-child-replica.ts', clientTwoEnv)

  console.log(`[${EXAMPLE_NAME}] step 4/4: verify`)
  runChildProcess('pglite-cryptograft-child-verify.ts', clientTwoEnv)

  console.log(`[${EXAMPLE_NAME}] complete`)
  console.log(`[${EXAMPLE_NAME}] inspect artifacts under: ${paths.rootDir}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
