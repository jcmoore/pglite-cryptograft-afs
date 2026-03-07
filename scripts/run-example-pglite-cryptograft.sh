#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

ARTIFACTS_DIR="${ARTIFACTS_DIR:-${PROJECT_DIR}/artifacts}"

case "$(uname -s)" in
  Darwin*) DYLIB_EXT="dylib" ;;
  Linux*) DYLIB_EXT="so" ;;
  *) DYLIB_EXT="dylib" ;;
esac

SQLITE_DYLIB="${SQLITE_DYLIB:-${ARTIFACTS_DIR}/libsqlite3.${DYLIB_EXT}}"
SQLITE3MC_DYLIB="${SQLITE3MC_DYLIB:-${SQLITE_DYLIB}}"
GRAFT_EXT_DYLIB="${GRAFT_EXT_DYLIB:-${ARTIFACTS_DIR}/graft/libgraft_ext.pagesize4k.${DYLIB_EXT}}"

if [[ ! -f "${SQLITE3MC_DYLIB}" ]]; then
  echo "sqlite library not found: ${SQLITE3MC_DYLIB}" >&2
  echo "Build it first with: npm run build:sqlite3 (or npm run build:sqlite3mc)" >&2
  exit 1
fi

if [[ ! -f "${GRAFT_EXT_DYLIB}" ]]; then
  echo "graft extension not found: ${GRAFT_EXT_DYLIB}" >&2
  echo "Build variants first with: npm run build:graft:variants" >&2
  exit 1
fi

export SQLITE3MC_DYLIB
export GRAFT_EXT_DYLIB
export SQLITE3MC_CIPHER="${SQLITE3MC_CIPHER:-xchacha20}"
export SQLITE3MC_KEY="${SQLITE3MC_KEY:-cryptograft-demo-key}"
export CRYPTOGRAFT_PASSPHRASE="${CRYPTOGRAFT_PASSPHRASE:-${SQLITE3MC_KEY}}"
export CRYPTOGRAFT_SQLITE_PAGE_SIZE="${CRYPTOGRAFT_SQLITE_PAGE_SIZE:-4096}"
export CRYPTOGRAFT_CHUNK_SIZE="${CRYPTOGRAFT_CHUNK_SIZE:-8192}"

bun examples/pglite-cryptograft/pglite-cryptograft-parent.ts
