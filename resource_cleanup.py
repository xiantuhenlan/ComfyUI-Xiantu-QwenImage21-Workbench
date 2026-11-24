"""Independent worker-owned resource cleanup for this plugin."""
import logging
import threading
import time

_CLEANUP_FLAG = "xiantu_director_cleanup"
_BRIDGE_LOCK = threading.Lock()


def unload_cached_models(model_management):
    cache = model_management.current_loaded_models
    entries = tuple(cache)
    devices = model_management.get_all_torch_devices()
    patchers = [entry.model for entry in entries]
    finalizers = [getattr(entry, "model_finalizer", None) for entry in entries]
    for entry, patcher, finalizer in zip(entries, patchers, finalizers):
        if patcher is not None and entry.device not in devices:
            continue
        if patcher is not None:
            patcher.detach(True)
        if finalizer is not None:
            finalizer.detach()
        entry.model_finalizer = None
        entry.real_model = None
        for index, current in enumerate(cache):
            if current is entry:
                cache.pop(index)
                break


class _WorkerCleanup:
    """Run cleanup at PromptQueue's existing worker flag boundary."""

    def __init__(self, queue):
        self.queue = queue
        self.pending = []
        self.active = []
        self.worker = None
        self.original_get = queue.get
        self.original_get_flags = queue.get_flags
        queue.get = self.get
        queue.get_flags = self.get_flags

    def get(self, *args, **kwargs):
        # The next get occurs after the worker's executor reset/GC/cache flush.
        if self.worker == threading.get_ident() and self.active:
            finished, self.active = self.active, []
            for job in finished:
                job["done"].set()
            logging.info("[闲兔导演台] 资源清理完成，生成线程可继续下一分镜")
        return self.original_get(*args, **kwargs)

    def get_flags(self, reset=True):
        flags = self.original_get_flags(reset=reset)
        if not reset or not flags.pop(_CLEANUP_FLAG, False):
            return flags
        with self.queue.mutex:
            jobs, self.pending = self.pending, []
            jobs = [job for job in jobs if not job["cancelled"]]
            if self.queue.currently_running or self.queue.queue:
                for job in jobs:
                    job["warnings"].append("生成队列仍有任务，本次跳过资源清理")
                    job["done"].set()
                return flags
            for job in jobs:
                job["started"] = True
        if not jobs:
            return flags
        self.active = jobs
        self.worker = threading.get_ident()
        settings = {key: any(job["settings"].get(key) for job in jobs)
                    for key in ("models", "vram", "cache")}
        try:
            import comfy.model_management as management
            if settings["models"]:
                logging.info("[闲兔导演台] 资源清理：卸载已加载模型")
                unload_cached_models(management)
            if settings["cache"]:
                logging.info("[闲兔导演台] 资源清理：重置生成缓存，等待内核回收内存和显存")
                # Preserve an independently requested native model unload.
                if not flags.get("free_memory"):
                    flags.setdefault("unload_models", False)
                flags["free_memory"] = True
            elif settings["vram"] or settings["models"]:
                logging.info("[闲兔导演台] 资源清理：释放空闲显存缓存")
                management.soft_empty_cache()
        except Exception as error:
            logging.exception("[闲兔导演台] 资源清理失败")
            for job in jobs:
                job["error"] = str(error)
        return flags


def cleanup_idle_resources(server, settings, check=lambda: None):
    if not any(settings.get(key) for key in ("models", "vram", "cache")):
        return {"warnings": []}
    check()
    queue = getattr(server, "prompt_queue", None)
    if queue is None or not all(hasattr(queue, name) for name in ("mutex", "get", "get_flags", "set_flag")):
        return {"warnings": ["无法确认生成线程接口，本次跳过资源清理"]}
    with _BRIDGE_LOCK:
        bridge = getattr(queue, "_xiantu_director_cleanup", None)
        if bridge is None:
            bridge = _WorkerCleanup(queue)
            queue._xiantu_director_cleanup = bridge
    job = {"settings": dict(settings), "done": threading.Event(), "started": False,
           "cancelled": False, "warnings": [], "error": None}
    with queue.mutex:
        if queue.currently_running or queue.queue:
            return {"warnings": ["生成队列仍有任务，本次跳过资源清理"]}
        bridge.pending.append(job)
        queue.set_flag(_CLEANUP_FLAG, True)
    logging.info("[闲兔导演台] 资源清理：等待生成线程收尾")
    deadline = time.monotonic() + 60
    try:
        while not job["done"].wait(.1):
            check()
            if time.monotonic() >= deadline:
                raise RuntimeError("等待生成线程完成资源清理超时")
            # A notification can precede the worker entering its idle wait.
            if not job["started"]:
                queue.set_flag(_CLEANUP_FLAG, True)
        check()
        if job["error"]:
            raise RuntimeError(job["error"])
        return {"warnings": job["warnings"]}
    finally:
        with queue.mutex:
            job["cancelled"] = True
            bridge.pending = [pending for pending in bridge.pending if pending is not job]
