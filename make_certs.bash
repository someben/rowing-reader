#!/usr/bin/env bash
set -euo pipefail

# Install mkcert on Ubuntu-like systems and generate local certs.
# This script is idempotent; it will overwrite existing cert files.

if ! command -v apt-get >/dev/null 2>&1; then
  echo "error: apt-get not found. This script targets Ubuntu-like systems." >&2
  exit 2
fi

if ! command -v mkcert >/dev/null 2>&1; then
  sudo apt-get update
  # mkcert needs libnss3-tools for local CA installation.
  sudo apt-get install -y mkcert libnss3-tools
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERT_DIR="${ROOT_DIR}/certs"
mkdir -p "${CERT_DIR}"

# Best-effort LAN IP detection.
LOCAL_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '/src/ {print $7; exit}')"
if [[ -z "${LOCAL_IP}" ]]; then
  LOCAL_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi
if [[ -z "${LOCAL_IP}" ]]; then
  LOCAL_IP="192.168.1.178"
fi

mkcert -install
mkcert \
  -cert-file "${CERT_DIR}/rowing-reader.local.pem" \
  -key-file "${CERT_DIR}/rowing-reader.local-key.pem" \
  "${LOCAL_IP}" rowing-reader.local

echo "Generated certs:"
echo "  ${CERT_DIR}/rowing-reader.local.pem"
echo "  ${CERT_DIR}/rowing-reader.local-key.pem"
echo "For HTTPS, run:"
echo "  python ${ROOT_DIR}/serve_local.py --host ${LOCAL_IP}"
