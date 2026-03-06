#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

DEFAULT_SQLITE3MC_DIR="${PROJECT_DIR}/../../../../../github.com/utelle/SQLite3MultipleCiphers/v/2"
SQLITE3MC_DIR="${SQLITE3MC_DIR:-$DEFAULT_SQLITE3MC_DIR}"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-${PROJECT_DIR}/artifacts}"

UNAME_S="$(uname -s)"
case "${UNAME_S}" in
  Darwin*)
    SQLITE3MC_DYLIB_EXT="dylib"
    ;;
  Linux*)
    SQLITE3MC_DYLIB_EXT="so"
    ;;
  *)
    echo "Unsupported platform for shared sqlite3mc build: ${UNAME_S}" >&2
    exit 1
    ;;
esac

SQLITE3MC_SHELL="${SQLITE3MC_SHELL:-${ARTIFACTS_DIR}/sqlite3mc_shell_local}"
SQLITE3MC_DYLIB="${SQLITE3MC_DYLIB:-${ARTIFACTS_DIR}/libsqlite3mc.${SQLITE3MC_DYLIB_EXT}}"

mkdir -p "${ARTIFACTS_DIR}"

if [[ ! -d "${SQLITE3MC_DIR}" ]]; then
  echo "sqlite3mc directory not found: ${SQLITE3MC_DIR}" >&2
  exit 1
fi

if [[ ! -f "${SQLITE3MC_DIR}/src/sqlite3mc.c" ]]; then
  echo "sqlite3mc source missing: ${SQLITE3MC_DIR}/src/sqlite3mc.c" >&2
  exit 1
fi

if [[ ! -x "${SQLITE3MC_SHELL}" ]]; then
  echo "sqlite3mc shell not found: ${SQLITE3MC_SHELL}" >&2
  echo "Run: bash ${PROJECT_DIR}/scripts/build-sqlite3mc.sh" >&2
  exit 1
fi

if [[ ! -f "${SQLITE3MC_DYLIB}" ]]; then
  echo "warning: sqlite3mc shared library not found: ${SQLITE3MC_DYLIB}" >&2
fi

RUN_DIR="${ARTIFACTS_DIR}/sqlite3mc-tests-${USER:-user}-$$"
mkdir -p "${RUN_DIR}"

echo "Using sqlite3mc shell: ${SQLITE3MC_SHELL}"
echo "Using sqlite3mc shared library: ${SQLITE3MC_DYLIB}"
echo "Using sqlite3mc source: ${SQLITE3MC_DIR}"
echo "Artifacts dir: ${ARTIFACTS_DIR}"
echo "Run dir: ${RUN_DIR}"

echo "Running core fixture tests"
"${SQLITE3MC_SHELL}" "${RUN_DIR}/test1.db3" ".read ${SQLITE3MC_DIR}/test/test1.sql" >/dev/null
"${SQLITE3MC_SHELL}" "${RUN_DIR}/test2.db3" ".read ${SQLITE3MC_DIR}/test/test2.sql" >/dev/null
"${SQLITE3MC_SHELL}" "${SQLITE3MC_DIR}/test/persons-aegis-testkey.db3" ".read ${SQLITE3MC_DIR}/test/test3.sql" >/dev/null
"${SQLITE3MC_SHELL}" "${SQLITE3MC_DIR}/test/persons-ascon128-testkey.db3" ".read ${SQLITE3MC_DIR}/test/test4.sql" >/dev/null
(
  cd "${SQLITE3MC_DIR}"
  "${SQLITE3MC_SHELL}" "${RUN_DIR}/dummy.db3" ".read test/sqlciphertest.sql" >/dev/null
)

echo "Running xchacha20 roundtrip test"
"${SQLITE3MC_SHELL}" <<SQL >/dev/null
.open ${RUN_DIR}/xchacha20-testkey.db
PRAGMA cipher='xchacha20';
PRAGMA key='testkey';
CREATE TABLE t1 (c1 INTEGER, c2 TEXT);
INSERT INTO t1 VALUES (1, 'Alf');
INSERT INTO t1 VALUES (2, 'Bert');
INSERT INTO t1 VALUES (3, 'Cecil');
SELECT COUNT(*) FROM t1;
.open ${RUN_DIR}/xchacha20-testkey.db
PRAGMA cipher='xchacha20';
PRAGMA key='testkey';
SELECT COUNT(*) FROM t1;
SELECT DISTINCT * FROM t1 ORDER BY c1;
SQL

echo "Running xchacha20 wrong-key check (expected failure)"
set +e
WRONG_KEY_OUTPUT="$("${SQLITE3MC_SHELL}" <<SQL 2>&1
.open ${RUN_DIR}/xchacha20-testkey.db
PRAGMA cipher='xchacha20';
PRAGMA key='wrongkey';
SELECT COUNT(*) FROM t1;
SQL
)"
WRONG_KEY_RC=$?
set -e

if [[ "${WRONG_KEY_RC}" -eq 0 ]]; then
  echo "Expected wrong-key check to fail, but command succeeded." >&2
  exit 1
fi

if ! grep -qi "file is not a database" <<<"${WRONG_KEY_OUTPUT}"; then
  echo "Wrong-key failure did not contain expected error text." >&2
  echo "${WRONG_KEY_OUTPUT}" >&2
  exit 1
fi

echo "sqlite3mc test suite passed."
