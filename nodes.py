import hashlib
import json
import math
import posixpath

import comfy.model_management
import comfy.utils
import folder_paths
import node_helpers
import numpy as np
import torch
from PIL import Image, ImageOps


MAX_REFERENCE_IMAGES = 16


class XiantuQwenImage21Director:
    """Qwen Image 2.1 encoder with director-style embedded reference assets."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP",),
                "positive_prompt": (
                    "STRING",
                    {"default": "", "multiline": True, "dynamicPrompts": True},
                ),
                "negative_prompt": (
                    "STRING",
                    {"default": "", "multiline": True, "dynamicPrompts": True},
                ),
                "resolution": (
                    "INT",
                    {
                        "default": 1024,
                        "min": 0,
                        "max": 4096,
                        "step": 32,
                        "tooltip": (
                            "参考图按约 resolution × resolution 像素缩放并保持比例；"
                            "0 表示保留原尺寸并取 32 的倍数。"
                        ),
                    },
                ),
                "reference_images": (
                    "STRING",
                    {"default": "[]", "multiline": False},
                ),
            },
            "optional": {
                "vae": ("VAE",),
                "分镜": (
                    "STRING",
                    {
                        "forceInput": True,
                        "tooltip": "预留给闲兔分镜节点的 JSON 连线接口。",
                    },
                ),
            },
        }

    RETURN_TYPES = ("CONDITIONING", "CONDITIONING", "LATENT")
    RETURN_NAMES = ("positive", "negative", "latent")
    FUNCTION = "encode"
    CATEGORY = "闲兔/Qwen Image 2.1"
    DESCRIPTION = (
        "使用与 ComfyUI Text Encode Qwen Image 2.1 相同的编码参数和算法，"
        "并在节点内部管理最多 16 张上传参考图。"
    )

    @staticmethod
    def _parse_reference_images(reference_images):
        try:
            raw_items = json.loads(reference_images or "[]")
        except (TypeError, json.JSONDecodeError) as error:
            raise ValueError("参考图清单不是有效 JSON。") from error

        if not isinstance(raw_items, list):
            raise ValueError("参考图清单必须是数组。")
        if len(raw_items) > MAX_REFERENCE_IMAGES:
            raise ValueError(f"Qwen Image 2.1 最多支持 {MAX_REFERENCE_IMAGES} 张参考图。")

        paths = []
        for index, item in enumerate(raw_items, start=1):
            if isinstance(item, str):
                relative_path = item.replace("\\", "/").strip()
            elif isinstance(item, dict):
                if str(item.get("type", "input")) != "input":
                    raise ValueError(f"第 {index} 张参考图不是 ComfyUI input 素材。")
                name = str(item.get("name", "")).replace("\\", "/").strip("/")
                subfolder = str(item.get("subfolder", "")).replace("\\", "/").strip("/")
                relative_path = posixpath.join(subfolder, name) if subfolder else name
            else:
                raise ValueError(f"第 {index} 张参考图记录格式无效。")

            normalized = posixpath.normpath(relative_path)
            if (
                not normalized
                or normalized in {".", ".."}
                or normalized.startswith("../")
                or normalized.startswith("/")
                or ":" in normalized
            ):
                raise ValueError(f"第 {index} 张参考图路径无效。")
            if not folder_paths.exists_annotated_filepath(normalized):
                raise ValueError(f"第 {index} 张参考图不存在：{normalized}")
            paths.append(normalized)
        return paths

    @staticmethod
    def _load_image(relative_path):
        image_path = folder_paths.get_annotated_filepath(relative_path)
        opened = node_helpers.pillow(Image.open, image_path)
        try:
            opened.seek(0)
            image = node_helpers.pillow(ImageOps.exif_transpose, opened)
            has_alpha = "A" in image.getbands()
            image = image.convert("RGBA" if has_alpha else "RGB")
            array = np.asarray(image).astype(np.float32) / 255.0
            return torch.from_numpy(array)[None,]
        finally:
            opened.close()

    def encode(
        self,
        clip,
        positive_prompt,
        negative_prompt,
        resolution,
        reference_images,
        vae=None,
        分镜="",
    ):
        del 分镜
        images = [
            self._load_image(path)
            for path in self._parse_reference_images(reference_images)
        ]

        # Keep this block aligned with ComfyUI's TextEncodeQwenImage21.execute.
        ref_latents = []
        images_vl = []
        latent_w = latent_h = resolution or 1024
        for image in images:
            samples = image[:1].movedim(-1, 1)
            if resolution > 0:
                ratio = samples.shape[3] / samples.shape[2]
                width = round(math.sqrt(resolution * resolution * ratio) / 32) * 32
                height = round(math.sqrt(resolution * resolution / ratio) / 32) * 32
            else:
                width = round(samples.shape[3] / 32) * 32
                height = round(samples.shape[2] / 32) * 32
            width, height = max(32, width), max(32, height)
            if (width, height) == (samples.shape[3], samples.shape[2]):
                scaled = image[:1]
            else:
                scaled = comfy.utils.common_upscale(
                    samples, width, height, "lanczos", "disabled"
                ).movedim(1, -1)
            if not images_vl:
                latent_w, latent_h = width, height
            rgb = scaled[:, :, :, :3]
            if scaled.shape[-1] > 3:
                rgb = rgb * scaled[:, :, :, 3:] + (1.0 - scaled[:, :, :, 3:])
            images_vl.append(rgb)
            if vae is not None:
                ref_latents.append(vae.encode(scaled))

        keep_vision = len(ref_latents) == 0
        positive = clip.encode_from_tokens_scheduled(
            clip.tokenize(
                positive_prompt,
                images=images_vl,
                keep_vision=keep_vision,
                prevent_empty_text=True,
            )
        )
        negative = clip.encode_from_tokens_scheduled(
            clip.tokenize(
                negative_prompt,
                images=images_vl,
                keep_vision=keep_vision,
                prevent_empty_text=True,
            )
        )
        if ref_latents:
            positive = node_helpers.conditioning_set_values(
                positive, {"reference_latents": ref_latents}, append=True
            )
            negative = node_helpers.conditioning_set_values(
                negative, {"reference_latents": ref_latents}, append=True
            )
        latent = torch.zeros(
            [1, 64, latent_h // 16, latent_w // 16],
            device=comfy.model_management.intermediate_device(),
        )
        return (positive, negative, {"samples": latent})

    @classmethod
    def VALIDATE_INPUTS(cls, reference_images, **_kwargs):
        try:
            cls._parse_reference_images(reference_images)
        except ValueError as error:
            return str(error)
        return True

    @classmethod
    def IS_CHANGED(
        cls,
        positive_prompt,
        negative_prompt,
        resolution,
        reference_images,
        分镜="",
        **_kwargs,
    ):
        digest = hashlib.sha256()
        digest.update(str(positive_prompt).encode("utf-8"))
        digest.update(str(negative_prompt).encode("utf-8"))
        digest.update(str(resolution).encode("ascii"))
        digest.update(str(reference_images).encode("utf-8"))
        digest.update(str(分镜).encode("utf-8"))
        try:
            for relative_path in cls._parse_reference_images(reference_images):
                with open(folder_paths.get_annotated_filepath(relative_path), "rb") as handle:
                    for block in iter(lambda: handle.read(1024 * 1024), b""):
                        digest.update(block)
        except (OSError, ValueError):
            pass
        return digest.hexdigest()


NODE_CLASS_MAPPINGS = {
    "XiantuQwenImage21Director": XiantuQwenImage21Director,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiantuQwenImage21Director": "闲兔Qwen Image 2.1 工作台",
}
