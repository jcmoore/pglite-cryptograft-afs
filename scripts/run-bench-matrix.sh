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

DEFAULT_SQLITE_DYLIB="${ARTIFACTS_DIR}/libsqlite3.${DYLIB_EXT}"
DEFAULT_SQLITE3MC_DYLIB="${ARTIFACTS_DIR}/libsqlite3mc.${DYLIB_EXT}"

if [[ -f "${DEFAULT_SQLITE_DYLIB}" ]]; then
  SQLITE3MC_DYLIB="${SQLITE3MC_DYLIB:-${DEFAULT_SQLITE_DYLIB}}"
else
  SQLITE3MC_DYLIB="${SQLITE3MC_DYLIB:-${DEFAULT_SQLITE3MC_DYLIB}}"
fi

if [[ ! -f "${SQLITE3MC_DYLIB}" ]]; then
  echo "sqlite dylib not found: ${SQLITE3MC_DYLIB}" >&2
  echo "Build it first with: npm run build:sqlite3 (or npm run build:sqlite3mc)" >&2
  exit 1
fi

export SQLITE3MC_DYLIB
export SQLITE3MC_CIPHER="${SQLITE3MC_CIPHER:-xchacha20}"
export SQLITE3MC_KEY="${SQLITE3MC_KEY:-bench-passphrase}"
export CRYPTOGRAFT_MATRIX_CHUNK_SIZES="${CRYPTOGRAFT_MATRIX_CHUNK_SIZES:-8192}"
GRAFT_MATRIX_PAGESIZES_KB="${GRAFT_MATRIX_PAGESIZES_KB:-4,8,16,32,64}"
USER_GRAFT_CONFIG="${GRAFT_CONFIG:-}"
TEMP_GRAFT_ROOTS=()

cleanup() {
  local root
  for root in "${TEMP_GRAFT_ROOTS[@]:-}"; do
    rm -rf "${root}"
  done
}
trap cleanup EXIT

IFS=',' read -r -a PAGE_SIZES <<< "${GRAFT_MATRIX_PAGESIZES_KB}"

STATUS=0
for raw in "${PAGE_SIZES[@]}"; do
  kb="$(echo "${raw}" | tr -d '[:space:]')"
  case "${kb}" in
    4|8|16|32|64) ;;
    *)
      echo "Invalid GRAFT_MATRIX_PAGESIZES_KB entry: '${raw}'" >&2
      exit 1
      ;;
  esac

  GRAFT_CONFIG_FOR_RUN="${USER_GRAFT_CONFIG}"
  GRAFT_EXT_FOR_RUN="${ARTIFACTS_DIR}/graft/libgraft_ext.pagesize${kb}k.${DYLIB_EXT}"
  if [[ ! -f "${GRAFT_EXT_FOR_RUN}" ]]; then
    echo "graft extension not found for ${kb}KiB page size: ${GRAFT_EXT_FOR_RUN}" >&2
    echo "Build it first with: npm run build:graft:variants" >&2
    exit 1
  fi

  if [[ -z "${GRAFT_CONFIG_FOR_RUN}" ]]; then
    mkdir -p "${ARTIFACTS_DIR}"
    PAGE_GRAFT_ROOT="$(mktemp -d "${ARTIFACTS_DIR}/bench-graft-p${kb}.XXXXXX")"
    TEMP_GRAFT_ROOTS+=("${PAGE_GRAFT_ROOT}")
    mkdir -p "${PAGE_GRAFT_ROOT}/remote" "${PAGE_GRAFT_ROOT}/data"
    cat > "${PAGE_GRAFT_ROOT}/graft.toml" <<EOF
data_dir = "${PAGE_GRAFT_ROOT}/data"

[remote]
type = "fs"
root = "${PAGE_GRAFT_ROOT}/remote"
EOF
    GRAFT_CONFIG_FOR_RUN="${PAGE_GRAFT_ROOT}/graft.toml"
  fi

  echo
  echo "=== bench:matrix page size ${kb}KiB ==="
  if ! GRAFT_CONFIG="${GRAFT_CONFIG_FOR_RUN}" GRAFT_EXT_DYLIB="${GRAFT_EXT_FOR_RUN}" GRAFT_MATRIX_PAGESIZES_KB="${kb}" bun --bun ./node_modules/vitest/vitest.mjs bench \
    --config vitest.bench.config.ts \
    bench/cryptograft-matrix.bench.ts; then
    STATUS=1
  fi
done

exit "${STATUS}"
