#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
rm -f data.sqlite data.sqlite-wal data.sqlite-shm
PORT="${PORT:-3001}" node src/server.js
