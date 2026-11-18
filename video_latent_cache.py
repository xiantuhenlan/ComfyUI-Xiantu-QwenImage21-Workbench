"""Durable per-shot H3 AV latent cache for the video director.

The director still queues one storyboard shot at a time.  These two internal
nodes bridge the sampled latent between those independent ComfyUI prompts so
the MiniMax H3 Timeline Director continuation node can reuse the exact AV
latent tail instead of decoding the previous MP4.
"""

from __future__ import annotations

import hashlib
import asyncio
import json
import os
from pathlib import Path

import folder_paths
import torch
from aiohttp import web
from server import PromptServer
from comfy.ldm.minimax.model import FRAME_PER_TOKEN
from comfy.nested_tensor import NestedTensor


def _recover_saved_video(workbench_id, shot_id):
    import av

    if not workbench_id or not shot_id:
        raise ValueError("恢复承接需要当前导演台和上一分镜标识。")
    output_root = Path(folder_paths.get_output_directory()).resolve()
    video_root = output_root / "短剧-漫剧"
    candidates = sorted(
        video_root.rglob("*.mp4") if video_root.is_dir() else [],
        key=lambda item: ("/放大后/" in item.as_posix(), item.stat().st_mtime_ns),
        reverse=True,
    )
    for path in candidates:
        if "合并成品" in path.parts or "合并成片" in path.parts:
            continue
        try:
            resolved = path.resolve()
            if not resolved.is_relative_to(output_root):
                continue
            with av.open(str(resolved)) as container:
                prompt = json.loads(container.metadata.get("prompt") or "{}")
                workbench = prompt.get(str(workbench_id), {})
                if workbench.get("class_type") != "XiantuVideoEditorWorkbench":
                    continue
                state = json.loads(workbench.get("inputs", {}).get("editor_state") or "{}")
                if str(state.get("activeShotId") or "") != str(shot_id):
                    continue
                if not any(str(item.get("id") or "") == str(shot_id) for item in state.get("shots", [])):
                    continue
                stream = next(iter(container.streams.video), None)
                if stream is None or not stream.duration or not stream.time_base:
                    continue
                relative = resolved.relative_to(output_root)
                return {
                    "filename": relative.name,
                    "subfolder": relative.parent.as_posix(),
                    "type": "output",
                    "shotId": str(shot_id),
                    "width": stream.width,
                    "height": stream.height,
                    "duration": float(stream.duration * stream.time_base),
                }
        except (OSError, ValueError, TypeError, AttributeError):
            continue
    return None


@PromptServer.instance.routes.post("/xiantu/video-editor/recover-saved-output")
async def recover_saved_output(request):
    try:
        payload = await request.json()
        output = await asyncio.to_thread(
            _recover_saved_video, str(payload.get("workbench_id") or ""), str(payload.get("shot_id") or ""),
        )
        return web.json_response({"ok": True, "output": output})
    except (ValueError, TypeError, OSError) as error:
        return web.json_response({"ok": False, "error": str(error)}, status=400)


def _cache_path(cache_key: str) -> Path:
    digest = hashlib.sha256(str(cache_key or "").encode("utf-8")).hexdigest()
    root = Path(folder_paths.get_temp_directory()) / "xiantu_video_latent_cache"
    root.mkdir(parents=True, exist_ok=True)
    return root / f"{digest}.pt"


