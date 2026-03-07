import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const EXAMPLE_NAME = 'pglite-cryptograft'

const DEFAULT_GRAFT_TAG = 'cryptograft-afs.main'
const DEFAULT_GRAFT_VOLUME_ID = '5rMJkfqcEt-2ei3bXFrcteHv'
const DEFAULT_GRAFT_WRITER_LOCAL_LOG_ID = '74ggc1B6R4-2kkvcy9fi4CHJ'
const DEFAULT_GRAFT_REPLICA_LOCAL_LOG_ID = '74ggc1o8bK-34EknTZT8mjSx'
const DEFAULT_GRAFT_REMOTE_LOG_ID = '74ggc1B6jg-2udz14pbDayZC'

export const EXPECTED_SYNC_ROWS = [
  { id: 1, payload: 'alpha' },
  { id: 2, payload: 'beta' },
  { id: 3, payload: 'gamma' },
]

export interface ExampleEnv {
  sqlite3mcPath: string
  graftExtPath: string
  sqliteKey: string
  sqliteCipher: string
  cryptograftPassphrase: string
  sqlitePageSize: number
  chunkSize: number
  exampleRoot: string
  graftTag: string
  graftVolumeId: string
  graftWriterLocalLogId: string
  graftReplicaLocalLogId: string
  graftRemoteLogId: string
}

export interface ExamplePaths {
  rootDir: string
  remoteRoot: string
  clientOneDir: string
  clientTwoDir: string
  clientOnePgliteDir: string
  clientTwoPgliteDir: string
  clientOneGraftStateDir: string
  clientTwoGraftStateDir: string
  clientOneGraftDataDir: string
  clientTwoGraftDataDir: string
  clientOneGraftConfigPath: string
  clientTwoGraftConfigPath: string
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing ${name}. Set ${name} before running this example.`)
  }
  return value
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got '${raw}'`)
  }
  return parsed
}

export function sqlQuote(value: string): string {
  return value.replace(/'/g, "''")
}

export function loadExampleEnv(): ExampleEnv {
  const sqlite3mcPath = requiredEnv('SQLITE3MC_DYLIB')
  const graftExtPath = requiredEnv('GRAFT_EXT_DYLIB')
  const sqliteKey = process.env.SQLITE3MC_KEY ?? 'cryptograft-demo-key'
  const sqliteCipher = process.env.SQLITE3MC_CIPHER ?? 'xchacha20'
  const cryptograftPassphrase =
    process.env.CRYPTOGRAFT_PASSPHRASE ?? sqliteKey
  const sqlitePageSize = parsePositiveIntEnv('CRYPTOGRAFT_SQLITE_PAGE_SIZE', 4096)
  const chunkSize = parsePositiveIntEnv('CRYPTOGRAFT_CHUNK_SIZE', 8192)

  const exampleRoot =
    process.env.CRYPTOGRAFT_EXAMPLE_ROOT ??
    path.resolve(process.cwd(), 'artifacts', 'examples', EXAMPLE_NAME)

  const graftTag = process.env.CRYPTOGRAFT_GRAFT_TAG ?? DEFAULT_GRAFT_TAG
  const graftVolumeId =
    process.env.CRYPTOGRAFT_GRAFT_VOLUME_ID ?? DEFAULT_GRAFT_VOLUME_ID
  const graftWriterLocalLogId =
    process.env.CRYPTOGRAFT_GRAFT_WRITER_LOCAL_LOG_ID ??
    DEFAULT_GRAFT_WRITER_LOCAL_LOG_ID
  const graftReplicaLocalLogId =
    process.env.CRYPTOGRAFT_GRAFT_REPLICA_LOCAL_LOG_ID ??
    DEFAULT_GRAFT_REPLICA_LOCAL_LOG_ID
  const graftRemoteLogId =
    process.env.CRYPTOGRAFT_GRAFT_REMOTE_LOG_ID ?? DEFAULT_GRAFT_REMOTE_LOG_ID

  return {
    sqlite3mcPath,
    graftExtPath,
    sqliteKey,
    sqliteCipher,
    cryptograftPassphrase,
    sqlitePageSize,
    chunkSize,
    exampleRoot,
    graftTag,
    graftVolumeId,
    graftWriterLocalLogId,
    graftReplicaLocalLogId,
    graftRemoteLogId,
  }
}

export function buildExamplePaths(exampleRoot: string): ExamplePaths {
  const rootDir = path.resolve(exampleRoot)
  const remoteRoot = path.join(rootDir, 'remote-fs')

  const clientOneDir = path.join(rootDir, 'client-1')
  const clientTwoDir = path.join(rootDir, 'client-2')

  const clientOnePgliteDir = path.join(clientOneDir, 'pglite')
  const clientTwoPgliteDir = path.join(clientTwoDir, 'pglite')
  const clientOneGraftStateDir = path.join(clientOnePgliteDir, '.cryptograft-graft')
  const clientTwoGraftStateDir = path.join(clientTwoPgliteDir, '.cryptograft-graft')
  const clientOneGraftDataDir = path.join(clientOneGraftStateDir, 'data')
  const clientTwoGraftDataDir = path.join(clientTwoGraftStateDir, 'data')
  const clientOneGraftConfigPath = path.join(clientOneGraftStateDir, 'graft.toml')
  const clientTwoGraftConfigPath = path.join(clientTwoGraftStateDir, 'graft.toml')

  return {
    rootDir,
    remoteRoot,
    clientOneDir,
    clientTwoDir,
    clientOnePgliteDir,
    clientTwoPgliteDir,
    clientOneGraftStateDir,
    clientTwoGraftStateDir,
    clientOneGraftDataDir,
    clientTwoGraftDataDir,
    clientOneGraftConfigPath,
    clientTwoGraftConfigPath,
  }
}

export function prepareExampleLayout(paths: ExamplePaths): void {
  rmSync(paths.rootDir, { recursive: true, force: true })

  mkdirSync(paths.rootDir, { recursive: true })
  mkdirSync(paths.remoteRoot, { recursive: true })
  mkdirSync(paths.clientOnePgliteDir, { recursive: true })
  mkdirSync(paths.clientTwoPgliteDir, { recursive: true })
  mkdirSync(paths.clientOneGraftDataDir, { recursive: true })
  mkdirSync(paths.clientTwoGraftDataDir, { recursive: true })

  writeFileSync(
    paths.clientOneGraftConfigPath,
    `data_dir = "${paths.clientOneGraftDataDir}"\n\n[remote]\ntype = "fs"\nroot = "${paths.remoteRoot}"\n`,
  )
  writeFileSync(
    paths.clientTwoGraftConfigPath,
    `data_dir = "${paths.clientTwoGraftDataDir}"\n\n[remote]\ntype = "fs"\nroot = "${paths.remoteRoot}"\n`,
  )
}

export function writerSwitchExpr(env: ExampleEnv): string {
  return `${env.graftVolumeId}:${env.graftWriterLocalLogId}:${env.graftRemoteLogId}`
}

export function replicaSwitchExpr(env: ExampleEnv): string {
  return `${env.graftVolumeId}:${env.graftReplicaLocalLogId}:${env.graftRemoteLogId}`
}
