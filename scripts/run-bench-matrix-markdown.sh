#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

ARTIFACTS_DIR="${ARTIFACTS_DIR:-${PROJECT_DIR}/artifacts}"
DEFAULT_SQLITE3MC_DYLIB="${ARTIFACTS_DIR}/libsqlite3mc.dylib"
SQLITE3MC_DYLIB="${SQLITE3MC_DYLIB:-${DEFAULT_SQLITE3MC_DYLIB}}"
GRAFT_MATRIX_PAGESIZES_KB="${GRAFT_MATRIX_PAGESIZES_KB:-4,8,16,32,64}"

if [[ ! -f "${SQLITE3MC_DYLIB}" ]]; then
  echo "sqlite3mc dylib not found: ${SQLITE3MC_DYLIB}" >&2
  echo "Build it first with: npm run build:sqlite3mc" >&2
  exit 1
fi

export SQLITE3MC_DYLIB
export SQLITE3MC_CIPHER="${SQLITE3MC_CIPHER:-xchacha20}"
export SQLITE3MC_KEY="${SQLITE3MC_KEY:-bench-passphrase}"
export CRYPTOGRAFT_MATRIX_CHUNK_SIZES="${CRYPTOGRAFT_MATRIX_CHUNK_SIZES:-8192}"
USER_GRAFT_CONFIG="${GRAFT_CONFIG:-}"
TEMP_GRAFT_ROOTS=()

cleanup() {
  local root
  for root in "${TEMP_GRAFT_ROOTS[@]:-}"; do
    rm -rf "${root}"
  done
  if [[ -n "${RESULTS_DIR:-}" ]]; then
    rm -rf "${RESULTS_DIR}"
  fi
}
trap cleanup EXIT

RESULTS_DIR="$(mktemp -d "${ARTIFACTS_DIR}/bench-json.XXXXXX")"
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

  echo "Running matrix bench for page size ${kb}KiB..."
  out_json="${RESULTS_DIR}/bench.page${kb}k.json"
  if ! GRAFT_CONFIG="${GRAFT_CONFIG_FOR_RUN}" GRAFT_MATRIX_PAGESIZES_KB="${kb}" bun --bun ./node_modules/vitest/vitest.mjs bench \
    --config vitest.bench.config.ts \
    bench/cryptograft-matrix.bench.ts \
    --outputJson "${out_json}"; then
    STATUS=1
  fi
done

MARKDOWN_OUTPUT="$(bun ./scripts/bench-matrix-markdown.ts "${RESULTS_DIR}")"

if [[ -n "${BENCH_MATRIX_MARKDOWN_PATH:-}" ]]; then
  mkdir -p "$(dirname "${BENCH_MATRIX_MARKDOWN_PATH}")"
  printf '%s\n' "${MARKDOWN_OUTPUT}" > "${BENCH_MATRIX_MARKDOWN_PATH}"
  echo "Markdown summary written to ${BENCH_MATRIX_MARKDOWN_PATH}"
fi

printf '%s\n' "${MARKDOWN_OUTPUT}"
exit "${STATUS}"
