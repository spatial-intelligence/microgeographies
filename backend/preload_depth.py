"""One-time depth-weight fetch with a visible cache report.

Usage: .venv/bin/python backend/preload_depth.py

Downloads the depth model into HF_HOME on first run (progress bar shown
by huggingface_hub); later runs and server starts reuse it from disk —
only the seconds-long RAM load repeats, never the download. Skipped
automatically when MOCK_DEPTH=1.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import depth  # noqa: E402


def cache_size_mb(home):
    total = 0
    for root, _dirs, files in os.walk(home):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total / 1e6


def main():
    if os.getenv("MOCK_DEPTH") == "1":
        print("MOCK_DEPTH=1 — no weights needed.")
        return 0
    print("model:", depth.DEFAULT_DEPTH_MODEL)
    home = os.environ.get("HF_HOME", os.path.expanduser("~/.cache/huggingface"))
    print("cache:", home)
    from PIL import Image
    img = Image.new("RGB", (64, 48), (128, 128, 128))
    grid = depth.estimate_depth_grid(img)["grid"]
    print(f"ready: {len(grid[0])}x{len(grid)} test grid, "
          f"cache now {cache_size_mb(home):.0f} MB on disk")
    return 0


if __name__ == "__main__":
    sys.exit(main())
