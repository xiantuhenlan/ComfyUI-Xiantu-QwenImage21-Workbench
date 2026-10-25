from __future__ import annotations

import hashlib
import json
import posixpath

import comfy.utils
import folder_paths
import node_helpers
import numpy as np
import torch
from PIL import Image, ImageOps


MAX_REFERENCE_IMAGES = 16
DEFAULT_WIDTH = 1024
DEFAULT_HEIGHT = 1024
MODEL_PROFILES = ("MOSS", "Qwen Image 2.1", "Krea-2")
GENERATION_MODES = ("文生图", "图生图")


def _multiple_32(value, fallback):
    number = int(value or fallback)
    return max(32, min(4096, round(number / 32) * 32))


def _normalize_state(raw):
    try:
        state = json.loads(str(raw or "{}"))
    except (TypeError, json.JSONDecodeError) as error:
        raise ValueError("图片素材资产工作台状态不是有效 JSON。") from error
    if not isinstance(state, dict):
        raise ValueError("图片素材资产工作台状态必须是对象。")
    shots = state.get("shots")
    if not isinstance(shots, list) or not shots:
        shots = [{"id": "shot-1", "title": "分镜 1", "prompt": "", "negative": "", "referenceImages": []}]
    state["shots"] = [shot for shot in shots if isinstance(shot, dict)]
    if not state["shots"]:
        raise ValueError("图片素材资产工作台至少需要一个分镜。")
    state["width"] = _multiple_32(state.get("width"), DEFAULT_WIDTH)
    state["height"] = _multiple_32(state.get("height"), DEFAULT_HEIGHT)
    state["modelProfile"] = str(state.get("modelProfile") or "MOSS")
    if state["modelProfile"] in {"KR2", "Krea2", "KR2 / Krea2"}:
        state["modelProfile"] = "Krea-2"
    if state["modelProfile"] not in MODEL_PROFILES:
        state["modelProfile"] = "MOSS"
    state["generationMode"] = str(state.get("generationMode") or "文生图")
    if state["generationMode"] not in GENERATION_MODES:
        state["generationMode"] = "文生图"
    return state


def _active_shot(state):
    active_id = str(state.get("activeShotId") or "")
    return next((shot for shot in state["shots"] if str(shot.get("id")) == active_id), state["shots"][0])


def _active_image_task(shot):
    tasks = shot.get("images")
    if not isinstance(tasks, list) or not tasks:
        return shot
    active_id = str(shot.get("activeImageId") or "")
    return next((task for task in tasks if isinstance(task, dict) and str(task.get("id")) == active_id), tasks[0])


def _annotated_image(record, index):
    if isinstance(record, str):
        name = record.replace("\\", "/").strip("/")
        subfolder = ""
        source_type = "input"
    elif isinstance(record, dict):
        name = str(record.get("name") or record.get("filename") or "").replace("\\", "/").strip("/")
        subfolder = str(record.get("subfolder") or "").replace("\\", "/").strip("/")
        source_type = str(record.get("type") or record.get("sourceType") or "input").lower()
    else:
        raise ValueError(f"第 {index} 张参考图记录无效。")
    if source_type not in {"input", "output", "temp"}:
        raise ValueError(f"第 {index} 张参考图来源无效：{source_type}")
    relative = posixpath.normpath(posixpath.join(subfolder, name) if subfolder else name)
    if not relative or relative in {".", ".."} or relative.startswith("../") or relative.startswith("/") or ":" in relative:
        raise ValueError(f"第 {index} 张参考图路径无效。")
    annotated = relative if source_type == "input" else f"{relative} [{source_type}]"
    if not folder_paths.exists_annotated_filepath(annotated):
        raise ValueError(f"第 {index} 张参考图不存在：{relative}")
    return annotated


def _load_image(annotated):
    path = folder_paths.get_annotated_filepath(annotated)
    opened = node_helpers.pillow(Image.open, path)
    try:
        opened.seek(0)
        image = node_helpers.pillow(ImageOps.exif_transpose, opened)
        image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
        return torch.from_numpy(np.asarray(image).astype(np.float32) / 255.0)[None,]
    finally:
        opened.close()


