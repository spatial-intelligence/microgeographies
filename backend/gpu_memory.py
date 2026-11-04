"""Release lazy model caches between jobs, with a gate for GPU users."""
from contextlib import contextmanager
from functools import wraps
import gc
import sys
import threading


class BusyError(RuntimeError):
    pass


class Jobs:
    def __init__(self):
        self._lock = threading.Lock()
        self.active = 0
        self.clearing = False

    @contextmanager
    def job(self):
        with self._lock:
            if self.clearing:
                raise BusyError("GPU memory is being cleared. Try again shortly.")
            self.active += 1
        try:
            yield
        finally:
            with self._lock:
                self.active -= 1

    @contextmanager
    def cleanup(self):
        with self._lock:
            if self.active or self.clearing:
                raise BusyError("A processing job is still active. Wait for it to finish before clearing GPU memory.")
            self.clearing = True
        try:
            yield
        finally:
            with self._lock:
                self.clearing = False

    def track(self, function):
        @wraps(function)
        def wrapped(*args, **kwargs):
            with self.job():
                return function(*args, **kwargs)
        return wrapped


jobs = Jobs()
GPU_ROUTES = {"/api/detect", "/api/project", "/api/depth", "/api/batch",
              "/api/sfm", "/api/video-cloud"}


class GpuJobMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("method") != "POST" or scope.get("path") not in GPU_ROUTES:
            return await self.app(scope, receive, send)
        # Hold registration through the entire response, including streaming.
        registration = jobs.job()
        try:
            registration.__enter__()
        except BusyError as error:
            from starlette.responses import JSONResponse
            return await JSONResponse({"detail": str(error)}, status_code=409)(scope, receive, send)
        try:
            return await self.app(scope, receive, send)
        finally:
            registration.__exit__(None, None, None)


def clear_models(sam_namespace):
    """Drop model references without loading torch or any new models."""
    with jobs.cleanup():
        torch = sys.modules.get("torch")
        cuda = torch.cuda if torch is not None else None
        available = cuda is not None and cuda.is_available()
        before = cuda.memory_reserved() if available else 0
        if available:
            cuda.synchronize()
        caches = [(sam_namespace, ("_model", "_processor"))]
        for name, attributes in [
            ("da3", ("_da3_model", "_da3_model_id")),
            ("depth", ("_depth_model", "_depth_model_id", "_yolo_model", "_yolo_model_id")),
            ("clip_detect", ("_clip",)),
        ]:
            module = sys.modules.get(name)
            if module is not None:
                caches.append((vars(module), attributes))
        for namespace, attributes in caches:
            for attribute in attributes:
                namespace[attribute] = None
        gc.collect()  # also collect tensors retained in exception cycles
        if available:
            cuda.empty_cache()
        after = cuda.memory_reserved() if available else 0
        allocated = cuda.memory_allocated() if available else 0
        return {"ok": True, "cuda_available": bool(available),
                "released_bytes": max(0, before - after),
                "reserved_bytes": after, "allocated_bytes": allocated}
