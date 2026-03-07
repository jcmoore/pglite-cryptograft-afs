# graft_import Panic Findings (4KiB path)

Date: 2026-03-05 (America/Chicago)

## Scope
This note documents the reproducible panic seen during `PRAGMA graft_import = ...` when importing the cryptograft metadata SQLite database (`.cryptograft-fs.sqlite`) in the pglite sync example flow.

Panic message:

```
Invalid PageSet: Splinter contains PageIdx 0
```

Observed at:
- `crates/graft/src/core/pageset.rs` (`PageSet::new` assertion)

## Key Clarification: Two Distinct "Page Sizes"
- `graft` page size: internal size used by graft page handling.
- `CRYPTOGRAFT_SQLITE_PAGE_SIZE`: metadata SQLite file page size (`PRAGMA page_size`) set by `CryptograftAFS` **only on fresh DB create**.

These can diverge.

Code points:
- Metadata page size set in `CryptograftAFS`:
  - `src/cryptograft-afs.ts` (`PRAGMA page_size=...` on fresh DB)
- Example env wiring:
  - `examples/pglite-cryptograft.ts` (`CRYPTOGRAFT_SQLITE_PAGE_SIZE`)
- `v0.2.1` graft hardcoded page size:
  - `/tmp/graft-v0.2.1/crates/graft/src/core/page.rs` (`PAGESIZE = 4KB`)

## Build/Runtime Variants Checked

### graft
- Submodule checkout branch: `cryptograft-afs`
- Separate detached worktree at tag `v0.2.1`:
  - commit: `f38e035`
- Verified in `v0.2.1`: `PAGESIZE` is hardcoded 4KB.

### SQLite runtime libraries
Both were tested as Bun custom SQLite runtime (`Database.setCustomSQLite`):
1. sqlite3mc custom build (`artifacts/libsqlite3mc.dylib`)
2. Plain upstream SQLite amalgam build (`sqlite-amalgamation-3500400`)
   - output: `artifacts/libsqlite3-plain.dylib`

## Repro Matrix

### Example flow (`examples/pglite-cryptograft.ts`) with graft v0.2.1 4k extension

`GRAFT_EXT_DYLIB=.../libgraft_ext.pagesize4k.dylib`

1. `CRYPTOGRAFT_SQLITE_PAGE_SIZE=4096`
- Result: panic at `graft_import`
- Panic: `Invalid PageSet: Splinter contains PageIdx 0`

2. `CRYPTOGRAFT_SQLITE_PAGE_SIZE=8192`
- Result: success (switch/import/push/pull/export/readback verified)

This behavior is the same for both sqlite3mc and plain upstream SQLite runtime.

## Control Checks

### Control A: plain SQLite file import under same 4k graft path
- Created ordinary 4k SQLite DB (`PRAGMA page_size=4096; VACUUM;`)
- Imported via `PRAGMA graft_import = 'plain.sqlite'`
- Result: success (`imported 2 pages`)

### Control B: cryptograft metadata DB import (unkeyed) under same 4k graft path
- Created `.cryptograft-fs.sqlite` via `CryptograftAFS` with 4k metadata page size
- Imported via `PRAGMA graft_import = '.cryptograft-fs.sqlite'`
- Result: panic (`Invalid PageSet: Splinter contains PageIdx 0`)

## Test Status
- Full `pglite-encrypted-fs` test suite passes:
  - `7` files, `125` tests passed
- Unit coverage confirms metadata DB defaults/override:
  - default page size is 4096
  - explicit override to 8192 works

Interpretation:
- This is **not** a general breakage in local tests.
- The failure is specifically in the `graft_import` path for cryptograft metadata DB shape/content at 4k.

## Conclusions
1. The panic is reproducible with fresh artifacts and temp dirs (not stale state).
2. The panic is reproducible on graft `v0.2.1` (predates recent page-size-config changes).
3. The panic is **not** sqlite3mc-specific (also reproduces with plain upstream SQLite).
4. The panic is **not** a universal 4k import failure:
   - plain 4k SQLite import works,
   - cryptograft metadata 4k import panics.
5. 8k metadata page size is a current practical workaround for the example sync flow.

## Next Debug Target
Instrument/import-trace in graft `volume_import` path to identify where page index `0` is introduced into a `PageSet` when ingesting this DB type.
Likely focus areas:
- `graft-sqlite/src/pragma.rs` (`volume_import`)
- page set construction paths downstream of `writer.write_page` / commit
- any logic that treats page 0 specially during import/compaction