class XiantuImageAssetWorkbench:
    """Independent image asset workbench with model-specific conditioning."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP",),
                "project_name": ("STRING", {"default": "图片素材工程"}),
                "workbench_state": ("STRING", {"default": "{}", "multiline": True}),
                "model_profile": (MODEL_PROFILES, {"default": "MOSS"}),
                "generation_mode": (GENERATION_MODES, {"default": "文生图"}),
            },
            "optional": {
                "qwen_clip": ("CLIP", {"tooltip": "Qwen Image 2.1 专用 CLIP 接口；选择 Qwen Image 2.1 时优先使用。"}),
                "krea_clip": ("CLIP", {"tooltip": "Krea-2 专用 CLIP 接口；选择 Krea-2 时优先使用。"}),
            },
        }

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "INT", "INT", "IMAGE")
    RETURN_NAMES = ("positive", "negative", "width", "height", "image")
    FUNCTION = "build"
    CATEGORY = "闲兔/图片素材"
    DESCRIPTION = "图片素材工作台；按 MOSS、Qwen Image 2.1 或 Krea-2 协议输出正向提示词、负向提示词、宽度和高度。"

    @staticmethod
    def _encode(clip, prompt, model_profile, images=None, keep_vision=True):
        if model_profile in {"Qwen Image 2.1", "Krea-2"}:
            tokens = clip.tokenize(
                prompt,
                images=list(images or []),
                keep_vision=keep_vision,
                prevent_empty_text=True,
            )
        else:
            tokens = clip.tokenize(prompt)
        return clip.encode_from_tokens_scheduled(tokens)

    def build(
        self,
        clip,
        project_name="图片素材工程",
        model_profile="MOSS",
        generation_mode="文生图",
        workbench_state="{}",
        qwen_clip=None,
        krea_clip=None,
    ):
        del project_name
        state = _normalize_state(workbench_state)
        model_profile = str(state.get("modelProfile") or model_profile or "MOSS")
        generation_mode = str(state.get("generationMode") or generation_mode or "文生图")
        if model_profile not in MODEL_PROFILES:
            raise ValueError(f"不支持的模型协议：{model_profile}")
        shot = _active_shot(state)
        task = _active_image_task(shot)

        positive_prompt = str(
            task.get("effective_positive")
            or (task.get("active_image_task") or {}).get("prompt")
            or task.get("positive")
            or task.get("prompt")
            or ""
        ).strip()
        negative_prompt = str(
            task.get("effective_negative")
            or task.get("negative")
            or task.get("negative_prompt")
            or ""
        ).strip()
        if not positive_prompt:
            raise ValueError("当前分镜的正向提示词为空。")

        width = _multiple_32(task.get("width") or shot.get("width") or state.get("width"), DEFAULT_WIDTH)
        height = _multiple_32(task.get("height") or shot.get("height") or state.get("height"), DEFAULT_HEIGHT)
        reference_images = []
        for index, record in enumerate(task.get("referenceImages") or []):
            reference_images.append(_load_image(_annotated_image(record, index + 1)))

        if generation_mode == "图生图" and model_profile not in {"Qwen Image 2.1", "Krea-2"}:
            raise ValueError(f"{model_profile} 在当前工作台只支持文生图；图生图请选择 Qwen Image 2.1 或 Krea-2。")
        if generation_mode == "图生图" and not reference_images:
            raise ValueError("图生图模式需要在工作台左侧上传参考图片，或从资产库选择图片。")

        vision_images = []
        if generation_mode == "图生图":
            for image in reference_images:
                source = image[:1]
                samples = source.movedim(-1, 1)
                scaled = comfy.utils.common_upscale(samples, width, height, "lanczos", "center").movedim(1, -1)
                rgb = scaled[:, :, :, :3]
                vision_images.append(rgb)

        if model_profile == "Qwen Image 2.1" and qwen_clip is not None:
            active_clip = qwen_clip
        elif model_profile == "Krea-2" and krea_clip is not None:
            active_clip = krea_clip
        else:
            active_clip = clip
        positive = self._encode(active_clip, positive_prompt, model_profile, vision_images, keep_vision=True)
        negative = self._encode(active_clip, negative_prompt, model_profile, vision_images, keep_vision=True)
        output_image = vision_images[0] if vision_images else torch.zeros((1, height, width, 3), dtype=torch.float32)
        return positive, negative, width, height, output_image

    @classmethod
    def VALIDATE_INPUTS(cls, workbench_state, **_kwargs):
        try:
            _normalize_state(workbench_state)
        except ValueError as error:
            return str(error)
        return True

    @classmethod
    def IS_CHANGED(cls, workbench_state, **_kwargs):
        digest = hashlib.sha256()
        digest.update(str(workbench_state or "{}").encode("utf-8"))
        try:
            state = _normalize_state(workbench_state)
            _active_image_task(_active_shot(state))
        except (OSError, ValueError):
            pass
        return digest.hexdigest()


NODE_CLASS_MAPPINGS = {"XiantuImageAssetWorkbench": XiantuImageAssetWorkbench}
NODE_DISPLAY_NAME_MAPPINGS = {"XiantuImageAssetWorkbench": "闲兔 图片素材资产工作台"}
