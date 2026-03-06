#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ARTIFACTS_DIR="${ARTIFACTS_DIR:-${PROJECT_DIR}/artifacts}"

if [[ -d "${ARTIFACTS_DIR}" ]]; then
  rm -rf "${ARTIFACTS_DIR}"
  echo "Removed ${ARTIFACTS_DIR}"
else
  echo "No artifacts directory to remove at ${ARTIFACTS_DIR}"
fi
