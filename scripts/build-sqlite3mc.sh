#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

DEFAULT_SQLITE3MC_DIR="${PROJECT_DIR}/../../../../../github.com/utelle/SQLite3MultipleCiphers/v/2"
SQLITE3MC_DIR="${SQLITE3MC_DIR:-$DEFAULT_SQLITE3MC_DIR}"
SQLITE3MC_CC="${SQLITE3MC_CC:-cc}"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-${PROJECT_DIR}/artifacts}"
SQLITE3MC_CODEC_TYPE_RAW="${SQLITE3MC_CODEC_TYPE:-xchacha20}"
SQLITE3MC_CODEC_TYPE_NORMALIZED="$(printf '%s' "${SQLITE3MC_CODEC_TYPE_RAW}" | tr '[:upper:]' '[:lower:]')"

case "${SQLITE3MC_CODEC_TYPE_NORMALIZED}" in
  xchacha20|codec_type_xchacha20)
    SQLITE3MC_CODEC_TYPE_DEFINE="CODEC_TYPE_XCHACHA20"
    ;;
  chacha20|codec_type_chacha20)
    SQLITE3MC_CODEC_TYPE_DEFINE="CODEC_TYPE_CHACHA20"
    ;;
  aes128|aes128cbc|codec_type_aes128)
    SQLITE3MC_CODEC_TYPE_DEFINE="CODEC_TYPE_AES128"
    ;;
  aes256|aes256cbc|codec_type_aes256)
    SQLITE3MC_CODEC_TYPE_DEFINE="CODEC_TYPE_AES256"
    ;;
  sqlcipher|codec_type_sqlcipher)
    SQLITE3MC_CODEC_TYPE_DEFINE="CODEC_TYPE_SQLCIPHER"
    ;;
  rc4|codec_type_rc4)
    SQLITE3MC_CODEC_TYPE_DEFINE="CODEC_TYPE_RC4"
    ;;
  ascon128|codec_type_ascon128)
    SQLITE3MC_CODEC_TYPE_DEFINE="CODEC_TYPE_ASCON128"
    ;;
  aegis|codec_type_aegis)
    SQLITE3MC_CODEC_TYPE_DEFINE="CODEC_TYPE_AEGIS"
    ;;
  *)
    echo "Unsupported SQLITE3MC_CODEC_TYPE: ${SQLITE3MC_CODEC_TYPE_RAW}" >&2
    echo "Supported values: xchacha20, chacha20, aes128, aes256, sqlcipher, rc4, ascon128, aegis" >&2
    exit 1
    ;;
esac

UNAME_S="$(uname -s)"
case "${UNAME_S}" in
  Darwin*)
    SQLITE3MC_DYLIB_EXT="dylib"
    SQLITE3MC_DYLIB_LINK_FLAGS=(-dynamiclib)
    ;;
  Linux*)
    SQLITE3MC_DYLIB_EXT="so"
    SQLITE3MC_DYLIB_LINK_FLAGS=(-shared)
    ;;
  *)
    echo "Unsupported platform for shared sqlite3mc build: ${UNAME_S}" >&2
    exit 1
    ;;
esac

SQLITE3MC_SHELL="${SQLITE3MC_SHELL:-${ARTIFACTS_DIR}/sqlite3mc_shell_local}"
SQLITE3MC_DYLIB="${SQLITE3MC_DYLIB:-${ARTIFACTS_DIR}/libsqlite3mc.${SQLITE3MC_DYLIB_EXT}}"

if [[ ! -d "${SQLITE3MC_DIR}" ]]; then
  echo "sqlite3mc directory not found: ${SQLITE3MC_DIR}" >&2
  exit 1
fi

if [[ ! -f "${SQLITE3MC_DIR}/src/sqlite3mc.c" ]]; then
  echo "sqlite3mc source missing: ${SQLITE3MC_DIR}/src/sqlite3mc.c" >&2
  exit 1
fi

mkdir -p "${ARTIFACTS_DIR}"

echo "Building sqlite3mc shell at ${SQLITE3MC_SHELL}"
echo "Building sqlite3mc shared library at ${SQLITE3MC_DYLIB}"
echo "Default codec type: ${SQLITE3MC_CODEC_TYPE_DEFINE}"
(
  cd "${SQLITE3MC_DIR}"

  "${SQLITE3MC_CC}" -O2 -g -Isrc -Isrc/aegis/include -Isrc/argon2/include \
    -DSQLITE_THREADSAFE=1 -DSQLITE_USE_URI=1 -DSQLITE_TEMP_STORE=2 \
    -DSQLITE_ENABLE_COLUMN_METADATA=1 -DSQLITE_SECURE_DELETE=1 -DCODEC_TYPE=${SQLITE3MC_CODEC_TYPE_DEFINE} \
    src/sqlite3mc.c src/shell.c -lpthread -ldl -lm -o "${SQLITE3MC_SHELL}"

  "${SQLITE3MC_CC}" -O2 -g -fPIC -Isrc -Isrc/aegis/include -Isrc/argon2/include \
    -DSQLITE_THREADSAFE=1 -DSQLITE_USE_URI=1 -DSQLITE_TEMP_STORE=2 \
    -DSQLITE_ENABLE_COLUMN_METADATA=1 -DSQLITE_SECURE_DELETE=1 -DCODEC_TYPE=${SQLITE3MC_CODEC_TYPE_DEFINE} \
    "${SQLITE3MC_DYLIB_LINK_FLAGS[@]}" src/sqlite3mc.c -lpthread -ldl -lm -o "${SQLITE3MC_DYLIB}"
)

echo "sqlite3mc artifacts built."
