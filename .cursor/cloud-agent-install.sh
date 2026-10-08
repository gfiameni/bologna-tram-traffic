#!/usr/bin/env bash
set -euo pipefail

if ! python3.12 -c "import venv" 2>/dev/null; then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y python3.12-venv
fi

npm ci
python3.12 -m venv .venv
.venv/bin/pip install -q -r requirements.txt
