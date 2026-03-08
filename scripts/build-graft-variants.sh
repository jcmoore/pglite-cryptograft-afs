#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

DEFAULT_GRAFT_DIR="${PROJECT_DIR}/../../../../../../modules/github.com/orbitinghail/graft/v/0"
GRAFT_DIR="${GRAFT_DIR:-$DEFAULT_GRAFT_DIR}"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-${PROJECT_DIR}/artifacts}"
GRAFT_ARTIFACTS_DIR="${GRAFT_ARTIFACTS_DIR:-${ARTIFACTS_DIR}/graft}"
GRAFT_CARGO_TARGET_DIR="${GRAFT_CARGO_TARGET_DIR:-${ARTIFACTS_DIR}/graft-target}"
GRAFT_PAGESIZES_KB="${GRAFT_PAGESIZES_KB:-4,8,16}"
GRAFT_CARGO_PROFILE="${GRAFT_CARGO_PROFILE:-release}"

UNAME_S="$(uname -s)"
case "${UNAME_S}" in
  Darwin*) GRAFT_EXT_SUFFIX="dylib" ;;
  Linux*) GRAFT_EXT_SUFFIX="so" ;;
  *)
    echo "Unsupported platform for graft-ext dynamic library: ${UNAME_S}" >&2
    exit 1
    ;;
esac

if [[ ! -d "${GRAFT_DIR}" ]]; then
  echo "graft directory not found: ${GRAFT_DIR}" >&2
  exit 1
fi

if [[ ! -f "${GRAFT_DIR}/Cargo.toml" ]]; then
  echo "graft Cargo.toml missing: ${GRAFT_DIR}/Cargo.toml" >&2
  exit 1
fi

mkdir -p "${GRAFT_ARTIFACTS_DIR}" "${GRAFT_CARGO_TARGET_DIR}"

IFS=',' read -r -a PAGE_SIZES <<< "${GRAFT_PAGESIZES_KB}"

MANIFEST_PATH="${GRAFT_ARTIFACTS_DIR}/variants.tsv"
: > "${MANIFEST_PATH}"

detect_libclang_dir() {
  if [[ -n "${LIBCLANG_PATH:-}" && -f "${LIBCLANG_PATH}/libclang.dylib" ]]; then
    printf '%s\n' "${LIBCLANG_PATH}"
    return 0
  fi

  local candidate
  for candidate in \
    "/Library/Developer/CommandLineTools/usr/lib" \
    "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib" \
    "/opt/homebrew/opt/llvm/lib" \
    "/usr/local/opt/llvm/lib"
  do
    if [[ -f "${candidate}/libclang.dylib" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done

  if command -v xcode-select >/dev/null 2>&1; then
    local developer_dir
    developer_dir="$(xcode-select -p 2>/dev/null || true)"
    if [[ -n "${developer_dir}" ]]; then
      candidate="${developer_dir}/Toolchains/XcodeDefault.xctoolchain/usr/lib"
      if [[ -f "${candidate}/libclang.dylib" ]]; then
        printf '%s\n' "${candidate}"
        return 0
      fi
    fi
  fi

  return 1
}

LIBCLANG_DIR=""
if [[ "${UNAME_S}" == "Darwin" ]]; then
  if ! LIBCLANG_DIR="$(detect_libclang_dir)"; then
    echo "Failed to locate libclang.dylib. Set LIBCLANG_PATH before running this script." >&2
    exit 1
  fi
  export LIBCLANG_PATH="${LIBCLANG_DIR}"
  export DYLD_FALLBACK_LIBRARY_PATH="${LIBCLANG_DIR}:${DYLD_FALLBACK_LIBRARY_PATH:-}"
  echo "Using LIBCLANG_PATH=${LIBCLANG_PATH}"
fi

for raw in "${PAGE_SIZES[@]}"; do
  kb="$(echo "${raw}" | tr -d '[:space:]')"

  case "${kb}" in
    4|8|16|32|64) ;;
    *)
      echo "Invalid page size '${raw}'. Allowed values: 4, 8, 16, 32, 64 (KiB)." >&2
      exit 1
      ;;
  esac

  echo "Building graft-ext with GRAFT_PAGESIZE_KB=${kb}"
  PROFILE_ARGS=()
  if [[ "${GRAFT_CARGO_PROFILE}" != "debug" ]]; then
    PROFILE_ARGS=(--profile "${GRAFT_CARGO_PROFILE}")
  fi
  (
    cd "${GRAFT_DIR}"
    GRAFT_PAGESIZE_KB="${kb}" CARGO_TARGET_DIR="${GRAFT_CARGO_TARGET_DIR}" \
      cargo build -p graft-ext --no-default-features --features dynamic "${PROFILE_ARGS[@]}"
  )

  source_lib="${GRAFT_CARGO_TARGET_DIR}/${GRAFT_CARGO_PROFILE}/libgraft_ext.${GRAFT_EXT_SUFFIX}"
  if [[ ! -f "${source_lib}" ]]; then
    echo "Expected built library not found: ${source_lib}" >&2
    exit 1
  fi

  variant_lib="${GRAFT_ARTIFACTS_DIR}/libgraft_ext.pagesize${kb}k.${GRAFT_EXT_SUFFIX}"
  cp "${source_lib}" "${variant_lib}"
  echo "${kb}	${variant_lib}" >> "${MANIFEST_PATH}"
done

echo "Built graft variants:"
cat "${MANIFEST_PATH}"
echo "Manifest written to ${MANIFEST_PATH}"
