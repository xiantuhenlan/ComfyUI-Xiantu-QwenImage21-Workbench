"""Plugin-owned H3 continuation data preparation. This module never samples.

Only official ComfyUI tensor/model APIs and this plugin's pure frame helpers
are used. No TimelineDirector node, package or runtime registration is needed.
"""
from __future__ import annotations

import math

import torch
from comfy.nested_tensor import NestedTensor

from .video_continuity import pixel_frames_for_latent_t


STATE_KEY = "xiantu_h3_continuation_state"
# Kept as an interoperability marker for workflows explicitly using an older
# bridge or sampler. A metadata key does not import or execute another plugin.
WRAPPER_KEY = "minimax_h3_timeline_drift_control_av"


def _av(value):
    streams = list(value.unbind()) if hasattr(value, "unbind") else list(value)
    if len(streams) != 2 or streams[0].ndim != 5 or streams[1].ndim != 4:
        raise ValueError("H3续接需要视频和音频双路AV Latent。")
    return streams


class _ContinuationMask:
    def __init__(self, video_shape, audio_shape, sigmas, prefix_steps):
        self.video_shape, self.audio_shape = tuple(video_shape), tuple(audio_shape)
        self.prefix_steps = int(prefix_steps)
        values = torch.as_tensor(sigmas).detach().float().cpu().reshape(-1).tolist()
        self.sigmas = sorted({float(x) for x in values if math.isfinite(x) and x >= 0}, reverse=True)
        self.current_packed_mask = self.current_video_mask = self.current_audio_mask = None
        self.selflift_base_mask = None
        self.selflift_hard_lock = False

    def _update(self, sigma, mask):
        result = mask.clone()
        n_video = math.prod(self.video_shape[1:])
        video = result[..., :n_video].reshape(self.video_shape)
        if not self.selflift_hard_lock:
            level = float(torch.as_tensor(sigma).detach().float().reshape(-1)[0])
            tolerance = max(1e-7, abs(level) * 1e-6)
            following = next((x for x in self.sigmas if x < level - tolerance), 0.0)
            fraction = max(0.0, min(1.0, following / level)) if math.isfinite(level) and level > 0 else 0.0
            positions = torch.arange(self.prefix_steps, device=video.device, dtype=video.dtype)
            taper = min(4, self.prefix_steps)
            weights = ((self.prefix_steps - 1 - positions) / taper).clamp(0, 1) * fraction
            video[:, :, :self.prefix_steps] = weights.view(1, 1, -1, 1, 1)
        self.current_packed_mask = result
        self.current_video_mask = torch.ceil(video[:, :1].float() * 256).div(256)
        self.current_audio_mask = result[..., n_video:].reshape(self.audio_shape)[:, :1].clone()
        return result

    def denoise_mask_function(self, sigma, denoise_mask, extra_options=None):
        if not self.sigmas and extra_options and extra_options.get("sigmas") is not None:
            values = torch.as_tensor(extra_options["sigmas"]).detach().float().cpu().reshape(-1).tolist()
            self.sigmas = sorted({float(x) for x in values if math.isfinite(x) and x >= 0}, reverse=True)
        return self._update(sigma, denoise_mask)

    def configure_selflift_stage(self, video_shape, video_mask, audio_mask, hard_lock=False):
        self.video_shape = tuple(video_shape)
        self.selflift_hard_lock = bool(hard_lock)
        video = video_mask.expand(self.video_shape).reshape(self.video_shape[0], 1, -1)
        audio = audio_mask.expand(self.audio_shape).reshape(self.audio_shape[0], 1, -1)
        self.selflift_base_mask = torch.cat((video, audio), dim=-1)
        self.current_video_mask, self.current_audio_mask = video_mask, audio_mask

    def apply_model_wrapper(self, executor, *args, **kwargs):
        if self.selflift_base_mask is not None:
            sigma = args[1] if len(args) > 1 else kwargs.get("t")
            if sigma is not None:
                self._update(sigma, self.selflift_base_mask)
        if self.current_video_mask is not None:
            kwargs["denoise_mask"] = self.current_video_mask
        if self.current_audio_mask is not None:
            kwargs["audio_denoise_mask"] = self.current_audio_mask
        return executor(*args, **kwargs)


