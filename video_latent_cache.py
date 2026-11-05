"""Durable per-shot H3 AV latent cache for the video director.

The director still queues one storyboard shot at a time.  These two internal
nodes bridge the sampled latent between those independent ComfyUI prompts so
the MiniMax H3 Timeline Director continuation node can reuse the exact AV
latent tail instead of decoding the previous MP4.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path

import folder_paths
import torch
from comfy.ldm.minimax.model import FRAME_PER_TOKEN
from comfy.nested_tensor import NestedTensor


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
             overlap_frames=22):
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
        from .video_editor import _load_video
        frames, audio = _load_video(json.loads(previous_output))
        count = int(overlap_frames)
        if len(frames) < count:
            raise ValueError("上一分镜视频不足所选上下文帧数。")
        video = video_vae.encode(frames[-count:])
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
