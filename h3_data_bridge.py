"""Explicit data bridge for H3 continuation and unchanged external samplers.

No sampler is invoked here. Native ComfyUI MODEL callbacks transport the AV
mask across spatial grids while the connected sampler executes its own code.
"""
from __future__ import annotations

import copy
import torch
import torch.nn.functional as F

NODE = "XiantuH3ContinuationDataBridge"
DRIFT = "minimax_h3_timeline_drift_control_av"
KEY = "xiantu_h3_continuation_data_bridge"


def _streams(value):
    return list(value.unbind()) if getattr(value, "is_nested", False) else [value]


def _resize_video(value, shape):
    if tuple(value.shape[2:]) == tuple(shape[2:]):
        return value
    return F.interpolate(value.float(), size=shape[2:], mode="trilinear",
                         align_corners=False).to(value.dtype)


def _packed(streams):
    from comfy.utils import pack_latents
    return pack_latents(streams)[0]


def _stage_data(samples, masks, shapes):
    video, audio = samples
    video_mask, audio_mask = masks
    video = _resize_video(video, shapes[0])
    video_mask = _resize_video(video_mask, (shapes[0][0], 1, *shapes[0][2:]))
    video_mask = video_mask.expand(shapes[0][0], 1, *shapes[0][2:])
    audio_mask = audio_mask.expand(shapes[1][0], 1, *shapes[1][2:])
    if tuple(audio.shape) != tuple(shapes[1]):
        raise ValueError("H3数据桥检测到音频流尺寸发生变化。")
    return [video, audio], [video_mask, audio_mask]


class _Transport:
    def __init__(self, samples, masks, state):
        self.samples, self.masks, self.state = samples, masks, state

    def apply_model(self, executor, *args, **kwargs):
        def forward(*forward_args, **forward_kwargs):
            mask = forward_kwargs.get("denoise_mask")
            if mask is not None:
                # Continuation masks are temporal: preserve every temporal
                # value but express spatial broadcasting explicitly. This
                # survives the external tiler's unchanged per-tile calls.
                spatial = mask[..., :1, :1]
                if torch.equal(mask, spatial.expand_as(mask)):
                    forward_kwargs["denoise_mask"] = spatial
            return executor(*forward_args, **forward_kwargs)
        return self.state.apply_model_wrapper(forward, *args, **kwargs)

    def sample_stage(self, executor, guider, sigmas, extra_args, callback,
                     noise, latent_image=None, denoise_mask=None, disable_pbar=False):
        from comfy.nested_tensor import NestedTensor
        shapes = guider.inner_model.latent_shapes
        samples, masks = _stage_data(self.samples, self.masks, shapes)
        masks = [item.to(device=noise.device, dtype=noise.dtype) for item in masks]
        self.state.configure_selflift_stage(tuple(shapes[0]), masks[0], masks[1], hard_lock=False)
        packed_mask = _packed([masks[0].expand(shapes[0]), masks[1].expand(shapes[1])])
        # The high-resolution stage resumes a noisy latent. Only the copied
        # overlap needs the ORIGINAL clean anchor; the generated suffix retains
        # the original sampler's resume state and noise without alteration.
        clean = guider.inner_model.process_latent_in(NestedTensor(samples))
        clean = _packed(_streams(clean)).to(device=noise.device, dtype=noise.dtype)
        anchor = torch.where(packed_mask < 1, clean, latent_image)
        return executor(guider, sigmas, extra_args, callback, noise, anchor,
                        packed_mask, disable_pbar)


