"""Sampling-stage MiniMax H3 continuation helpers owned by the video workbench."""

from __future__ import annotations

import math

import torch
import torch.nn.functional as F

from comfy.nested_tensor import NestedTensor


FPS = 24.0
FRAME_PER_TOKEN = (1, 4, 4, 4, 4)
CONTEXT_FRAME_CHOICES = (5, 22, 39, 56)
PREFIX_STEPS_KEY = "_xiantu_video_continue_prefix_steps"
SEAM_MIN_KEY = "_xiantu_video_continue_seam_min"
TRIM_FRAMES_KEY = "_xiantu_video_continue_trim_frames"
VISIBLE_FRAMES_KEY = "_xiantu_video_continue_visible_frames"
_WRAPPER_KEY = "xiantu_video_continue_prefix_remask"


def pixel_frames_for_latent_t(latent_t):
    return sum(FRAME_PER_TOKEN[index % len(FRAME_PER_TOKEN)] for index in range(int(latent_t)))


def _streams(value):
    if torch.is_tensor(value):
        return [value]
    if hasattr(value, "unbind"):
        return list(value.unbind())
    if hasattr(value, "tensors"):
        return list(value.tensors)
    if isinstance(value, (tuple, list)):
        return list(value)
    raise TypeError("MiniMax H3 latent does not contain readable AV streams")


def _nested(video, audio):
    return NestedTensor((video, audio))


