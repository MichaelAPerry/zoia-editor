#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
exec python3 -m http.server 8280 --bind localhost
