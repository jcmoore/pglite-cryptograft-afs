#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

ARTIFACTS_DIR="${ARTIFACTS_DIR:-${PROJECT_DIR}/artifacts}"
SQLITE_CC="${SQLITE_CC:-cc}"
SQLITE_DOWNLOAD_PAGE_URL="${SQLITE_DOWNLOAD_PAGE_URL:-https://www.sqlite.org/download.html}"
SQLITE_AMALGAMATION_URL="${SQLITE_AMALGAMATION_URL:-}"
SQLITE_YEAR="${SQLITE_YEAR:-}"
SQLITE_VERSION_NUM="${SQLITE_VERSION_NUM:-}"

UNAME_S="$(uname -s)"
case "${UNAME_S}" in
  Darwin*)
    SQLITE_DYLIB_EXT="dylib"
    SQLITE_DYLIB_LINK_FLAGS=(-dynamiclib)
    SQLITE_PLATFORM_LIBS=(-lm)
    ;;
  Linux*)
    SQLITE_DYLIB_EXT="so"
    SQLITE_DYLIB_LINK_FLAGS=(-shared)
    SQLITE_PLATFORM_LIBS=(-lpthread -ldl -lm)
    ;;
  *)
    echo "Unsupported platform for shared sqlite build: ${UNAME_S}" >&2
    exit 1
    ;;
esac

SQLITE_DYLIB="${SQLITE_DYLIB:-${ARTIFACTS_DIR}/libsqlite3.${SQLITE_DYLIB_EXT}}"
SQLITE_SHELL="${SQLITE_SHELL:-${ARTIFACTS_DIR}/sqlite3_shell}"
SQLITE_AMALGAMATION_DIR="${ARTIFACTS_DIR}/sqlite-amalgamation"
SQLITE_AMALGAMATION_ZIP="${SQLITE_AMALGAMATION_DIR}/sqlite-amalgamation.zip"

if [[ -z "${SQLITE_AMALGAMATION_URL}" ]]; then
  if [[ -n "${SQLITE_YEAR}" && -n "${SQLITE_VERSION_NUM}" ]]; then
    SQLITE_AMALGAMATION_URL="https://www.sqlite.org/${SQLITE_YEAR}/sqlite-amalgamation-${SQLITE_VERSION_NUM}.zip"
  else
    echo "Resolving latest official sqlite amalgamation from ${SQLITE_DOWNLOAD_PAGE_URL}"
    SQLITE_AMALGAMATION_URL="$(curl -fsSL "${SQLITE_DOWNLOAD_PAGE_URL}" \
      | grep -Eo '[0-9]{4}/sqlite-amalgamation-[0-9]+\.zip' \
      | head -n 1)"
    if [[ -z "${SQLITE_AMALGAMATION_URL}" ]]; then
      echo "Unable to locate sqlite amalgamation zip in download page." >&2
      echo "Set SQLITE_AMALGAMATION_URL explicitly." >&2
      exit 1
    fi
    SQLITE_AMALGAMATION_URL="https://www.sqlite.org/${SQLITE_AMALGAMATION_URL}"
  fi
fi

mkdir -p "${SQLITE_AMALGAMATION_DIR}" "${ARTIFACTS_DIR}"

echo "Downloading sqlite amalgamation from:"
echo "  ${SQLITE_AMALGAMATION_URL}"
curl -fsSL "${SQLITE_AMALGAMATION_URL}" -o "${SQLITE_AMALGAMATION_ZIP}"

find "${SQLITE_AMALGAMATION_DIR}" -maxdepth 1 -type d -name 'sqlite-amalgamation-*' -exec rm -rf {} +
unzip -oq "${SQLITE_AMALGAMATION_ZIP}" -d "${SQLITE_AMALGAMATION_DIR}"

SQLITE_SRC_DIR="$(find "${SQLITE_AMALGAMATION_DIR}" -maxdepth 1 -type d -name 'sqlite-amalgamation-*' | head -n 1)"
if [[ -z "${SQLITE_SRC_DIR}" ]]; then
  echo "Failed to unpack sqlite amalgamation sources." >&2
  exit 1
fi

if [[ ! -f "${SQLITE_SRC_DIR}/sqlite3.c" || ! -f "${SQLITE_SRC_DIR}/sqlite3.h" || ! -f "${SQLITE_SRC_DIR}/shell.c" ]]; then
  echo "Expected sqlite amalgamation files were not found in ${SQLITE_SRC_DIR}" >&2
  exit 1
fi

SQLITE_COMMON_DEFINES=(
  -DSQLITE_THREADSAFE=1
  -DSQLITE_USE_URI=1
  -DSQLITE_TEMP_STORE=2
  -DSQLITE_ENABLE_COLUMN_METADATA=1
  -DSQLITE_SECURE_DELETE=1
  -DSQLITE_ENABLE_LOAD_EXTENSION=1
)

echo "Building sqlite shared library at ${SQLITE_DYLIB}"
"${SQLITE_CC}" -O2 -g -fPIC \
  "${SQLITE_COMMON_DEFINES[@]}" \
  "${SQLITE_DYLIB_LINK_FLAGS[@]}" \
  "${SQLITE_SRC_DIR}/sqlite3.c" \
  "${SQLITE_PLATFORM_LIBS[@]}" \
  -o "${SQLITE_DYLIB}"

echo "Building sqlite shell at ${SQLITE_SHELL}"
"${SQLITE_CC}" -O2 -g \
  "${SQLITE_COMMON_DEFINES[@]}" \
  "${SQLITE_SRC_DIR}/sqlite3.c" \
  "${SQLITE_SRC_DIR}/shell.c" \
  "${SQLITE_PLATFORM_LIBS[@]}" \
  -o "${SQLITE_SHELL}"

echo "sqlite artifacts built:"
echo "  ${SQLITE_DYLIB}"
echo "  ${SQLITE_SHELL}"
echo "  ${SQLITE_SRC_DIR}/sqlite3.c"
