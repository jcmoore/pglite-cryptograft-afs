import { afterAll, bench, describe } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { Database as BunDatabase } from 'bun:sqlite'
import type { CryptograftAFSOptions } from '../src/index.js'
import {
  cleanupTestDir,
  createCryptograftPGlite,
  createEncryptedPGlite,
  createTestDir,
} from './helpers/bench-utils.js'
import { generateInsertSQL } from './helpers/bench-utils.js'

interface MatrixVariant {
  pageSizeKb: number
  chunkSize: number
  keyed: boolean
  label: string
}

interface MatrixState {
  variant: MatrixVariant
  dir: string
  db: Awaited<ReturnType<typeof createCryptograftPGlite>>['db']
  fs: Awaited<ReturnType<typeof createCryptograftPGlite>>['fs']
}

const SCHEMA = `
  CREATE TABLE bench_data (
    id SERIAL PRIMARY KEY,
    data TEXT NOT NULL
  );
  CREATE INDEX idx_bench_data ON bench_data (id);
`

const SEED_SQL = generateInsertSQL('bench_data', 1000)

function parseCsvInt(name: string, raw: string): number[] {
  const parsed = raw
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((num) => Number.isFinite(num) && num > 0)
  if (parsed.length === 0) {
    throw new Error(`Invalid ${name}: '${raw}'`)
  }
  return parsed
}

function sqliteLibSuffix(): string {
  switch (process.platform) {
    case 'darwin':
      return 'dylib'
    case 'linux':
      return 'so'
    case 'win32':
      return 'dll'
    default:
      throw new Error(`Unsupported platform: ${process.platform}`)
  }
}

