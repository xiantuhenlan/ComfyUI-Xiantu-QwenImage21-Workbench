"""Native MiniMax H3 motion context used by the existing director workbench.

This module registers no node and changes no external module or class. Its
compatibility wrapper belongs only to the cloned MODEL for the current shot.

The layout and payload technique is adapted from the Apache-2.0 project
AIMixer/ComfyUI_MiniMaxH3_Director.
"""

from __future__ import annotations

import inspect
import logging
import copy

import torch
import torch.nn.functional as F


log = logging.getLogger("XiantuQwenImage21Director.h3_context_compat")

FRAME_PER_TOKEN = (1, 4, 4, 4, 4)
CTX_FRAME_KEY = "director_context_index"
_CONTEXT_WRAPPER = "xiantu_h3_scoped_context"


def _minimax_module():
    import comfy.ldm.minimax.model as minimax

    return minimax


def _pixel_frames_for_latent_t(latent_t):
    return sum(
        FRAME_PER_TOKEN[index % len(FRAME_PER_TOKEN)]
        for index in range(int(latent_t))
    )


def _step_offsets(latent_t):
    result = []
    current = 0
    for index in range(int(latent_t)):
        result.append(current)
        current += FRAME_PER_TOKEN[index % len(FRAME_PER_TOKEN)]
    return result


def _streams(value):
    if torch.is_tensor(value):
        return [value]
    if hasattr(value, "unbind"):
        return list(value.unbind())
    if hasattr(value, "tensors"):
        return list(value.tensors)
    if isinstance(value, (tuple, list)):
        return list(value)
    raise TypeError("MiniMax H3 latent has no readable audio/video streams")


