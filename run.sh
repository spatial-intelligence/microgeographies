#!/bin/bash
# Microgeographies — page + API from one server, one URL.
#
# Usage: ./run.sh            (from the project root)
#        open http://localhost:8000 in a browser.
#        Ctrl-C stops the server.
#
# The backend serves the page itself, so Meta-direct boxes reach
# /api/project on the same origin (cross-port calls used to fail
# silently, leaving depth + pins empty). Point Endpoint at
# http://127.0.0.1:8000/api/detect to use the local detector instead.
#
# MOCK_SAM=1 skips the SAM 3 weight download (deterministic demo boxes).
# Drop it for real SAM 3 (needs torch + GPU for speed). Depth is always
# the real Depth Anything Small model (~95 MB first download); override
# with DEPTH_MODEL_ID=<hf-id> (needs a transformers-native checkpoint —
# Depth Anything V3 has no PyTorch release yet, only ONNX/mobile ports).
set -u
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
  echo "No .venv found. Create it first:"
  echo "  python3 -m venv .venv && .venv/bin/pip install -r backend/requirements.txt"
  exit 1
fi

# Depth weights live here permanently (outside the repo, inside your home).
# First run downloads ~95 MB once; every later start reuses it from disk.
# (CLIP weights ~350 MB land in the same cache on first Local-CLIP use.)
export HF_HOME="${HF_HOME:-$HOME/.cache/microgeographies}"
export HF_HUB_CACHE="$HF_HOME/hub"
.venv/bin/python backend/preload_depth.py || exit 1

echo "Open http://localhost:8000 in a browser."
exec env MOCK_SAM=1 .venv/bin/python -m uvicorn server:app --app-dir backend \
  --host 127.0.0.1 --port 8000