function sqlQuote(value: string): string {
  return value.replace(/'/g, "''")
}

function canReadMetadata(tag: string, key?: { cipher: string; key: string }): boolean {
  let db: BunDatabase | null = null
  try {
    db = new BunDatabase(`file:${tag}?vfs=graft`)
    if (key) {
      db.exec(`PRAGMA cipher = '${sqlQuote(key.cipher)}';`)
      db.exec(`PRAGMA key = '${sqlQuote(key.key)}';`)
    }
    db.query('SELECT count(*) AS c FROM sqlite_master').get()
    db.close()
    return true
  } catch {
    if (db) db.close()
    return false
  }
}

const pagesizesKb = parseCsvInt(
  'GRAFT_MATRIX_PAGESIZES_KB',
  process.env.GRAFT_MATRIX_PAGESIZES_KB ?? '4,8,16,32,64',
)
const chunkSizes = parseCsvInt(
  'CRYPTOGRAFT_MATRIX_CHUNK_SIZES',
  process.env.CRYPTOGRAFT_MATRIX_CHUNK_SIZES ?? '8192',
)

const graftVariantsDir = process.env.GRAFT_EXT_VARIANTS_DIR
  ? path.resolve(process.env.GRAFT_EXT_VARIANTS_DIR)
  : path.resolve(process.cwd(), 'artifacts/graft')

const extensionSuffix = sqliteLibSuffix()
const sqliteLibraryPath = process.env.SQLITE_DYLIB ?? process.env.SQLITE3MC_DYLIB
const sqlite3mcPath =
  process.env.SQLITE3MC_DYLIB &&
  /sqlite3mc/i.test(path.basename(process.env.SQLITE3MC_DYLIB))
    ? process.env.SQLITE3MC_DYLIB
    : undefined
const sqliteCipher = process.env.SQLITE3MC_CIPHER ?? 'xchacha20'
const sqliteKey = process.env.SQLITE3MC_KEY ?? 'bench-passphrase'

if (!process.env.GRAFT_CONFIG) {
  throw new Error(
    "Missing GRAFT_CONFIG. Use 'npm run bench:matrix' or set GRAFT_CONFIG before running this bench.",
  )
}

const variants: MatrixVariant[] = []
if (pagesizesKb.length !== 1) {
  throw new Error(
    `This bench process supports exactly one page size (got ${pagesizesKb.join(',')}). Use 'npm run bench:matrix' to iterate page sizes safely.`,
  )
}

const pageSizeKb = pagesizesKb[0]
const graftExtPath = path.join(
  graftVariantsDir,
  `libgraft_ext.pagesize${pageSizeKb}k.${extensionSuffix}`,
)

if (!fs.existsSync(graftExtPath)) {
  throw new Error(
    `Missing graft variant library for ${pageSizeKb}KiB: ${graftExtPath}. Build variants first with 'npm run build:graft:variants'.`,
  )
}

for (const chunkSize of chunkSizes) {
  variants.push({
    pageSizeKb,
    chunkSize,
    keyed: false,
    label: `cryptograft[unkeyed p=${pageSizeKb}k chunk=${chunkSize}]`,
  })
  if (sqlite3mcPath) {
    variants.push({
      pageSizeKb,
      chunkSize,
      keyed: true,
      label: `cryptograft[keyed p=${pageSizeKb}k chunk=${chunkSize}]`,
    })
  }
}

if (!sqlite3mcPath) {
  console.warn(
    '[bench:matrix] sqlite3mc library not detected; keyed sqlite3mc contenders were skipped.',
  )
}

if (variants.length === 0) {
  throw new Error(
    `No matrix variants available. Build variants first with 'npm run build:graft:variants'. Searched: ${graftVariantsDir}`,
  )
}

const plainDir = createTestDir()
const plainDb = await PGlite.create({ dataDir: plainDir })
await plainDb.exec(SCHEMA)
await plainDb.exec(SEED_SQL)

const encryptedDir = createTestDir()
const { db: encryptedDb } = await createEncryptedPGlite(
  encryptedDir,
  'bench-passphrase',
)
await encryptedDb.exec(SCHEMA)
await encryptedDb.exec(SEED_SQL)

const states: MatrixState[] = []

for (const variant of variants) {
  const dir = createTestDir()

  const options: CryptograftAFSOptions = {
    chunkSize: variant.chunkSize,
    sqlitePageSize: variant.pageSizeKb * 1024,
    graftTag: `bench-cryptograft-p${variant.pageSizeKb}k-c${variant.chunkSize}-${variant.keyed ? 'keyed' : 'unkeyed'}-${states.length}`,
  }
  if (states.length === 0) {
    options.graftExtensionPath = graftExtPath
  }
  if (sqliteLibraryPath) {
    options.sqliteLibraryPath = sqliteLibraryPath
  }
  if (variant.keyed) {
    options.pragmas = [
      `PRAGMA cipher = '${sqlQuote(sqliteCipher)}'`,
      `PRAGMA key = '${sqlQuote(sqliteKey)}'`,
    ]
  }

  const { db, fs: cgfs } = await createCryptograftPGlite(dir, undefined, options)
  await db.exec(SCHEMA)
  await db.exec(SEED_SQL)

  const canReadUnkeyed = canReadMetadata(options.graftTag!)
  if (variant.keyed && canReadUnkeyed) {
    throw new Error(`Expected keyed cryptograft metadata db to reject unkeyed reads for tag '${options.graftTag}'`)
  }
  if (!variant.keyed && !canReadUnkeyed) {
    throw new Error(`Expected unkeyed cryptograft metadata db to allow unkeyed reads for tag '${options.graftTag}'`)
  }
  if (variant.keyed) {
    const canReadWithKey = canReadMetadata(options.graftTag!, {
      cipher: sqliteCipher,
      key: sqliteKey,
    })
    if (!canReadWithKey) {
      throw new Error(`Expected keyed cryptograft metadata db to allow keyed reads for tag '${options.graftTag}'`)
    }
  }

  states.push({
    variant,
    dir,
    db,
    fs: cgfs,
  })
}

afterAll(async () => {
  await plainDb.close()
  cleanupTestDir(plainDir)

  await encryptedDb.close()
  cleanupTestDir(encryptedDir)

  for (const state of states) {
    await state.db.close()
    await state.fs.destroy()
    cleanupTestDir(state.dir)
  }
})

describe('matrix bulk insert', () => {
  bench('plain-nodefs - bulk insert 1000 rows', async () => {
    await plainDb.exec('TRUNCATE bench_data')
    await plainDb.exec(SEED_SQL)
  })

  bench('encrypted - bulk insert 1000 rows', async () => {
    await encryptedDb.exec('TRUNCATE bench_data')
    await encryptedDb.exec(SEED_SQL)
  })

  for (const state of states) {
    bench(`${state.variant.label} - bulk insert 1000 rows`, async () => {
      await state.db.exec('TRUNCATE bench_data')
      await state.db.exec(SEED_SQL)
    })
  }
})

describe('matrix select', () => {
  bench('plain-nodefs - select 1000 rows', async () => {
    await plainDb.exec('SELECT * FROM bench_data')
  })

  bench('encrypted - select 1000 rows', async () => {
    await encryptedDb.exec('SELECT * FROM bench_data')
  })

  for (const state of states) {
    bench(`${state.variant.label} - select 1000 rows`, async () => {
      await state.db.exec('SELECT * FROM bench_data')
    })
  }
})
