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

from .video_continuity import apply_latent_continue


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


def _apply_visual_continuation(latent, previous_frames, previous_audio, vae, audio_vae,
                               context_frames, redraw, width, height, visible_frames):
    """Install the workbench-owned H3 latent prefix and sampling markers."""
    return apply_latent_continue(
        latent, previous_frames, previous_audio, vae, audio_vae,
        context_frames, redraw, width, height, visible_frames,
    )


def _dimensions(state):
    resolution = state.get("resolution") if isinstance(state.get("resolution"), dict) else {}
    width = int(resolution.get("width") or 0)
    height = int(resolution.get("height") or 0)
    if width > 0 and height > 0:
        return width, height
    ratios = {"1:1": 1.0, "2:3": 2 / 3, "3:2": 3 / 2, "3:4": 3 / 4, "4:3": 4 / 3, "9:16": 9 / 16, "16:9": 16 / 9, "21:9": 21 / 9}
    ratio = ratios.get(str(resolution.get("aspect") or "16:9"), 16 / 9)
    pixels = max(0.1, min(2.0, float(resolution.get("megapixels") or 1.0))) * 1024 * 1024
    return (
        max(32, round(math.sqrt(pixels * ratio) / 32) * 32),
        max(32, round(math.sqrt(pixels / ratio) / 32) * 32),
    )


def _video_filename_prefixes(state, shot):
    """Use the digital-human workbench naming rule for both H3 save stages."""
    shots = state.get("shots") if isinstance(state.get("shots"), list) else []
    index = next((i for i, item in enumerate(shots) if str(item.get("id") or "") == str(shot.get("id") or "")), 0)
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

        state, shot = _state(editor_state)
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
        context_length = int(state.get("continuityOverlapFrames") or 22) if bool(shot.get("inheritPrevious")) else 0
        length = visible_length
        if context_length > 0:
            length = max(5, visible_length + context_length)
            while length % 17 != 5:
                length += 1
        mode = str(shot.get("mode") or "reference")

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
            position = next((index for index, item in enumerate(state.get("shots") or []) if str(item.get("id") or "") == str(shot.get("id") or "")), -1)
            previous = state["shots"][position - 1] if position > 0 else None
            output_record = previous.get("lastOutput") if isinstance(previous, dict) else None
            if not isinstance(output_record, dict) or not output_record.get("filename"):
                raise ValueError("当前分镜要求承接上一分镜，但上一分镜没有已保存的成功输出。")
            frames, audio = _load_video(output_record)
            previous_cache["frames"] = frames
            previous_cache["audio"] = audio
            return frames

        def with_continuation(result_pair):
            if not bool(shot.get("inheritPrevious")):
                return result_pair
            positive, latent = result_pair
            frames = previous_video_frames()
            # Do not add an H3 keyframe here. Reference mode already carries
            # minimax_refs, while SelfLift's spatial tiler cannot combine a
            # full-size reference payload with a per-tile keyframe payload.
            # Continuation is instead carried by the prefixed source latent,
            # redraw strength, post-sampling anchor blend and exact trim path.
            return positive, _apply_visual_continuation(
                latent,
                frames,
                previous_cache.get("audio"),
                vae,
                audio_vae,
                state.get("continuityOverlapFrames") or 22,
                state.get("continuityRedraw") if state.get("continuityRedraw") is not None else 0.10,
                width,
                height,
                visible_length,
            )

        if mode in {"text", "image", "frames"}:
            auto_first_frame = mode == "frames" and bool(shot.get("inheritPrevious"))
            first = previous_video_frames()[-1:] if auto_first_frame else (_load_image(images[0]) if mode in {"image", "frames"} and images else None)
            last = _load_image(images[-1]) if auto_first_frame and images else (_load_image(images[1]) if mode == "frames" and len(images) > 1 else None)
            if mode == "image" and first is None:
                raise ValueError("图生视频需要一张输入图片。")
            if mode == "frames" and (first is None or last is None):
                raise ValueError("首尾帧生视频需要首帧和尾帧；开启承接时首帧自动读取上一分镜，只需上传尾帧。")
            result = MiniMaxH3ImageToVideo.execute(
                clip=clip, vae=vae, prompt=prompt, width=width, height=height,
                length=length, first_frame=first, last_frame=last,
            )
            positive, latent = with_continuation(result.result)
            return positive, latent, before_prefix, after_prefix

        if mode != "reference":
            raise ValueError(f"不支持的生成类型：{mode}")
        if not effective:
            raise ValueError("全参考生视频至少需要一个参考素材。")
        ref_images = {f"ref_image_{index}": _load_image(item) for index, item in enumerate(images[:9])}
        ref_videos = {}
        ref_video_audios = {}
        for index, item in enumerate(videos[:3]):
            video_frames, soundtrack = _load_video(item)
            ref_videos[f"ref_video_{index}"] = video_frames
            if soundtrack is not None:
                ref_video_audios[f"ref_video_audio_{index}"] = soundtrack
        ref_audios = {f"ref_audio_{index}": _load_audio(item) for index, item in enumerate(audios[:3])}
        result = MiniMaxH3ReferenceToVideo.execute(
            clip=clip,
            vae=vae,
            audio_vae=audio_vae,
            prompt=prompt,
            width=width,
            height=height,
            length=length,
            ref_image_size="max" if shot.get("referenceSize") == "max" else "match",
            ref_images=ref_images,
            ref_videos=ref_videos,
            ref_video_audios=ref_video_audios,
            ref_audios=ref_audios,
        )
        positive, latent = with_continuation(result.result)
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