def _cpu_copy(value):
    if torch.is_tensor(value):
        return value.detach().to(device="cpu", copy=True)
    if isinstance(value, dict):
        return {key: _cpu_copy(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_cpu_copy(item) for item in value]
    if isinstance(value, tuple):
        return tuple(_cpu_copy(item) for item in value)
    # MiniMax H3 uses ComfyUI's NestedTensor for its video/audio pair.
    if value.__class__.__name__ == "NestedTensor" and callable(getattr(value, "to", None)):
        return value.to("cpu")
    return value


def _video_tokens_through_frame(frame_end: int, available_tokens: int) -> int:
    """Return the smallest H3 temporal prefix that reaches frame_end.

    H3 deliberately over-generates to its valid temporal grid.  The director
    then crops the decoded result to the requested duration.  Continuation must
    therefore end at the last *exported* frame, not at the hidden end of that
    over-generated latent.
    """
    requested = max(1, int(frame_end))
    covered = 0
    for token in range(max(0, int(available_tokens))):
        covered += int(FRAME_PER_TOKEN[token % len(FRAME_PER_TOKEN)])
        if covered >= requested:
            return token + 1
    return max(0, int(available_tokens))


def _crop_to_visible_end(latent, visible_end_frames: int):
    if not isinstance(latent, dict) or int(visible_end_frames or 0) <= 0:
        return latent
    samples = latent.get("samples")
    if samples is None or not getattr(samples, "is_nested", False):
        return latent
    streams = list(samples.unbind())
    if len(streams) != 2 or streams[0].ndim != 5 or streams[1].ndim != 4:
        return latent

    video, audio = streams
    video_tokens = _video_tokens_through_frame(visible_end_frames, video.shape[2])
    # MiniMax H3 audio runs at 40 latent tokens per 24 video frames.
    audio_tokens = min(int(audio.shape[-1]), max(1, round(int(visible_end_frames) * 40 / 24)))
    output = dict(latent)
    output["samples"] = NestedTensor((
        video[:, :, :video_tokens].clone(),
        audio[..., :audio_tokens].clone(),
    ))
    # A sampler noise mask describes the discarded full temporal grid.  It is
    # neither needed nor shape-compatible when this cache becomes the source
    # latent for the next independent prompt.
    output.pop("noise_mask", None)
    return output


class XiantuVideoLatentCacheLoad:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"cache_key": ("STRING", {"default": ""})},
                "optional": {"previous_output": ("STRING", {"default": ""}),
                             "video_vae": ("VAE",), "audio_vae": ("VAE",),
                             "target_latent": ("LATENT",),
                             "overlap_frames": ("INT", {"default": 22, "min": 1, "max": 2048})}}

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("上一分镜AV Latent",)
    FUNCTION = "load"
    CATEGORY = "闲兔/视频编辑/内部"

    @classmethod
    def IS_CHANGED(cls, cache_key, **_kwargs):
        path = _cache_path(cache_key)
        return path.stat().st_mtime_ns if path.is_file() else float("nan")

    def load(self, cache_key, previous_output="", video_vae=None, audio_vae=None,
             overlap_frames=22, target_latent=None):
        path = _cache_path(cache_key)
        if cache_key and path.is_file():
            try:
                return (torch.load(path, map_location="cpu", weights_only=False),)
            except Exception as error:
                raise ValueError(f"上一分镜AV Latent缓存读取失败：{error}") from error
        if not previous_output:
            raise ValueError("上一分镜的AV Latent缓存不存在，且没有已保存的上一分镜音视频可恢复。")
        if video_vae is None or audio_vae is None:
            raise ValueError("恢复上一分镜AV数据需要连接视频VAE和音频VAE；不会改用另一套续接算法。")
        import json
        import comfy.audio
        from .video_editor import _load_video, _resize_video_frames
        frames, audio = _load_video(json.loads(previous_output))
        count = int(overlap_frames)
        if len(frames) < count:
            raise ValueError("上一分镜视频不足所选上下文帧数。")
        tail = frames[-count:]
        if target_latent is not None:
            target_samples = target_latent["samples"]
            target_video = list(target_samples.unbind())[0] if getattr(target_samples, "is_nested", False) else target_samples
            width, height = int(target_video.shape[-1]) * 16, int(target_video.shape[-2]) * 16
            if tuple(tail.shape[1:3]) != (height, width):
                tail = _resize_video_frames(tail, width, height)
        video = video_vae.encode(tail)
        sample_rate = int(getattr(audio_vae, "audio_sample_rate", 32000))
        if isinstance(audio, dict) and torch.is_tensor(audio.get("waveform")):
            waveform = audio["waveform"]
            source_rate = int(audio["sample_rate"])
            waveform = waveform[..., -round(count / 24 * source_rate):]
            if source_rate != sample_rate:
                waveform = comfy.audio.resample(waveform, source_rate, sample_rate)
        else:
            waveform = torch.zeros((1, 2, round(count / 24 * sample_rate)))
        sound = audio_vae.encode(waveform[:1].movedim(1, -1))
        return ({"samples": NestedTensor((video, sound))},)


class XiantuVideoLatentCacheSave:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "latent": ("LATENT",),
                "cache_key": ("STRING", {"default": ""}),
            },
            "optional": {
                "visible_end_frames": ("INT", {"default": 0, "min": 0, "max": 8192}),
            },
        }

    RETURN_TYPES = ("LATENT", "STRING")
    RETURN_NAMES = ("Latent", "缓存状态")
    FUNCTION = "save"
    CATEGORY = "闲兔/视频编辑/内部"
    OUTPUT_NODE = True

    def save(self, latent, cache_key, visible_end_frames=0):
        path = _cache_path(cache_key)
        temporary = path.with_suffix(f".{os.getpid()}.tmp")
        try:
            cache_value = _crop_to_visible_end(latent, visible_end_frames)
            torch.save(_cpu_copy(cache_value), temporary)
            os.replace(temporary, path)
        finally:
            if temporary.exists():
                temporary.unlink(missing_ok=True)
        return latent, f"已保存分镜AV Latent：{path.name}"


NODE_CLASS_MAPPINGS = {
    "XiantuVideoLatentCacheLoad": XiantuVideoLatentCacheLoad,
    "XiantuVideoLatentCacheSave": XiantuVideoLatentCacheSave,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiantuVideoLatentCacheLoad": "闲兔｜读取上一分镜AV Latent（内部）",
    "XiantuVideoLatentCacheSave": "闲兔｜保存分镜AV Latent（内部）",
}