def _resize_frames(frames, width, height):
    source = frames[..., :3].movedim(-1, 1)
    source_h, source_w = int(source.shape[2]), int(source.shape[3])
    scale = max(width / max(1, source_w), height / max(1, source_h))
    scaled_w = max(width, round(source_w * scale))
    scaled_h = max(height, round(source_h * scale))
    resized = F.interpolate(source, size=(scaled_h, scaled_w), mode="bilinear", align_corners=False)
    left = max(0, (scaled_w - width) // 2)
    top = max(0, (scaled_h - height) // 2)
    return resized[:, :, top:top + height, left:left + width].movedim(1, -1)


def _repair_leading_white_flash(images, start, stop, max_probe=4):
    """Replace a transient overexposed seam without changing frame count."""
    output = images[start:stop]
    if start < 1 or int(output.shape[0]) < 2:
        return output

    probe_count = min(max(1, int(max_probe)), int(output.shape[0]) - 1)
    anchor_rgb = images[start - 1:start, ..., :3].float()
    probe_rgb = output[:probe_count + 1, ..., :3].float()
    reduce_dims = tuple(range(1, probe_rgb.ndim))
    anchor_mean = float(anchor_rgb.mean())
    means = probe_rgb.mean(dim=reduce_dims)
    deviations = probe_rgb.std(dim=reduce_dims, unbiased=False)

    leading_flash = 0
    for index in range(probe_count):
        if (float(means[index]) >= 0.82
                and float(deviations[index]) <= 0.30
                and float(means[index]) - anchor_mean >= 0.20):
            leading_flash += 1
        else:
            break
    if leading_flash < 1:
        return output

    recovery_mean = float(means[leading_flash])
    flash_floor = float(means[:leading_flash].min())
    if flash_floor - max(anchor_mean, recovery_mean) < 0.18:
        return output

    repaired = output.clone()
    anchor = images[start - 1:start].to(device=repaired.device, dtype=repaired.dtype)
    recovery = output[leading_flash:leading_flash + 1]
    for index in range(leading_flash):
        alpha = float(index + 1) / float(leading_flash + 1)
        repaired[index:index + 1] = torch.lerp(anchor, recovery, alpha)
    return repaired


def _prefix_weights(prefix_steps, seam_min):
    taper = max(1, min(4, int(prefix_steps)))
    weights = torch.ones(int(prefix_steps), dtype=torch.float32)
    weights[-taper:] = torch.linspace(1.0, float(seam_min), taper, dtype=torch.float32)
    return weights


def _encode_audio_tail(audio_vae, audio, seconds):
    if audio_vae is None or not isinstance(audio, dict) or not torch.is_tensor(audio.get("waveform")):
        return None
    waveform = audio["waveform"]
    if waveform.numel() < 1:
        return None
    source_rate = int(audio.get("sample_rate") or 32000)
    target_rate = int(getattr(audio_vae, "audio_sample_rate", 32000) or 32000)
    if source_rate != target_rate:
        import torchaudio
        waveform = torchaudio.functional.resample(waveform, source_rate, target_rate)
    wanted = max(1, int(round(float(seconds) * target_rate)))
    waveform = waveform[..., -wanted:]
    return audio_vae.encode(waveform[:1].movedim(1, -1))


def apply_latent_continue(latent, previous_frames, previous_audio, vae, audio_vae,
                          requested_frames, redraw_amount, width, height, visible_frames):
    if vae is None:
        raise ValueError("承接上一分镜需要连接视频 VAE。")
    available = int(previous_frames.shape[0])
    requested = max(5, int(requested_frames or 22))
    context_frames = next((value for value in reversed(CONTEXT_FRAME_CHOICES)
                           if value <= min(requested, available)), 0)
    if context_frames < 5:
        raise ValueError("上一分镜输出不足 5 帧，无法建立动作上下文。")

    streams = _streams(latent.get("samples"))
    if len(streams) != 2:
        raise ValueError("引导+重绘需要 MiniMax H3 音视频联合 Latent。")
    target_video, target_audio = streams
    tail = _resize_frames(previous_frames[-context_frames:], width, height)
    encoded = vae.encode(tail)
    prefix_steps = min(int(encoded.shape[2]), int(target_video.shape[2]) - 1)
    if prefix_steps < 1:
        raise ValueError("当前分镜时长不足，无法写入上一分镜上下文。")

    video = target_video.clone()
    video[:, :, :prefix_steps] = encoded[:, :, :prefix_steps].to(video)
    audio = target_audio.clone()
    audio_steps = 0
    encoded_audio = _encode_audio_tail(audio_vae, previous_audio, context_frames / FPS)
    if torch.is_tensor(encoded_audio):
        audio_steps = min(int(encoded_audio.shape[-1]), int(audio.shape[-1]))
        audio[..., :audio_steps] = encoded_audio[..., -audio_steps:].to(audio)

    seam_min = max(0.0, min(0.95, float(redraw_amount if redraw_amount is not None else 0.10)))
    weights = _prefix_weights(prefix_steps, seam_min)
    video_mask = torch.ones((1, 1, int(video.shape[2]), int(video.shape[3]), int(video.shape[4])), device=video.device, dtype=torch.float32)
    video_mask[:, :, :prefix_steps] = weights.to(video.device).view(1, 1, prefix_steps, 1, 1)
    audio_mask = torch.ones((1, 1, 1, int(audio.shape[-1])), device=audio.device, dtype=torch.float32)
    if audio_steps:
        audio_mask[..., :audio_steps] = 0.0
        release = min(8, audio_steps)
        ticks = torch.arange(1, release + 1, device=audio.device, dtype=torch.float32)
        audio_mask[..., audio_steps - release:audio_steps] = (0.5 - 0.5 * torch.cos(math.pi * ticks / release)).view(1, 1, 1, release)

    output = dict(latent)
    output["samples"] = _nested(video, audio)
    output["noise_mask"] = _nested(video_mask, audio_mask)
    output[PREFIX_STEPS_KEY] = prefix_steps
    output[SEAM_MIN_KEY] = seam_min
    output[TRIM_FRAMES_KEY] = context_frames
    output[VISIBLE_FRAMES_KEY] = int(visible_frames)
    return output


def _schedule_values(sigmas):
    try:
        return [float(value) for value in torch.as_tensor(sigmas).detach().float().cpu().reshape(-1)]
    except Exception:
        return []


def _next_sigma_ratio(current, schedule):
    current = float(current)
    if not math.isfinite(current) or current <= 0:
        return 0.0
    tolerance = max(1e-7, abs(current) * 1e-6)
    for candidate in schedule:
        if candidate < current - tolerance:
            return max(0.0, min(1.0, candidate / current))
    return 0.0


def _paint(mask, weights):
    if not torch.is_tensor(mask):
        return mask
    count = int(weights.numel())
    output = mask.clone()
    values = weights.to(device=mask.device, dtype=mask.dtype)
    if mask.ndim == 5 and count <= int(mask.shape[2]):
        output[:, :, :count] = values.view(1, 1, count, 1, 1)
    elif mask.ndim == 3 and count <= int(mask.shape[-1]):
        output[..., :count] = values.view(1, 1, count)
    return output


class _PrefixRemask:
    def __init__(self, prefix_steps, seam_min, sigmas, video_shape):
        self.prefix_steps = int(prefix_steps)
        self.seam_min = float(seam_min)
        self.sigmas = _schedule_values(sigmas)
        self.video_shape = tuple(int(value) for value in video_shape)

    def _weights(self, sigma, extra_options=None):
        current = float(torch.as_tensor(sigma).detach().float().reshape(-1)[0])
        schedule = self.sigmas or _schedule_values((extra_options or {}).get("sigmas", ()))
        ratio = _next_sigma_ratio(current, schedule)
        base = _prefix_weights(self.prefix_steps, self.seam_min)
        return torch.clamp(base * ratio, min=self.seam_min, max=1.0)

    @staticmethod
    def _quantize(mask):
        return torch.ceil(mask.float() * 256.0).div(256.0).to(dtype=mask.dtype)

    def denoise_mask_function(self, sigma, denoise_mask, extra_options=None):
        weights = self._weights(sigma, extra_options)
        if torch.is_tensor(denoise_mask) and denoise_mask.ndim == 3 and len(self.video_shape) == 5:
            video_elements = int(math.prod(self.video_shape[1:]))
            if int(denoise_mask.shape[-1]) >= video_elements:
                packed = denoise_mask.clone()
                video = packed[..., :video_elements].reshape(self.video_shape)
                video = self._quantize(_paint(video, weights))
                packed[..., :video_elements] = video.reshape(packed.shape[0], 1, video_elements).to(packed)
                return packed
        if torch.is_tensor(denoise_mask):
            return self._quantize(_paint(denoise_mask, weights))
        streams = _streams(denoise_mask)
        video = self._quantize(_paint(streams[0], weights))
        return _nested(video, streams[1]) if len(streams) > 1 else video

    def apply_model_wrapper(self, executor, *args, **kwargs):
        sigma = args[1] if len(args) > 1 else kwargs.get("t")
        mask = kwargs.get("denoise_mask")
        if sigma is not None and torch.is_tensor(mask) and mask.ndim == 5:
            kwargs["denoise_mask"] = self._quantize(_paint(mask, self._weights(sigma)))
        return executor(*args, **kwargs)


def install_prefix_remask(model, latent, sigmas):
    prefix_steps = int(latent.get(PREFIX_STEPS_KEY, 0) or 0) if isinstance(latent, dict) else 0
    if prefix_steps < 1 or model is None or not callable(getattr(model, "clone", None)):
        return model
    patched = model.clone()
    if not callable(getattr(patched, "set_model_denoise_mask_function", None)):
        return model
    streams = _streams(latent.get("samples"))
    if not streams or not torch.is_tensor(streams[0]) or streams[0].ndim != 5:
        return model
    state = _PrefixRemask(prefix_steps, float(latent.get(SEAM_MIN_KEY, 0.10)), sigmas, streams[0].shape)
    patched.set_model_denoise_mask_function(state.denoise_mask_function)
    try:
        from comfy.patcher_extension import WrappersMP
        if callable(getattr(patched, "add_wrapper_with_key", None)):
            patched.add_wrapper_with_key(WrappersMP.APPLY_MODEL, _WRAPPER_KEY, state.apply_model_wrapper)
    except (ImportError, AttributeError):
        pass
    return patched


class XiantuVideoContinuationModelPatch:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model": ("MODEL",), "latent": ("LATENT",), "sigmas": ("SIGMAS",)}}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "patch"
    CATEGORY = "闲兔/视频编辑"

    def patch(self, model, latent, sigmas):
        return (install_prefix_remask(model, latent, sigmas),)


class XiantuSelfLiftContinuationLatent:
    """Adapt the workbench AV mask to the selected SelfLift execution path."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "latent": ("LATENT",),
                "preserve_video_mask": ("BOOLEAN", {"default": True}),
            }
        }

    RETURN_TYPES = ("LATENT",)
    FUNCTION = "adapt"
    CATEGORY = "闲兔/视频编辑"

    def adapt(self, latent, preserve_video_mask=True):
        output = dict(latent)
        # SelfLift rejects every noise_mask when highres_tiling is enabled.
        # The workbench keeps the approved AV continuation latent unchanged
        # and restores its anchored region in XiantuSelfLiftContinuationBlend.
        # Always remove the sampler-facing mask here so prompts produced by an
        # older cached browser script cannot reintroduce the incompatible pair.
        output.pop("noise_mask", None)
        return (output,)


class XiantuSelfLiftContinuationBlend:
    """Restore the continuation anchor after either SelfLift sampling mode."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"generated": ("LATENT",), "source": ("LATENT",)}}

    RETURN_TYPES = ("LATENT",)
    FUNCTION = "blend"
    CATEGORY = "闲兔/视频编辑"

    def blend(self, generated, source):
        mask = source.get("noise_mask")
        if mask is None:
            return (generated,)
        generated_streams = _streams(generated.get("samples"))
        source_streams = _streams(source.get("samples"))
        mask_streams = _streams(mask)
        if len(generated_streams) != len(source_streams):
            raise ValueError("SelfLift 分块承接的音视频流数量不一致。")
        blended = []
        for index, (current, anchor) in enumerate(zip(generated_streams, source_streams)):
            stream_mask = mask_streams[min(index, len(mask_streams) - 1)]
            if not torch.is_tensor(stream_mask):
                raise TypeError("SelfLift 分块承接没有收到有效遮罩。")
            stream_mask = stream_mask.to(device=current.device, dtype=current.dtype)
            anchor = anchor.to(device=current.device, dtype=current.dtype)
            blended.append(current * stream_mask + anchor * (1.0 - stream_mask))
        output = dict(generated)
        output["samples"] = _nested(*blended) if len(blended) == 2 else blended[0]
        output.pop("noise_mask", None)
        return (output,)


class XiantuVideoContinuationTrim:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "trim_frames": ("INT", {"default": 0, "min": 0, "max": 2048}),
                "keep_frames": ("INT", {"default": 5, "min": 1, "max": 2048}),
            },
            "optional": {"audio": ("AUDIO",)},
        }

    RETURN_TYPES = ("IMAGE", "AUDIO")
    RETURN_NAMES = ("图像", "音频")
    FUNCTION = "trim"
    CATEGORY = "闲兔/视频编辑"

    def trim(self, images, trim_frames, keep_frames, audio=None):
        if not torch.is_tensor(images) or int(images.shape[0]) <= 0:
            raise ValueError("视频时长规范节点没有收到有效图像帧")
        requested_keep = max(1, int(keep_frames))
        start = max(0, min(int(trim_frames), int(images.shape[0])))
        stop = min(int(images.shape[0]), start + requested_keep)
        output_images = _repair_leading_white_flash(images, start, stop)
        if int(output_images.shape[0]) < requested_keep:
            last_frame = output_images[-1:] if int(output_images.shape[0]) else images[-1:]
            repeats = (requested_keep - int(output_images.shape[0]),) + (1,) * (last_frame.ndim - 1)
            output_images = torch.cat((output_images, last_frame.repeat(repeats)), dim=0)
        output_audio = audio
        if isinstance(audio, dict) and torch.is_tensor(audio.get("waveform")):
            sample_rate = int(audio.get("sample_rate") or 32000)
            audio_start = int(round(start / FPS * sample_rate))
            audio_count = int(round(requested_keep / FPS * sample_rate))
            output_audio = dict(audio)
            waveform = audio["waveform"][..., audio_start:audio_start + audio_count]
            if int(waveform.shape[-1]) < audio_count:
                waveform = F.pad(waveform, (0, audio_count - int(waveform.shape[-1])))
            output_audio["waveform"] = waveform
        return output_images, output_audio


NODE_CLASS_MAPPINGS = {
    "XiantuVideoContinuationModelPatch": XiantuVideoContinuationModelPatch,
    "XiantuSelfLiftContinuationLatent": XiantuSelfLiftContinuationLatent,
    "XiantuSelfLiftContinuationBlend": XiantuSelfLiftContinuationBlend,
    "XiantuVideoContinuationTrim": XiantuVideoContinuationTrim,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiantuVideoContinuationModelPatch": "闲兔｜视频承接动态重绘",
    "XiantuSelfLiftContinuationLatent": "闲兔｜SelfLift 承接适配",
    "XiantuSelfLiftContinuationBlend": "闲兔｜SelfLift 承接合成",
    "XiantuVideoContinuationTrim": "闲兔｜视频承接精确裁剪",
}
