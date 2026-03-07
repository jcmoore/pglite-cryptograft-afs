import { Database as BunDatabase } from 'bun:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const globalKey = '__pglite_encrypted_fs_custom_sqlite_initialized__'

function dylibExt(): 'dylib' | 'so' {
  return process.platform === 'darwin' ? 'dylib' : 'so'
}

function firstExisting(paths: Array<string | undefined>): string | undefined {
  for (const candidate of paths) {
    if (!candidate) continue
    if (fs.existsSync(candidate)) return candidate
  }
  return undefined
}

function projectRoot(): string {
  const thisFile = fileURLToPath(import.meta.url)
  return path.resolve(path.dirname(thisFile), '..')
}

function configureDefaultEnv(root: string, ext: string): void {
  const sqliteDefault = path.join(root, 'artifacts', `libsqlite3.${ext}`)
  const sqlite3mcDefault = path.join(root, 'artifacts', `libsqlite3mc.${ext}`)
  const graftDefault = path.join(
    root,
    'artifacts',
    'graft',
    `libgraft_ext.pagesize4k.${ext}`,
  )

  const sqliteLib = firstExisting([
    process.env.SQLITE3MC_DYLIB,
    process.env.SQLITE_DYLIB,
    sqliteDefault,
    sqlite3mcDefault,
  ])

  if (sqliteLib) {
    process.env.SQLITE3MC_DYLIB = sqliteLib
    process.env.SQLITE_DYLIB = sqliteLib
  }

  if (!process.env.GRAFT_EXT_DYLIB && fs.existsSync(graftDefault)) {
    process.env.GRAFT_EXT_DYLIB = graftDefault
  }
}

function initializeCustomSQLite(): void {
  const root = projectRoot()
  const ext = dylibExt()
  configureDefaultEnv(root, ext)

  const sqliteLib = process.env.SQLITE3MC_DYLIB ?? process.env.SQLITE_DYLIB
  if (!sqliteLib) return

  const g = globalThis as Record<string, unknown>
  if (g[globalKey]) return

  BunDatabase.setCustomSQLite(sqliteLib)
  g[globalKey] = true
}

initializeCustomSQLite()
