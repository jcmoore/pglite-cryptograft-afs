import { PGlite } from '@electric-sql/pglite'
import { Database as BunDatabase } from 'bun:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CryptograftAFS } from '../src/index.js'

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing ${name}. Set ${name} before running this example.`)
  }
  return value
}

function sqlQuote(value: string): string {
  return value.replace(/'/g, "''")
}

function writeGraftConfig(
  configPath: string,
  dataDir: string,
  sharedRemoteRoot: string,
): void {
  writeFileSync(
    configPath,
    `data_dir = "${dataDir}"\n\n[remote]\ntype = "fs"\nroot = "${sharedRemoteRoot}"\n`,
  )
}

function runControlPragmas(options: {
  openUri: string
  graftConfigPath: string
  graftExtPath: string
  sqlite3mcPath: string
  pragmas: string[]
}): string[] {
  const helper = `
    import { Database } from 'bun:sqlite';
    const [openUri, graftExtPath, ...pragmas] = process.argv.slice(1);
    Database.setCustomSQLite(process.env.SQLITE3MC_DYLIB);
    const bootstrap = new Database(":memory:");
    bootstrap.loadExtension(graftExtPath);
    bootstrap.close();
    const db = new Database(openUri);
    const out = pragmas.map((pragma) => {
      const row = db.query("PRAGMA " + pragma + ";").get();
      if (!row) return "";
      const first = Object.values(row)[0];
      return typeof first === "string" ? first : String(first);
    });
    db.close();
    console.log(JSON.stringify(out));
  `
  const proc = Bun.spawnSync({
    cmd: [
      'bun',
      '-e',
      helper,
      options.openUri,
      options.graftExtPath,
      ...options.pragmas,
    ],
    env: {
      ...process.env,
      SQLITE3MC_DYLIB: options.sqlite3mcPath,
      GRAFT_CONFIG: options.graftConfigPath,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (proc.exitCode !== 0) {
    const stderr = new TextDecoder().decode(proc.stderr).trim()
    throw new Error(`control pragma subprocess failed: ${stderr}`)
  }

  const stdout = new TextDecoder().decode(proc.stdout).trim()
  return JSON.parse(stdout) as string[]
}

async function main(): Promise<void> {
  const sqlite3mcPath = requiredEnv('SQLITE3MC_DYLIB')
  const graftExtPath = requiredEnv('GRAFT_EXT_DYLIB')
  const sqliteKey = process.env.SQLITE3MC_KEY ?? 'cryptograft-demo-key'
  const sqliteCipher = process.env.SQLITE3MC_CIPHER ?? 'xchacha20'
  const remoteLogId = '74ggc1B6jg-2udz14pbDayZC'
  const firstVolumeId = '5rMJkf2zHE-2xMqqKcN8RLZh'
  const firstLocalLogId = '74ggc1B6R4-2kkvcy9fi4CHJ'
  const secondVolumeId = '5rMJkfMogd-3bVjH8fwwX44x'
  const secondLocalLogId = '74ggc1o8bK-34EknTZT8mjSx'

  BunDatabase.setCustomSQLite(sqlite3mcPath)

  const tempRoot = mkdtempSync(join(tmpdir(), 'pglite-cryptograft-example-'))
  const sharedRemoteRoot = join(tempRoot, 'remote-fs')
  const clientOneGraftDataDir = join(tempRoot, 'client-1-graft-data')
  const clientTwoGraftDataDir = join(tempRoot, 'client-2-graft-data')
  const clientOneConfig = join(tempRoot, 'graft-client-1.toml')
  const clientTwoConfig = join(tempRoot, 'graft-client-2.toml')
  const pgliteOneDataDir = join(tempRoot, 'pglite-1')
  const pgliteTwoDataDir = join(tempRoot, 'pglite-2')
  const sqliteOnePath = join(pgliteOneDataDir, '.cryptograft-afs.sqlite')
  const sqliteTwoPath = join(pgliteTwoDataDir, '.cryptograft-afs.sqlite')
  const controlDbUri = 'file:cryptograft-sync?vfs=graft'

  mkdirSync(sharedRemoteRoot, { recursive: true })
  mkdirSync(clientOneGraftDataDir, { recursive: true })
  mkdirSync(clientTwoGraftDataDir, { recursive: true })
  mkdirSync(pgliteOneDataDir, { recursive: true })
  mkdirSync(pgliteTwoDataDir, { recursive: true })
  writeGraftConfig(clientOneConfig, clientOneGraftDataDir, sharedRemoteRoot)
  writeGraftConfig(clientTwoConfig, clientTwoGraftDataDir, sharedRemoteRoot)

  let pg1: PGlite | null = null
  let fs1: CryptograftAFS | null = null
  let pg2: PGlite | null = null
  let fs2: CryptograftAFS | null = null

  try {
    const [switchOneText] = runControlPragmas({
      openUri: controlDbUri,
      graftConfigPath: clientOneConfig,
      graftExtPath,
      sqlite3mcPath,
      pragmas: [`graft_switch = '${firstVolumeId}:${firstLocalLogId}:${remoteLogId}'`],
    })

    fs1 = new CryptograftAFS(pgliteOneDataDir, sqliteKey, {
      pragmas: [
        `PRAGMA cipher = '${sqlQuote(sqliteCipher)}'`,
        `PRAGMA key = '${sqlQuote(sqliteKey)}'`,
      ],
    })
    pg1 = await PGlite.create({ dataDir: pgliteOneDataDir, fs: fs1 })

    await pg1.exec(`
      CREATE TABLE sync_demo (
        id INTEGER PRIMARY KEY,
        payload TEXT NOT NULL
      );
    `)
    await pg1.exec(`
      INSERT INTO sync_demo (id, payload) VALUES
      (1, 'alpha'),
      (2, 'beta'),
      (3, 'gamma');
    `)

    await pg1.close()
    pg1 = null
    await fs1.destroy()
    fs1 = null

    const [pushText] = runControlPragmas({
      openUri: controlDbUri,
      graftConfigPath: clientOneConfig,
      graftExtPath,
      sqlite3mcPath,
      pragmas: [`graft_import = '${sqlQuote(sqliteOnePath)}'`, 'graft_push'],
    })

    const [switchTwoText, pullText] = runControlPragmas({
      openUri: controlDbUri,
      graftConfigPath: clientTwoConfig,
      graftExtPath,
      sqlite3mcPath,
      pragmas: [
        `graft_switch = '${secondVolumeId}:${secondLocalLogId}:${remoteLogId}'`,
        'graft_pull',
        `graft_export = '${sqlQuote(sqliteTwoPath)}'`,
      ],
    })

    fs2 = new CryptograftAFS(pgliteTwoDataDir, sqliteKey, {
      pragmas: [
        `PRAGMA cipher = '${sqlQuote(sqliteCipher)}'`,
        `PRAGMA key = '${sqlQuote(sqliteKey)}'`,
      ],
    })
    pg2 = await PGlite.create({ dataDir: pgliteTwoDataDir, fs: fs2 })

    const synced = await pg2.query<{ id: number; payload: string }>(
      'SELECT id, payload FROM sync_demo ORDER BY id',
    )
    const expected = [
      { id: 1, payload: 'alpha' },
      { id: 2, payload: 'beta' },
      { id: 3, payload: 'gamma' },
    ]

    if (JSON.stringify(synced.rows) !== JSON.stringify(expected)) {
      throw new Error(
        `Unexpected replicated rows.\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(synced.rows)}`,
      )
    }

    console.log('graft switch #1:', switchOneText)
    console.log('graft push:', pushText)
    console.log('graft switch #2:', switchTwoText)
    console.log('graft pull:', pullText)
    console.log('rows:', synced.rows)
    console.log('pglite-cryptograft example: sync verified')
  } finally {
    if (pg2) await pg2.close()
    if (fs2) await fs2.destroy()
    if (pg1) await pg1.close()
    if (fs1) await fs1.destroy()
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