class XiantuH3LatentContinuation:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "positive": ("CONDITIONING",), "target_latent": ("LATENT",),
            "model": ("MODEL",), "sigmas": ("SIGMAS",),
            "previous_latent": ("LATENT",),
            "overlap_frames": ("INT", {"default": 22, "min": 0, "max": 3592}),
            "continue_audio_latent": ("BOOLEAN", {"default": True}),
        }}

    RETURN_TYPES = ("CONDITIONING", "LATENT", "INT", "MODEL")
    RETURN_NAMES = ("条件", "Latent", "重叠帧数", "模型")
    FUNCTION = "prepare"
    CATEGORY = "闲兔/视频编辑/内部"

    def prepare(self, positive, target_latent, model, sigmas, previous_latent,
                overlap_frames=22, continue_audio_latent=True):
        requested = int(overlap_frames)
        if requested == 0:
            return positive, target_latent, 0, model
        video, audio = _av(target_latent["samples"])
        previous_video, previous_audio = _av(previous_latent["samples"])
        # Align only spatial axes; preserve temporal order and audio unchanged.
        if previous_video.shape[-2:] != video.shape[-2:]:
            previous_shape = previous_video.shape
            previous_video = torch.nn.functional.interpolate(
                previous_video.reshape(-1, 1, *previous_shape[-2:]).float(),
                size=video.shape[-2:], mode="bilinear", align_corners=False,
            ).to(dtype=previous_video.dtype).reshape(*previous_shape[:3], *video.shape[-2:])
        if tuple(video.shape[1:2] + video.shape[3:]) != tuple(previous_video.shape[1:2] + previous_video.shape[3:]):
            raise ValueError("上一分镜与当前分镜的H3 Latent空间尺寸不一致。")
        prefix = next((n for n in range(1, int(previous_video.shape[2]) + 1)
                       if pixel_frames_for_latent_t(n) >= requested), 0)
        if prefix < 1 or prefix >= int(video.shape[2]):
            raise ValueError("上一分镜或当前分镜的Latent不足以容纳所选续接帧数。")
        frames = pixel_frames_for_latent_t(prefix)
        new_video, new_audio = video.clone(), audio.clone()
        new_video[:, :, :prefix] = previous_video[:1, :, -prefix:].to(new_video)
        video_mask = torch.ones((1, 1, video.shape[2], 1, 1), device=video.device, dtype=torch.float32)
        video_mask[:, :, :prefix] = 0
        audio_mask = torch.ones((1, 1, 1, audio.shape[-1]), device=audio.device, dtype=torch.float32)
        if continue_audio_latent:
            count = min(round(frames * 40 / 24), int(previous_audio.shape[-1]), int(audio.shape[-1]))
            if tuple(audio.shape[1:-1]) != tuple(previous_audio.shape[1:-1]) or count < 1:
                raise ValueError("上一分镜的H3音频Latent尺寸与当前分镜不兼容。")
            new_audio[..., :count] = previous_audio[:1, ..., -count:].to(new_audio)
            audio_mask[..., :count] = 0
            release = min(8, count)
            phase = torch.arange(1, release + 1, device=audio.device, dtype=audio_mask.dtype) / release
            audio_mask[..., count - release:count] = (1 - torch.cos(phase * math.pi)) * .5
        latent = dict(target_latent)
        latent["samples"] = NestedTensor((new_video, new_audio))
        latent["noise_mask"] = NestedTensor((video_mask, audio_mask))
        if previous_latent.get("selflift_low_resolution_carry") is not None:
            latent["selflift_previous_low_resolution_carry"] = previous_latent["selflift_low_resolution_carry"]
        if callable(model.model_options.get("denoise_mask_function")):
            raise ValueError("H3续接不能叠加另一套动态重绘遮罩，请检查模型分支。")
        from comfy.patcher_extension import WrappersMP
        patched = model.clone()
        state = _ContinuationMask(video.shape, audio.shape, sigmas, prefix)
        patched.model_options[STATE_KEY] = state
        patched.model_options[WRAPPER_KEY] = state
        patched.set_model_denoise_mask_function(state.denoise_mask_function)
        patched.add_wrapper_with_key(WrappersMP.APPLY_MODEL, WRAPPER_KEY, state.apply_model_wrapper)
        return positive, latent, frames, patched


NODE_CLASS_MAPPINGS = {"XiantuH3LatentContinuation": XiantuH3LatentContinuation}
NODE_DISPLAY_NAME_MAPPINGS = {"XiantuH3LatentContinuation": "闲兔｜H3续接数据准备（内部）"}
