"""Native MiniMax H3 motion context used by the existing director workbench.

This module intentionally registers no ComfyUI node and modifies no SelfLift
source file. It installs two small runtime compatibility hooks in ComfyUI's H3
implementation so interior keyframes can carry the previous shot through both
the stock sampler and SelfLift high-resolution tiling.

The layout and payload technique is adapted from the Apache-2.0 project
AIMixer/ComfyUI_MiniMaxH3_Director.
"""

from __future__ import annotations

import inspect
import logging
import sys
import threading

import torch
import torch.nn.functional as F


log = logging.getLogger("XiantuQwenImage21Director.h3_context_compat")

FRAME_PER_TOKEN = (1, 4, 4, 4, 4)
CTX_FRAME_KEY = "director_context_index"
_LAYOUT_MARKER = "_xiantu_h3_continuity_layout_patch"
_PAYLOAD_MARKER = "_xiantu_h3_continuity_payload_patch"
_SELFLIFT_TILE_MARKER = "_xiantu_h3_continuity_tile_patch"
_AIMIXER_LAYOUT_MARKER = "_h3_director_continuity_layout_patch"
_AIMIXER_PAYLOAD_MARKER = "_h3_director_continuity_payload_patch"

_patch_lock = threading.Lock()
_layout_original = None
_payload_original = None


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


def _patched_layout_init(
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
    original = _layout_original
    if original is None:
        raise RuntimeError("H3 continuation layout hook was not initialized")
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


setattr(_patched_layout_init, _LAYOUT_MARKER, True)


def _patched_extra_conds(self, **kwargs):
    original = _payload_original
    if original is None:
        raise RuntimeError("H3 continuation payload hook was not initialized")
    output = original(self, **kwargs)
    keyframes = kwargs.get("minimax_keyframes")
    references = kwargs.get("minimax_refs")
    if not keyframes or not references:
        return output
    condition = output.get("minimax_payload")
    payload = getattr(condition, "cond", None) if condition is not None else None
    if not isinstance(payload, dict):
        raise RuntimeError("H3 continuation could not merge keyframes and references")
    payload["cond_video_latents"] = [
        item["latent"] for item in keyframes if item.get("latent") is not None
    ] + [
        item["latent"] for item in references if item.get("latent") is not None
    ]
    payload["cond_audio_latents"] = [
        item["audio_latent"]
        for item in list(keyframes) + list(references)
        if item.get("audio_latent") is not None
    ]
    frame_count = kwargs.get("minimax_frame_count")
    if frame_count is not None:
        payload["frame_count"] = frame_count
    return output


setattr(_patched_extra_conds, _PAYLOAD_MARKER, True)


def ensure_context_runtime():
    """Install H3-only runtime hooks once without touching SelfLift."""
    global _layout_original, _payload_original
    with _patch_lock:
        minimax = _minimax_module()
        current_layout = minimax.PackedLayout.__init__
        if not (
            getattr(current_layout, _LAYOUT_MARKER, False)
            or getattr(current_layout, _AIMIXER_LAYOUT_MARKER, False)
        ):
            if getattr(current_layout, "_h3_motion_context_layout_patch", False):
                raise RuntimeError("Another incompatible H3 motion-context hook is active")
            _layout_original = current_layout
            minimax.PackedLayout.__init__ = _patched_layout_init
            log.info("Enabled H3 multi-frame continuation timing")

        _ensure_payload_runtime_locked()


def _ensure_payload_runtime_locked():
    global _payload_original
    import comfy.model_base as model_base

    model_class = getattr(model_base, "MiniMaxH3", None)
    if model_class is None or not hasattr(model_class, "extra_conds"):
        raise RuntimeError("This ComfyUI build has no MiniMaxH3.extra_conds")
    current_payload = model_class.extra_conds
    if not (
        getattr(current_payload, _PAYLOAD_MARKER, False)
        or getattr(current_payload, _AIMIXER_PAYLOAD_MARKER, False)
    ):
        if getattr(current_payload, "_h3_motion_context_payload_patch", False):
            raise RuntimeError("Another incompatible H3 payload hook is active")
        _payload_original = current_payload
        model_class.extra_conds = _patched_extra_conds
        log.info("Enabled H3 continuation/reference payload compatibility")


def ensure_payload_runtime():
    """Keep H3 guide clips and reference assets in the same payload."""
    with _patch_lock:
        _ensure_payload_runtime_locked()


def ensure_selflift_tiling_runtime():
    """Repair combined guide/reference payloads after SelfLift spatial tiling.

    SelfLift already crops H3 keyframes per tile, but its current public tiler
    only rebuilds ``cond_video_latents`` when no references are present. This
    wrapper remains in the director module and changes no SelfLift source file.
    """
    with _patch_lock:
        for name, module in tuple(sys.modules.items()):
            if (name != "h3_tiling" and not name.endswith(".h3_tiling")) or module is None:
                continue
            original = getattr(module, "_tile_payload", None)
            if not callable(original) or getattr(original, _SELFLIFT_TILE_MARKER, False):
                continue

            def tile_payload(*args, __original=original, **kwargs):
                tiled = __original(*args, **kwargs)
                keyframes = tiled.get("keyframes") or []
                references = tiled.get("refs") or []
                if keyframes and references:
                    combined = list(keyframes) + list(references)
                    tiled["cond_video_latents"] = [
                        item["latent"]
                        for item in combined
                        if item.get("latent") is not None
                    ]
                    tiled["cond_audio_latents"] = [
                        item["audio_latent"]
                        for item in combined
                        if item.get("audio_latent") is not None
                    ]
                return tiled

            setattr(tile_payload, _SELFLIFT_TILE_MARKER, True)
            module._tile_payload = tile_payload
            log.info("Enabled SelfLift H3 tiled guide/reference compatibility")


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
        ensure_context_runtime()
        context_keyframes = [
            {
                "resolved_frame_index": 0,
                CTX_FRAME_KEY: int(offset),
                "latent": encoded[:, :, index:index + 1],
            }
            for index, offset in enumerate(_step_offsets(int(encoded.shape[2])))
        ]
    ensure_selflift_tiling_runtime()

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
