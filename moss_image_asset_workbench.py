from __future__ import annotations

import hashlib
import json

import torch


DEFAULT_WIDTH = 1024
DEFAULT_HEIGHT = 1024


def _multiple_32(value, fallback):
    number = int(value or fallback)
    return max(32, min(4096, round(number / 32) * 32))


def _normalize_state(raw):
    try:
        state = json.loads(str(raw or "{}"))
    except (TypeError, json.JSONDecodeError) as error:
        raise ValueError("MOSS图片资产工作台状态不是有效 JSON。") from error
    if not isinstance(state, dict):
        raise ValueError("MOSS图片资产工作台状态必须是对象。")

    shots = state.get("shots")
    if not isinstance(shots, list) or not shots:
        shots = [{"id": "shot-1", "title": "分镜 1", "prompt": "", "negative": ""}]
    state["shots"] = [shot for shot in shots if isinstance(shot, dict)]
    if not state["shots"]:
        raise ValueError("MOSS图片资产工作台至少需要一个分镜。")

    state["width"] = _multiple_32(state.get("width"), DEFAULT_WIDTH)
    state["height"] = _multiple_32(state.get("height"), DEFAULT_HEIGHT)
    state["modelProfile"] = "MOSS"
    state["generationMode"] = "文生图"
    return state


def _active_shot(state):
    active_id = str(state.get("activeShotId") or "")
    return next(
        (shot for shot in state["shots"] if str(shot.get("id")) == active_id),
        state["shots"][0],
    )


def _active_image_task(shot):
    tasks = shot.get("images")
    if not isinstance(tasks, list) or not tasks:
        return shot
    active_id = str(shot.get("activeImageId") or "")
    return next(
        (
            task
            for task in tasks
            if isinstance(task, dict) and str(task.get("id")) == active_id
        ),
        tasks[0],
    )


class XiantuMossImageAssetWorkbench:
    """Standalone MOSS-only image asset workbench."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP", {"tooltip": "MOSS 模型使用的 CLIP 输入。"}),
                "project_name": ("STRING", {"default": "MOSS图片素材工程"}),
                "workbench_state": ("STRING", {"default": "{}", "multiline": True}),
            }
        }

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "INT", "INT", "IMAGE")
    RETURN_NAMES = ("positive", "negative", "width", "height", "image")
    FUNCTION = "build"
    CATEGORY = "闲兔/图片素材"
    DESCRIPTION = "独立的 MOSS 图片资产工作台，仅使用 clip 输入并输出正负提示词、宽高和占位图像。"

    def build(self, clip, project_name="MOSS图片素材工程", workbench_state="{}"):
        del project_name
        state = _normalize_state(workbench_state)
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

        width = _multiple_32(
            task.get("width") or shot.get("width") or state.get("width"),
            DEFAULT_WIDTH,
        )
        height = _multiple_32(
            task.get("height") or shot.get("height") or state.get("height"),
            DEFAULT_HEIGHT,
        )
        positive = clip.encode_from_tokens_scheduled(clip.tokenize(positive_prompt))
        negative = clip.encode_from_tokens_scheduled(clip.tokenize(negative_prompt))
        image = torch.zeros((1, height, width, 3), dtype=torch.float32)
        return positive, negative, width, height, image

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
        return digest.hexdigest()


NODE_CLASS_MAPPINGS = {
    "XiantuMossImageAssetWorkbench": XiantuMossImageAssetWorkbench,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiantuMossImageAssetWorkbench": "MOSS图片资产工作台",
}
