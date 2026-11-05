from __future__ import annotations

import json
import math
import posixpath
import re

import folder_paths
import node_helpers
import numpy as np
import torch
import torch.nn.functional as torch_functional
from PIL import Image, ImageOps

from comfy_api.latest import InputImpl
from comfy.nested_tensor import NestedTensor
from comfy_extras.nodes_audio import LoadAudio
from comfy_extras.nodes_minimax_h3 import MiniMaxH3ImageToVideo, MiniMaxH3ReferenceToVideo

from .h3_context_compat import apply_motion_context
from .video_continuity import CONTEXT_FRAME_CHOICES


def _state(raw):
    try:
        value = json.loads(str(raw or "{}"))
    except (TypeError, json.JSONDecodeError) as error:
        raise ValueError("视频导演台状态不是有效 JSON。") from error
    if not isinstance(value, dict):
        raise ValueError("视频导演台状态必须是 JSON 对象。")
    shots = value.get("shots")
    if not isinstance(shots, list) or not shots:
        raise ValueError("视频导演台至少需要一个分镜。")
    active_id = str(value.get("activeShotId") or "")
    shot = next((item for item in shots if str(item.get("id") or "") == active_id), shots[0])
    return value, shot


def _annotated_path(record, label):
    name = str(record.get("serverName") or record.get("filename") or record.get("name") or "").replace("\\", "/").strip("/")
    subfolder = str(record.get("subfolder") or "").replace("\\", "/").strip("/")
    # Uploaded references use sourceType, while generated history records use
    # ComfyUI's standard `type` field (normally "output").  Falling back to
    # input here made continuation look for the previous clip in the wrong
    # directory even though the output file existed.
    source_type = str(record.get("sourceType") or record.get("type") or "input").lower()
    if source_type not in {"input", "output", "temp"}:
        raise ValueError(f"{label}来源无效：{source_type}")
    relative = posixpath.normpath(posixpath.join(subfolder, name) if subfolder else name)
    if not relative or relative in {".", ".."} or relative.startswith("../") or relative.startswith("/") or ":" in relative:
        raise ValueError(f"{label}没有持久化文件，请重新上传一次。")
    annotated = relative if source_type == "input" else f"{relative} [{source_type}]"
    if not folder_paths.exists_annotated_filepath(annotated):
        # Saved generations can still contain VHS' original counter/-audio
        # filename after the finalizer has atomically published the stable
        # filename. Resolve that stale record inside the same ComfyUI folder
        # instead of rejecting a valid previous-shot video.
        stable_name = re.sub(
            r"(?:_\d{5})?-audio(?=\.[^.]+$)|_\d{5}(?=\.[^.]+$)",
            "",
            name,
            flags=re.IGNORECASE,
        )
        stable_relative = posixpath.normpath(
            posixpath.join(subfolder, stable_name) if subfolder else stable_name
        )
        stable_annotated = (
            stable_relative
            if source_type == "input"
            else f"{stable_relative} [{source_type}]"
        )
        if stable_name != name and folder_paths.exists_annotated_filepath(stable_annotated):
            return stable_annotated
        raise ValueError(f"{label}不存在：{relative}")
    return annotated


def _load_image(record):
    path = folder_paths.get_annotated_filepath(_annotated_path(record, "参考图"))
    opened = node_helpers.pillow(Image.open, path)
    try:
        opened.seek(0)
        image = node_helpers.pillow(ImageOps.exif_transpose, opened).convert("RGB")
        return torch.from_numpy(np.asarray(image).astype(np.float32) / 255.0)[None,]
    finally:
        opened.close()


def _load_audio(record):
    return LoadAudio.execute(_annotated_path(record, "参考音频")).result[0]


def _load_video(record):
    path = folder_paths.get_annotated_filepath(_annotated_path(record, "参考视频"))
    components = InputImpl.VideoFromFile(path).get_components()
    return components.images, components.audio


