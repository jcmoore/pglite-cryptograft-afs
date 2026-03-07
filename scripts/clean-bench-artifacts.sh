#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-${PROJECT_DIR}/artifacts}"

if [[ ! -d "${ARTIFACTS_DIR}" ]]; then
  echo "No artifacts directory at ${ARTIFACTS_DIR}"
  exit 0
fi

find "${ARTIFACTS_DIR}" -maxdepth 1 -type d \
  \( -name 'bench-graft.*' -o -name 'bench-graft-p*.*' -o -name 'bench-json.*' \) \
  -exec rm -rf {} +

echo "Cleaned temporary bench artifacts in ${ARTIFACTS_DIR}"
