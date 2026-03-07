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

SQLITE_DYLIB_DEFAULT="${ARTIFACTS_DIR}/libsqlite3.${DYLIB_EXT}"
SQLITE3MC_DYLIB_DEFAULT="${ARTIFACTS_DIR}/libsqlite3mc.${DYLIB_EXT}"

if [[ -f "${SQLITE_DYLIB_DEFAULT}" ]]; then
  SQLITE_DYLIB="${SQLITE_DYLIB:-${SQLITE_DYLIB_DEFAULT}}"
elif [[ -f "${SQLITE3MC_DYLIB_DEFAULT}" ]]; then
  SQLITE_DYLIB="${SQLITE_DYLIB:-${SQLITE3MC_DYLIB_DEFAULT}}"
else
  echo "No sqlite dylib found in artifacts." >&2
  echo "Build one first with: npm run build:sqlite3 (or npm run build:sqlite3mc)" >&2
  exit 1
fi

GRAFT_EXT_DYLIB="${GRAFT_EXT_DYLIB:-${ARTIFACTS_DIR}/graft/libgraft_ext.pagesize4k.${DYLIB_EXT}}"
if [[ ! -f "${GRAFT_EXT_DYLIB}" ]]; then
  echo "graft extension not found: ${GRAFT_EXT_DYLIB}" >&2
  echo "Build variants first with: npm run build:graft:variants" >&2
  exit 1
fi

TEST_GRAFT_DIR="${ARTIFACTS_DIR}/test-graft"
TEST_GRAFT_DATA_DIR="${TEST_GRAFT_DIR}/data"
TEST_GRAFT_REMOTE_DIR="${TEST_GRAFT_DIR}/remote"
TEST_GRAFT_CONFIG="${TEST_GRAFT_DIR}/graft.toml"

mkdir -p "${TEST_GRAFT_DATA_DIR}" "${TEST_GRAFT_REMOTE_DIR}"
cat > "${TEST_GRAFT_CONFIG}" <<EOF
data_dir = "${TEST_GRAFT_DATA_DIR}"

[remote]
type = "fs"
root = "${TEST_GRAFT_REMOTE_DIR}"
EOF

export SQLITE_DYLIB
export SQLITE3MC_DYLIB="${SQLITE3MC_DYLIB:-${SQLITE_DYLIB}}"
export GRAFT_EXT_DYLIB
export GRAFT_CONFIG="${GRAFT_CONFIG:-${TEST_GRAFT_CONFIG}}"

VITEST_MODE="${VITEST_MODE:-run}"
bun --bun ./node_modules/vitest/vitest.mjs "${VITEST_MODE}" "$@"
