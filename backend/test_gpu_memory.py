"""Memory cleanup must unload caches and never race processing jobs."""
import sys
import types
from pathlib import Path
import threading

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import gpu_memory


def test_cleanup_unloads_models_and_releases_cache(monkeypatch):
    calls = []
    reserved = iter([14000, 1000])
    cuda = types.SimpleNamespace(
        is_available=lambda: True,
        memory_reserved=lambda: next(reserved),
        memory_allocated=lambda: 500,
        synchronize=lambda: calls.append("sync"),
        empty_cache=lambda: calls.append("empty"),
    )
    monkeypatch.setitem(sys.modules, "torch", types.SimpleNamespace(cuda=cuda))
    models = {
        "da3": {"_da3_model": object(), "_da3_model_id": "giant"},
        "depth": {"_depth_model": object(), "_depth_model_id": "depth",
                  "_yolo_model": object(), "_yolo_model_id": "yolo"},
        "clip_detect": {"_clip": object()},
    }
    for name, values in models.items():
        monkeypatch.setitem(sys.modules, name, types.SimpleNamespace(**values))
    sam = {"_model": object(), "_processor": object()}
    result = gpu_memory.clear_models(sam)
    assert result["released_bytes"] == 13000
    assert result["reserved_bytes"] == 1000
    assert result["allocated_bytes"] == 500
    assert all(value is None for value in sam.values())
    for name, values in models.items():
        assert all(getattr(sys.modules[name], key) is None for key in values)
    assert calls == ["sync", "empty"]


def test_no_torch_loaded(monkeypatch):
    monkeypatch.delitem(sys.modules, "torch", raising=False)
    result = gpu_memory.clear_models({"_model": object(), "_processor": object()})
    assert result["ok"] and not result["cuda_available"]
    assert "torch" not in sys.modules


def test_active_job_prevents_cleanup_and_preserves_models():
    sam = {"_model": object()}
    original = sam["_model"]
    with gpu_memory.jobs.job():
        with pytest.raises(gpu_memory.BusyError, match="still active"):
            gpu_memory.clear_models(sam)
    assert sam["_model"] is original


def test_cleanup_blocks_new_jobs_and_releases_gate_on_failure():
    jobs = gpu_memory.Jobs()
    with pytest.raises(ValueError):
        with jobs.cleanup():
            with pytest.raises(gpu_memory.BusyError):
                with jobs.job():
                    pass
            raise ValueError("cleanup failed")
    with jobs.job():
        assert jobs.active == 1
    assert jobs.active == 0


def test_background_worker_stays_registered_after_request_ends():
    jobs = gpu_memory.Jobs()
    started, finish = threading.Event(), threading.Event()

    @jobs.track
    def worker():
        started.set()
        finish.wait(timeout=5)

    try:
        with jobs.job():
            thread = threading.Thread(target=worker)
            thread.start()
            assert started.wait(timeout=2)
        with pytest.raises(gpu_memory.BusyError):
            with jobs.cleanup():
                pass
    finally:
        finish.set()
        thread.join(timeout=2)
    with jobs.cleanup():
        assert jobs.active == 0


def test_endpoint_and_request_gate(monkeypatch):
    from fastapi.testclient import TestClient
    import server
    client = TestClient(server.app)
    monkeypatch.delitem(sys.modules, "torch", raising=False)
    assert client.post("/api/gpu/clear").json()["ok"]
    with gpu_memory.jobs.job():
        response = client.post("/api/gpu/clear")
        assert response.status_code == 409
        assert "still active" in response.json()["detail"]
    with gpu_memory.jobs.cleanup():
        # Rejected before request validation or inference begins.
        assert client.post("/api/detect").status_code == 409
    assert client.post("/api/detect").status_code == 422