def _resize_frames(frames, width, height):
    source = frames[..., :3].movedim(-1, 1)
    source_h, source_w = int(source.shape[2]), int(source.shape[3])
    scale = max(width / max(1, source_w), height / max(1, source_h))
    scaled_w = max(width, round(source_w * scale))
    scaled_h = max(height, round(source_h * scale))
    resized = F.interpolate(
        source,
        size=(scaled_h, scaled_w),
        mode="bilinear",
        align_corners=False,
    )
    left = max(0, (scaled_w - width) // 2)
    top = max(0, (scaled_h - height) // 2)
    return resized[:, :, top:top + height, left:left + width].movedim(1, -1)


def _target_origin(layout):
    start, end, kind = layout.segments[-1]
    if kind != "video" or end <= start:
        raise RuntimeError("H3 continuation could not locate the target video segment")
    return float(layout.position_ids[start, 0])


def _keyframe_time(minimax, text_len, latent_t, frame_count, pixel_index):
    pixel_index = int(pixel_index)
    if pixel_index == 0:
        return float(text_len)
    if frame_count is not None and pixel_index == int(frame_count) - 1:
        return (
            float(text_len)
            + sum(minimax._video_t_spans(latent_t))
            - minimax.FRAME_RESCALE
        )
    return float(text_len) + minimax.FRAME_RESCALE * float(pixel_index)


def _layout_kwargs(original, keyframes, refs, frame_count):
    kwargs = {"keyframes": keyframes, "refs": refs}
    try:
        parameters = inspect.signature(original).parameters
    except (TypeError, ValueError):
        parameters = {}
    accepts_kwargs = any(
        parameter.kind is inspect.Parameter.VAR_KEYWORD
        for parameter in parameters.values()
    )
    if "frame_count" in parameters or accepts_kwargs:
        kwargs["frame_count"] = frame_count
    return kwargs


def _context_layout_init(
    original,
    self,
    text_len,
    latent_t,
    latent_h,
    latent_w,
    audio_t,
    keyframes=None,
    refs=None,
    frame_count=None,
):
    stock_keyframes = None
    if keyframes:
        stock_keyframes = []
        for keyframe in keyframes:
            entry = dict(keyframe)
            if CTX_FRAME_KEY in entry:
                entry["resolved_frame_index"] = 0
            stock_keyframes.append(entry)
    kwargs = _layout_kwargs(original, stock_keyframes, refs, frame_count)
    try:
        original(
            self,
            text_len,
            latent_t,
            latent_h,
            latent_w,
            audio_t,
            **kwargs,
        )
    except TypeError as error:
        if "frame_count" not in str(error) or "frame_count" not in kwargs:
            raise
        kwargs.pop("frame_count", None)
        original(
            self,
            text_len,
            latent_t,
            latent_h,
            latent_w,
            audio_t,
            **kwargs,
        )

    if not keyframes or not any(CTX_FRAME_KEY in item for item in keyframes):
        return
    offset = _target_origin(self) - float(text_len)
    spans = [(start, end) for start, end, kind in self.segments if kind == "cond"]
    if len(spans) != len(keyframes):
        raise RuntimeError(
            "H3 continuation keyframe/layout mismatch: "
            f"{len(keyframes)} keyframes, {len(spans)} conditioning segments"
        )
    minimax = _minimax_module()
    for (start, end), keyframe in zip(spans, keyframes):
        pixel_index = keyframe.get(CTX_FRAME_KEY)
        if pixel_index is None:
            continue
        self.position_ids[start:end, 0] = (
            _keyframe_time(minimax, text_len, latent_t, frame_count, pixel_index)
            + offset
        )


def _local_layout_class():
    original = _minimax_module().PackedLayout

    class ContextLayout(original):
        def __init__(self, *args, **kwargs):
            _context_layout_init(original.__init__, self, *args, **kwargs)

    return ContextLayout


def _context_payload(payload, streams, context):
    if not isinstance(payload, dict):
        return payload
    keyframes, references = payload.get("keyframes") or [], payload.get("refs") or []
    if not keyframes and not references:
        return payload
    output = dict(payload)
    combined = list(keyframes) + list(references)
    output["cond_video_latents"] = [item["latent"] for item in combined if item.get("latent") is not None]
    output["cond_audio_latents"] = [item["audio_latent"] for item in combined if item.get("audio_latent") is not None]
    if not any(CTX_FRAME_KEY in item for item in keyframes):
        return output
    video, audio = _streams(streams)
    text_len, latent_t = int(context.shape[1]), int(video.shape[2])
    height, width = ((int(value) + 1) // 2 * 2 for value in video.shape[-2:])
    signature = (text_len, latent_t, height, width, int(audio.shape[-1]))
    frame_count = int(payload.get("frame_count") or _pixel_frames_for_latent_t(latent_t))
    layout = payload.get("layout")
    if layout is None or layout.signature != signature:
        layout = _local_layout_class()(*signature, keyframes=keyframes, refs=references, frame_count=frame_count)
    else:
        layout = copy.copy(layout)
        layout.position_ids = layout.position_ids.clone()
        offset = _target_origin(layout) - float(text_len)
        spans = [(start, end) for start, end, kind in layout.segments if kind == "cond"]
        if len(spans) != len(keyframes):
            raise RuntimeError("H3 continuation keyframe/layout mismatch")
        for (start, end), keyframe in zip(spans, keyframes):
            if CTX_FRAME_KEY in keyframe:
                layout.position_ids[start:end, 0] = _keyframe_time(
                    _minimax_module(), text_len, latent_t, frame_count, keyframe[CTX_FRAME_KEY]
                ) + offset
    output["layout"] = layout
    output["frame_count"] = frame_count
    return output


def install_context_model(model):
    """Repair only this MODEL's invocation, including calls made inside tiling."""
    from comfy.patcher_extension import WrappersMP

    patched = model.clone()

    def scoped_call(executor, *args, **kwargs):
        original = executor.original

        def invoke(*inner_args, **inner_kwargs):
            values = list(inner_args)
            payload = inner_kwargs.get("minimax_payload", values[4] if len(values) > 4 else None)
            if isinstance(payload, dict) and (payload.get("keyframes") or payload.get("refs")):
                streams = values[0] if values else inner_kwargs.get("x")
                context = values[2] if len(values) > 2 else inner_kwargs.get("context")
                prepared = _context_payload(payload, streams, context)
                if len(values) > 4:
                    values[4] = prepared
                else:
                    inner_kwargs["minimax_payload"] = prepared
                if len(values) > 3 and isinstance(values[3], dict):
                    values[3] = dict(values[3])
                elif isinstance(inner_kwargs.get("transformer_options"), dict):
                    inner_kwargs["transformer_options"] = dict(inner_kwargs["transformer_options"])
            return original(*values, **inner_kwargs)

        local_executor = copy.copy(executor)
        local_executor.original = invoke
        return local_executor(*args, **kwargs)

    patched.remove_wrappers_with_key(WrappersMP.DIFFUSION_MODEL, _CONTEXT_WRAPPER)
    patched.add_wrapper_with_key(WrappersMP.DIFFUSION_MODEL, _CONTEXT_WRAPPER, scoped_call)
    return patched


def _native_context_supported():
    """Return true for ComfyUI builds with native multi-frame H3 guides."""
    try:
        from comfy_extras import nodes_minimax_h3

        minimax = _minimax_module()
        layout_source = inspect.getsource(minimax.PackedLayout.__init__)
        return (
            hasattr(nodes_minimax_h3, "MiniMaxH3AddGuide")
            and "only first/last keyframe anchors are supported" not in layout_source
        )
    except (ImportError, OSError, TypeError):
        return False


def apply_motion_context(
    positive,
    latent,
    previous_frames,
    vae,
    requested_frames,
    width,
    height,
    shift_first_anchor=False,
):
    """Attach a previous shot tail as native H3 interior keyframes."""
    if vae is None:
        raise ValueError("Continuation requires the MiniMax H3 video VAE")
    requested = int(requested_frames or 22)
    available = int(previous_frames.shape[0])
    if available < requested:
        raise ValueError(
            f"The previous shot has {available} frames; {requested} are required"
        )

    streams = _streams(latent.get("samples"))
    if not streams or not torch.is_tensor(streams[0]) or streams[0].ndim != 5:
        raise ValueError("Continuation requires a MiniMax H3 audio/video latent")
    target_video = streams[0]
    target_frames = _pixel_frames_for_latent_t(int(target_video.shape[2]))
    if requested >= target_frames:
        raise ValueError("The target shot is too short for the selected context length")

    tail = _resize_frames(previous_frames[-requested:], width, height)
    encoded = vae.encode(tail)
    if not torch.is_tensor(encoded) or encoded.ndim != 5:
        raise ValueError("The video VAE returned an invalid continuation latent")
    covered = _pixel_frames_for_latent_t(int(encoded.shape[2]))
    if covered != requested:
        raise ValueError(
            f"Continuation frame grid mismatch: requested {requested}, VAE covers {covered}"
        )

    native_context = _native_context_supported()
    if native_context:
        # Current ComfyUI represents a guide clip as one keyframe whose latent
        # contains the full temporal sequence. SelfLift preserves and spatially
        # crops this structure in both low- and high-resolution stages. Current
        # ComfyUI also merges keyframes and references itself, so do not wrap
        # MiniMaxH3.extra_conds here: doing so conflicts with an installed H3
        # Director pack when both workbenches are used in one process.
        context_keyframes = [{"resolved_frame_index": 0, "latent": encoded}]
    else:
        # Older public H3 builds only accepted first/last single-frame anchors.
        # Split the guide over the temporal grid and install the workbench-local
        # position/payload compatibility hooks for those builds only.
        context_keyframes = [
            {
                "resolved_frame_index": 0,
                CTX_FRAME_KEY: int(offset),
                "latent": encoded[:, :, index:index + 1],
            }
            for index, offset in enumerate(_step_offsets(int(encoded.shape[2])))
        ]

    output = []
    for tensor, source_metadata in positive:
        metadata = dict(source_metadata)
        existing = []
        for keyframe in metadata.get("minimax_keyframes") or []:
            resolved = int(keyframe.get("resolved_frame_index", -1))
            if resolved == 0:
                if shift_first_anchor:
                    preserved = dict(keyframe)
                    preserved["resolved_frame_index"] = requested
                    if not native_context:
                        preserved[CTX_FRAME_KEY] = requested
                    existing.append(preserved)
                continue
            preserved = dict(keyframe)
            if resolved >= 0 and not native_context:
                preserved[CTX_FRAME_KEY] = resolved
            existing.append(preserved)
        metadata["minimax_keyframes"] = context_keyframes + existing
        metadata["minimax_frame_count"] = target_frames
        output.append([tensor, metadata])
    return output, latent
