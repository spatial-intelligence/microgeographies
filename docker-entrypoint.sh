#!/bin/bash
# Container entrypoint: warm the depth weights, report COLMAP/GPU state,
# then serve page + API on 0.0.0.0:8000.
set -eu
cd /srv/app

export HF_HOME="${HF_HOME:-/hf-cache}"
export HF_HUB_CACHE="$HF_HOME/hub"

/opt/venv/bin/python backend/preload_depth.py || exit 1

if command -v colmap >/dev/null 2>&1; then
  echo "colmap: $(colmap --version 2>/dev/null | head -1)"
else
  echo "colmap: MISSING — /api/sfm will return 503 (everything else works)"
fi
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi -L || echo "nvidia-smi present but no GPU visible — COLMAP runs on CPU"
else
  echo "no nvidia-smi — running without a GPU (COLMAP uses CPU)"
fi

echo "Open http://localhost:8000 in a browser (or http://<host-ip>:8000 remotely)."
exec env MOCK_SAM="${MOCK_SAM:-1}" /opt/venv/bin/python -m uvicorn server:app \
  --app-dir backend --host 0.0.0.0 --port 8000