class XiantuH3ContinuationDataBridge:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model": ("MODEL",), "positive": ("CONDITIONING",),
                             "latent": ("LATENT",)},
                "optional": {"model_hires": ("MODEL",)}}

    RETURN_TYPES = ("MODEL", "CONDITIONING", "LATENT", "MODEL")
    RETURN_NAMES = ("model", "positive", "latent", "model_hires")
    FUNCTION = "bridge"
    CATEGORY = "闲兔/视频编辑/兼容"
    DESCRIPTION = "只传递H3续接数据；仍由下游原采样器执行采样。"

    def bridge(self, model, positive, latent, model_hires=None):
        raw_mask = latent.get("noise_mask")
        if raw_mask is None:
            return model, positive, latent, model_hires
        samples, masks = _streams(latent["samples"]), _streams(raw_mask)
        if len(samples) != 2 or len(masks) != 2:
            raise ValueError("H3续接数据桥需要视频、音频双路Latent和遮罩。")
        state = model.model_options.get("xiantu_h3_continuation_state") or model.model_options.get(DRIFT)
        if not callable(getattr(state, "configure_selflift_stage", None)):
            raise ValueError("请把H3续接输出接入数据桥；当前模型未携带续接状态。")
        from comfy.patcher_extension import WrappersMP
        def attach(source):
            patched = source.clone()
            transport = _Transport(samples, masks, copy.copy(state))
            patched.model_options[DRIFT] = transport.state
            if "xiantu_h3_continuation_state" in patched.model_options:
                patched.model_options["xiantu_h3_continuation_state"] = transport.state
            patched.set_model_denoise_mask_function(transport.state.denoise_mask_function)
            patched.remove_wrappers_with_key(WrappersMP.APPLY_MODEL, DRIFT)
            patched.add_wrapper_with_key(WrappersMP.APPLY_MODEL, DRIFT, transport.apply_model)
            patched.add_wrapper_with_key(WrappersMP.SAMPLER_SAMPLE, KEY, transport.sample_stage)
            return patched
        patched = attach(model)
        patched_hires = attach(model_hires) if model_hires is not None else None
        output = dict(latent)
        # Transfer ownership, not removal: both masks remain in the MODEL
        # transport and are restored to the native sampler on EVERY stage.
        output.pop("noise_mask")
        return patched, positive, output, patched_hires


def route_bridge_after_continuation(data):
    """Only reorder explicit bridge connections around director-injected nodes."""
    graph = data.get("prompt") or {}
    for continuation_id, continuation in list(graph.items()):
        if continuation.get("class_type") not in {"XiantuH3LatentContinuation", "MiniMaxH3FiniteLatentContinuation"}:
            continue
        inputs = continuation.get("inputs") or {}
        link = inputs.get("target_latent")
        if not isinstance(link, list) or len(link) != 2:
            continue
        bridge_id = str(link[0])
        bridge = graph.get(bridge_id, {})
        if bridge.get("class_type") != NODE or link[1] != 2:
            continue
        if inputs.get("model") != [bridge_id, 0] or inputs.get("positive") != [bridge_id, 1]:
            raise ValueError("H3数据桥的model、positive、latent必须成套连接。")
        original = dict(bridge["inputs"])
        # Rewire existing consumers before creating the new bridge inputs.
        outputs = {0: 1, 1: 2, 3: 0}
        for entry in graph.values():
            if entry is continuation or entry is bridge:
                continue
            for name, value in (entry.get("inputs") or {}).items():
                if isinstance(value, list) and len(value) == 2 and str(value[0]) == str(continuation_id) and value[1] in outputs:
                    entry["inputs"][name] = [bridge_id, outputs[value[1]]]
        inputs.update(model=original["model"], positive=original["positive"],
                      target_latent=original["latent"])
        bridge["inputs"].update(model=[str(continuation_id), 3],
                               positive=[str(continuation_id), 0],
                               latent=[str(continuation_id), 1])
    return data


NODE_CLASS_MAPPINGS = {"XiantuH3ContinuationDataBridge": XiantuH3ContinuationDataBridge}
NODE_DISPLAY_NAME_MAPPINGS = {"XiantuH3ContinuationDataBridge": "闲兔｜H3续接数据兼容桥"}