def _resize_video_frames(frames, width, height):
    source = frames[..., :3].movedim(-1, 1)
    source_h, source_w = int(source.shape[2]), int(source.shape[3])
    scale = max(width / max(1, source_w), height / max(1, source_h))
    scaled_w = max(width, round(source_w * scale))
    scaled_h = max(height, round(source_h * scale))
    resized = torch_functional.interpolate(source, size=(scaled_h, scaled_w), mode="bilinear", align_corners=False)
    left = max(0, (scaled_w - width) // 2)
    top = max(0, (scaled_h - height) // 2)
    return resized[:, :, top:top + height, left:left + width].movedim(1, -1)


def _apply_visual_continuation(positive, latent, previous_frames, vae,
                               context_frames, width, height,
                               shift_first_anchor=False):
    """Carry the previous shot through native H3 conditioning keyframes."""
    return apply_motion_context(
        positive,
        latent,
        previous_frames,
        vae,
        context_frames,
        width,
        height,
        shift_first_anchor,
    )


def _dimensions(state):
    resolution = state.get("resolution") if isinstance(state.get("resolution"), dict) else {}
    width = int(resolution.get("width") or 0)
    height = int(resolution.get("height") or 0)
    if width > 0 and height > 0:
        return width, height
    ratios = {"1:1": 1.0, "2:3": 2 / 3, "3:2": 3 / 2, "3:4": 3 / 4, "4:3": 4 / 3, "9:16": 9 / 16, "16:9": 16 / 9, "21:9": 21 / 9}
    ratio = ratios.get(str(resolution.get("aspect") or "16:9"), 16 / 9)
    pixels = max(0.1, min(3.0, float(resolution.get("megapixels") or 1.0))) * 1024 * 1024
    return (
        max(32, round(math.sqrt(pixels * ratio) / 32) * 32),
        max(32, round(math.sqrt(pixels / ratio) / 32) * 32),
    )


def _video_filename_prefixes(state, shot):
    """Use the digital-human workbench naming rule for both H3 save stages."""
    shots = state.get("shots") if isinstance(state.get("shots"), list) else []
    index = next((i for i, item in enumerate(shots) if str(item.get("id") or "") == str(shot.get("id") or "")), 0)
    try:
        number = max(1, int(shot.get("sequenceNumber") or index + 1))
    except (TypeError, ValueError):
        number = index + 1

    def clean_part(value, fallback=""):
        value = re.sub(r'[<>:"|?*\x00-\x1f]+', "_", str(value or ""))
        value = re.sub(r"\s+", " ", value).strip(" ._")
        return value or fallback

    rule = str(state.get("filenamePrefix") or "").strip().replace("\\", "/")
    parts = [clean_part(part) for part in rule.split("/") if part.strip(" ._")]
    if parts:
        # The UI stores a filename prefix, not a finished filename.  Older
        # projects may contain an extension copied from a generated result;
        # remove it before adding the shot number or VHS would create names
        # such as ``name.mp401_00001.mp4``.
        parts[-1] = re.sub(r"\.(?:mp4|webm|mov|mkv|avi|m4v)$", "", parts[-1], flags=re.IGNORECASE)
        parts[-1] = re.sub(r"(?:_?\d{2})?_\d{5}(?:-audio)?$", "", parts[-1], flags=re.IGNORECASE)
        parts[-1] = parts[-1].rstrip(" ._") or clean_part(shot.get("title"), "分镜")
        parts[-1] = f"{parts[-1]}{number:02d}"
        relative = "/".join(parts)
    else:
        relative = f"{number:02d}-{clean_part(shot.get('title'), f'分镜 {number:02d}')}"
    return (
        f"短剧-漫剧/放大前/{relative}",
        f"短剧-漫剧/放大后/{relative}",
    )


class XiantuVideoEditorWorkbench:
    """Video director node that produces native MiniMax H3 conditioning."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "project_id": ("STRING", {"default": ""}),
                "editor_state": ("STRING", {"default": "{}", "multiline": True}),
            },
            "optional": {
                "CLIP": ("CLIP",),
                "VAE": ("VAE",),
                "音频 VAE": ("VAE",),
            },
        }

    RETURN_TYPES = ("CONDITIONING", "LATENT", "STRING", "STRING")
    RETURN_NAMES = ("条件", "Latent", "H3放大前文件名", "H3放大后文件名")
    FUNCTION = "run"
    CATEGORY = "闲兔/视频编辑"
    OUTPUT_NODE = True

    def run(self, project_id="", editor_state="{}", **model_inputs):
        del project_id
        clip = model_inputs.get("CLIP")
        vae = model_inputs.get("VAE")
        audio_vae = model_inputs.get("音频 VAE")
        if clip is None:
            raise ValueError("请连接 MiniMax H3 的 CLIP。")

        # ComfyUI exposes this workbench as one graph node, while the official
        # H3 preparation it performs contains several expensive synchronous
        # stages. Publish real stage boundaries so the frontend can show what
        # is actually running instead of leaving one indeterminate label until
        # sampling starts. Progress reporting must never affect generation.
        from time import perf_counter
        from server import PromptServer

        progress_server = PromptServer.instance
        progress_node = str(getattr(progress_server, "last_node_id", "") or "")
        progress_client = getattr(progress_server, "client_id", None)
        stage_counts = {}

        def emit_stage(stage, label, phase, detail="", percent=None, elapsed_ms=None):
            payload = {
                "node": progress_node,
                "stage": str(stage),
                "label": str(label),
                "phase": str(phase),
                "detail": str(detail or ""),
            }
            if percent is not None:
                payload["percent"] = max(0.0, min(100.0, float(percent)))
            if elapsed_ms is not None:
                payload["elapsed_ms"] = max(0, int(elapsed_ms))
            try:
                progress_server.send_sync(
                    "xiantu_video_editor_stage", payload, progress_client
                )
            except Exception:
                pass

        def run_stage(stage, label, operation, detail="", percent=None):
            stage_counts[stage] = stage_counts.get(stage, 0) + 1
            count = stage_counts[stage]
            stage_key = f"{stage}:{count}"
            started = perf_counter()
            emit_stage(stage_key, label, "start", detail, percent)
            try:
                result = operation()
            except Exception as error:
                emit_stage(
                    stage_key, label, "error", str(error), percent,
                    (perf_counter() - started) * 1000,
                )
                raise
            emit_stage(
                stage_key, label, "complete", detail, percent,
                (perf_counter() - started) * 1000,
            )
            return result

        class ProgressClip:
            def __init__(self, target):
                self._target = target

            def __getattr__(self, name):
                return getattr(self._target, name)

            def tokenize(self, *args, **kwargs):
                return run_stage(
                    "qwen_tokenize", "Qwen3-VL 解析提示词与参考素材",
                    lambda: self._target.tokenize(*args, **kwargs), percent=62,
                )

            def encode_from_tokens_scheduled(self, *args, **kwargs):
                return run_stage(
                    "qwen_encode", "Qwen3-VL 条件编码",
                    lambda: self._target.encode_from_tokens_scheduled(*args, **kwargs),
                    percent=76,
                )

        class ProgressVAE:
            def __init__(self, target, stage, label, percent):
                self._target = target
                self._stage = stage
                self._label = label
                self._percent = percent

            def __getattr__(self, name):
                return getattr(self._target, name)

            def encode(self, *args, **kwargs):
                return run_stage(
                    self._stage, self._label,
                    lambda: self._target.encode(*args, **kwargs),
                    percent=self._percent,
                )

        progress_clip = ProgressClip(clip)
        progress_vae = ProgressVAE(vae, "video_vae", "视频 VAE 编码", 42) if vae is not None else None
        progress_audio_vae = ProgressVAE(
            audio_vae, "audio_vae", "音频 VAE 编码", 52
        ) if audio_vae is not None else None

        state, shot = run_stage(
            "read_state", "读取当前分镜生成参数",
            lambda: _state(editor_state), percent=4,
        )
        # The workbench prompt is deliberately passed through verbatim.  No
        # hidden template, subject definition, quality suffix or negative text
        # is appended here.
        prompt = str(shot.get("prompt") or "")
        if not prompt.strip():
            raise ValueError("当前分镜提示词为空。")
        width, height = _dimensions(state)
        before_prefix, after_prefix = _video_filename_prefixes(state, shot)
        fps = 24
        base_frames = max(5, round(max(1.0, float(shot.get("seconds") or 5)) * fps))
        visible_length = max(5, base_frames + (5 - base_frames % 17 + 17) % 17)
        mode = str(shot.get("mode") or "reference")
        # All inherited shots use the plugin-owned AV continuation node.
        # Its input is always recovered from the previous saved clip's AV tail;
        # cache availability does not change the algorithm or discard audio.
        latent_continuation = bool(shot.get("inheritPrevious"))
        uses_context_continuation = bool(shot.get("inheritPrevious")) and (
            mode != "frames" or latent_continuation
        )
        requested_context = max(22, int(state.get("continuityOverlapFrames") or 22))
        context_length = min(CONTEXT_FRAME_CHOICES, key=lambda value: abs(value - requested_context)) if uses_context_continuation else 0
        length = visible_length
        if context_length > 0:
            length = max(5, visible_length + context_length)
            while length % 17 != 5:
                length += 1

        assets = state.get("assets") if isinstance(state.get("assets"), list) else []
        effective = [item for item in assets if isinstance(item, dict) and (
            str(item.get("shotId") or "") == str(shot.get("id") or "")
            or (mode == "reference" and bool(item.get("global")))
        )]
        images = [item for item in effective if str(item.get("type") or "").startswith("image/")]
        videos = [item for item in effective if str(item.get("type") or "").startswith("video/")]
        audios = [item for item in effective if str(item.get("type") or "").startswith("audio/")]

        previous_cache = {}

        def previous_video_frames():
            if "frames" in previous_cache:
                return previous_cache["frames"]
            output_record = shot.get("previousOutput") if isinstance(shot.get("previousOutput"), dict) else None
            if not output_record:
                position = next((index for index, item in enumerate(state.get("shots") or []) if str(item.get("id") or "") == str(shot.get("id") or "")), -1)
                previous = state["shots"][position - 1] if position > 0 else None
                output_record = previous.get("lastOutput") if isinstance(previous, dict) else None
            if not isinstance(output_record, dict) or not output_record.get("filename"):
                raise ValueError("当前分镜要求承接上一分镜，但上一分镜没有已保存的成功输出。")
            frames, _audio = run_stage(
                "previous_video", "读取并解码上一分镜视频",
                lambda: _load_video(output_record), percent=24,
            )
            previous_cache["frames"] = frames
            return frames

        def with_continuation(result_pair):
            if not uses_context_continuation or latent_continuation:
                return result_pair
            positive, latent = result_pair
            frames = previous_video_frames()
            # Native H3 interior keyframes are understood by both the stock
            # sampler and SelfLift. SelfLift's high-resolution tiler crops this
            # payload per tile, avoiding the unsupported NestedTensor mask.
            return _apply_visual_continuation(
                positive,
                latent,
                frames,
                progress_vae,
                context_length,
                width,
                height,
                mode == "image" and bool(images),
            )

        if mode in {"text", "image", "frames"}:
            auto_first_frame = mode == "frames" and bool(shot.get("inheritPrevious"))
            # 图生视频开启承接后，如果当前分镜没有另外上传输入图，直接把
            # 上一分镜的最后一帧作为 H3 ImageToVideo 首帧。后续仍会通过
            # with_continuation 写入所选的 22/39/56 帧 Latent 上下文，避免
            # 在真正进入 H3 续接前被“需要一张输入图片”的旧校验拦截。
            auto_image_frame = mode == "image" and bool(shot.get("inheritPrevious")) and not images
            first = previous_video_frames()[-1:] if (auto_first_frame or auto_image_frame) else (run_stage(
                "load_image", "读取参考图片 1",
                lambda: _load_image(images[0]), percent=16,
            ) if mode in {"image", "frames"} and images else None)
            last = run_stage(
                "load_image", "读取尾帧图片",
                lambda: _load_image(images[-1]), percent=20,
            ) if auto_first_frame and images else (run_stage(
                "load_image", "读取参考图片 2",
                lambda: _load_image(images[1]), percent=20,
            ) if mode == "frames" and len(images) > 1 else None)
            if mode == "image" and first is None:
                raise ValueError("图生视频需要一张输入图片。")
            if mode == "frames" and (first is None or last is None):
                raise ValueError("首尾帧生视频需要首帧和尾帧；开启承接时首帧自动读取上一分镜，只需上传尾帧。")
            result = run_stage(
                "h3_condition", "建立 MiniMax H3 图像/文本条件与目标 Latent",
                lambda: MiniMaxH3ImageToVideo.execute(
                    clip=progress_clip, vae=progress_vae, prompt=prompt,
                    width=width, height=height, length=length,
                    first_frame=first, last_frame=last,
                ), percent=84,
            )
            positive, latent = run_stage(
                "visual_continuation", "写入上一分镜视觉续接条件",
                lambda: with_continuation(result.result), percent=92,
            ) if uses_context_continuation and not latent_continuation else with_continuation(result.result)
            emit_stage("ready", "导演台条件准备完成，交给采样器", "complete", percent=100)
            return positive, latent, before_prefix, after_prefix

        if mode != "reference":
            raise ValueError(f"不支持的生成类型：{mode}")
        if not effective:
            raise ValueError("全参考生视频至少需要一个参考素材。")
        ref_images = {
            f"ref_image_{index}": run_stage(
                "load_image", f"读取参考图片 {index + 1}",
                lambda item=item: _load_image(item),
                percent=10 + (index + 1) / max(1, min(9, len(images))) * 14,
            )
            for index, item in enumerate(images[:9])
        }
        ref_videos = {}
        ref_video_audios = {}
        for index, item in enumerate(videos[:3]):
            video_frames, soundtrack = run_stage(
                "load_video", f"读取并解码参考视频 {index + 1}",
                lambda item=item: _load_video(item),
                percent=18 + (index + 1) / max(1, min(3, len(videos))) * 8,
            )
            ref_videos[f"ref_video_{index}"] = video_frames
            if soundtrack is not None:
                ref_video_audios[f"ref_video_audio_{index}"] = soundtrack
        ref_audios = {
            f"ref_audio_{index}": run_stage(
                "load_audio", f"读取参考音频 {index + 1}",
                lambda item=item: _load_audio(item),
                percent=22 + (index + 1) / max(1, min(3, len(audios))) * 6,
            )
            for index, item in enumerate(audios[:3])
        }
        result = run_stage(
            "h3_condition", "建立 MiniMax H3 全参考条件与目标 Latent",
            lambda: MiniMaxH3ReferenceToVideo.execute(
                clip=progress_clip,
                vae=progress_vae,
                audio_vae=progress_audio_vae,
                prompt=prompt,
                width=width,
                height=height,
                length=length,
                ref_image_size="max" if shot.get("referenceSize") == "max" else "match",
                ref_images=ref_images,
                ref_videos=ref_videos,
                ref_video_audios=ref_video_audios,
                ref_audios=ref_audios,
            ), percent=84,
        )
        positive, latent = run_stage(
            "visual_continuation", "写入上一分镜视觉续接条件",
            lambda: with_continuation(result.result), percent=92,
        ) if uses_context_continuation and not latent_continuation else with_continuation(result.result)
        emit_stage("ready", "导演台条件准备完成，交给采样器", "complete", percent=100)
        return positive, latent, before_prefix, after_prefix

    @classmethod
    def VALIDATE_INPUTS(cls, editor_state, **_kwargs):
        try:
            _state(editor_state)
        except ValueError as error:
            return str(error)
        return True


NODE_CLASS_MAPPINGS = {
    "XiantuVideoEditorWorkbench": XiantuVideoEditorWorkbench,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiantuVideoEditorWorkbench": "闲兔 漫剧/短剧工作导演台",
}
