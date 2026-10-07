import hashlib
import json
import math
import posixpath

import folder_paths
import node_helpers
import numpy as np
import torch
from PIL import Image, ImageOps

from comfy_extras.nodes_audio import LoadAudio
from comfy_extras.nodes_minimax_h3 import MiniMaxH3ReferenceToVideo


SELECTION_MODES = ("当前分镜", "勾选分镜", "从当前开始")
MAX_SHOTS = 500
ASPECT_RATIOS = {"9:16": (9, 16), "16:9": (16, 9), "1:1": (1, 1), "3:4": (3, 4), "4:3": (4, 3)}


def _install_qwen_image_batch_compatibility():
    try:
        from ComfyUI_Qwen_H3_Prompt.node import QwenH3Prompt
    except ImportError:
        return
    if getattr(QwenH3Prompt, "_xiantu_image_batch_compatible", False):
        return
    original_execute = QwenH3Prompt.execute

    @classmethod
    def execute(
        cls,
        prompt,
        skill,
        duration,
        llm_model,
        vision_model,
        think_mode,
        reasoning_effort,
        seed,
        max_tokens,
        video_sample_frames_per_sec,
        force_unload_model,
        reference_images=None,
        reference_videos=None,
    ):
        expanded = {}
        for image in (reference_images or {}).values():
            if image is None:
                continue
            for batch_index in range(int(image.shape[0])):
                expanded[f"reference_image_{len(expanded)}"] = image[batch_index : batch_index + 1]
        return original_execute(
            prompt,
            skill,
            duration,
            llm_model,
            vision_model,
            think_mode,
            reasoning_effort,
            seed,
            max_tokens,
            video_sample_frames_per_sec,
            force_unload_model,
            reference_images=expanded,
            reference_videos=reference_videos,
        )

    QwenH3Prompt.execute = execute
    QwenH3Prompt._xiantu_image_batch_compatible = True


_install_qwen_image_batch_compatibility()


def _text(value):
    return str(value or "").strip()


class _DigitalHumanState:
    @staticmethod
    def state(raw):
        try:
            value = json.loads(str(raw or "{}"))
        except (TypeError, json.JSONDecodeError) as error:
            raise ValueError("数字人工作台状态不是有效 JSON。") from error
        if not isinstance(value, dict):
            raise ValueError("数字人工作台状态必须是 JSON 对象。")
        resolution = value.get("resolution") if isinstance(value.get("resolution"), dict) else {}
        aspect_ratio = _text(resolution.get("aspect_ratio") or "9:16")
        if aspect_ratio not in ASPECT_RATIOS:
            aspect_ratio = "9:16"
        value["resolution"] = {
            "aspect_ratio": aspect_ratio,
            "megapixels": min(8.0, max(0.1, float(resolution.get("megapixels") or 0.6))),
            "multiple": int(resolution.get("multiple") or 32),
        }
        music = value.get("music") if isinstance(value.get("music"), dict) else None
        storyboard = value.get("storyboard")
        shots = storyboard.get("shots") if isinstance(storyboard, dict) else None
        if not isinstance(shots, list) or not shots:
            raise ValueError("数字人工作台至少需要一个内部分镜。")
        if len(shots) > MAX_SHOTS:
            raise ValueError(f"数字人工作台最多支持 {MAX_SHOTS} 个分镜。")

        normalized = []
        used_ids = set()
        for index, shot in enumerate(shots, start=1):
            if not isinstance(shot, dict):
                raise ValueError(f"第 {index} 个分镜不是对象。")
            item = dict(shot)
            shot_id = _text(shot.get("id")) or f"shot-{index:03d}"
            if shot_id in used_ids:
                raise ValueError(f"分镜 ID 重复：{shot_id}")
            used_ids.add(shot_id)
            item["id"] = shot_id
            item["prompt"] = _text(shot.get("prompt"))
            item["optimized_prompt"] = _text(shot.get("optimized_prompt"))
            images = shot.get("images") if isinstance(shot.get("images"), list) else []
            images = [record for record in images if isinstance(record, dict)][:9]
            legacy_image = shot.get("image") if isinstance(shot.get("image"), dict) else None
            if not images and legacy_image:
                images = [legacy_image]
            item["images"] = images
            legacy_audio = shot.get("audio") if isinstance(shot.get("audio"), dict) else None
            if music is None and legacy_audio is not None:
                music = legacy_audio
            audio_range = shot.get("audio_range") if isinstance(shot.get("audio_range"), dict) else shot.get("audio_trim")
            audio_range = audio_range if isinstance(audio_range, dict) else {}
            item["audio_range"] = {
                "start": max(0.0, float(audio_range.get("start") or 0.0)),
                "end": max(0.0, float(audio_range.get("end") or 0.0)),
            }
            item["duration_override"] = max(0.0, float(shot.get("duration_override") or 0.0))
            normalized.append(item)

        active_id = _text(value.get("active_shot_id"))
        active = next((shot for shot in normalized if shot["id"] == active_id), normalized[0])
        value["music"] = music
        return value, active

    @staticmethod
    def annotated_path(record, label):
        if not isinstance(record, dict):
            return ""
        source_type = _text(record.get("type") or "input").lower()
        if source_type not in {"input", "output", "temp"}:
            raise ValueError(f"{label}来源无效：{source_type}")
        name = _text(record.get("name") or record.get("filename")).replace("\\", "/").strip("/")
        subfolder = _text(record.get("subfolder")).replace("\\", "/").strip("/")
        relative = posixpath.join(subfolder, name) if subfolder else name
        normalized = posixpath.normpath(relative)
        if not normalized or normalized in {".", ".."} or normalized.startswith("../") or normalized.startswith("/") or ":" in normalized:
            raise ValueError(f"{label}路径无效。")
        annotated = normalized if source_type == "input" else f"{normalized} [{source_type}]"
        if not folder_paths.exists_annotated_filepath(annotated):
            raise ValueError(f"{label}不存在：{normalized}")
        return annotated

    @classmethod
    def load_image(cls, record):
        annotated = cls.annotated_path(record, "上传图片")
        if not annotated:
            raise ValueError("当前分镜还没有上传图片。")
        path = folder_paths.get_annotated_filepath(annotated)
        opened = node_helpers.pillow(Image.open, path)
        try:
            opened.seek(0)
            image = node_helpers.pillow(ImageOps.exif_transpose, opened).convert("RGB")
            array = np.asarray(image).astype(np.float32) / 255.0
            return torch.from_numpy(array)[None,]
        finally:
            opened.close()

    @classmethod
    def load_audio(cls, record):
        annotated = cls.annotated_path(record, "上传音频")
        if not annotated:
            raise ValueError("当前分镜还没有上传音频。")
        return LoadAudio.execute(annotated).result[0]

    @staticmethod
    def trim_audio(audio, trim):
        waveform = audio.get("waveform")
        sample_rate = int(audio.get("sample_rate") or 0)
        if waveform is None or sample_rate <= 0:
            raise ValueError("上传音频的数据无效。")
        duration = waveform.shape[-1] / sample_rate
        start = min(max(0.0, float((trim or {}).get("start") or 0.0)), duration)
        requested_end = float((trim or {}).get("end") or 0.0)
        end = duration if requested_end <= 0 else min(max(0.0, requested_end), duration)
        if end <= start:
            raise ValueError("音轨切断终点必须大于起点。")
        start_sample = min(waveform.shape[-1] - 1, int(round(start * sample_rate)))
        end_sample = min(waveform.shape[-1], max(start_sample + 1, int(round(end * sample_rate))))
        return {**audio, "waveform": waveform[..., start_sample:end_sample]}

    @staticmethod
    def dimensions(resolution):
        ratio_w, ratio_h = ASPECT_RATIOS[resolution["aspect_ratio"]]
        pixels = float(resolution["megapixels"]) * 1_000_000
        multiple = int(resolution["multiple"])
        if multiple not in {8, 16, 32, 64}:
            multiple = 32
        ratio = ratio_w / ratio_h
        width = max(multiple, round(math.sqrt(pixels * ratio) / multiple) * multiple)
        height = max(multiple, round(math.sqrt(pixels / ratio) / multiple) * multiple)
        return int(width), int(height)


class XiantuDigitalHumanStudio(_DigitalHumanState):
    """独立分镜素材台：输出当前分镜的图片、原始提示词和音频。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP",),
                "vae": ("VAE",),
                "audio_vae": ("VAE",),
                "length": ("INT", {"default": 0, "min": 0, "max": 3600, "step": 1}),
                "ref_image_size": (["match", "max"],),
                "studio_state": ("STRING", {"default": "{}", "multiline": False}),
                "selection_mode": (SELECTION_MODES,),
            },
            "optional": {
                "optimized_prompt": ("STRING", {"forceInput": True}),
            },
        }

    RETURN_TYPES = ("CONDITIONING", "LATENT", "IMAGE", "AUDIO", "FLOAT", "INT")
    RETURN_NAMES = ("条件", "LATENT", "图像", "音频", "秒数", "预览帧")
    FUNCTION = "encode"
    CATEGORY = "闲兔/数字人"
    DESCRIPTION = "独立数字人分镜素材台。当前分镜的图片和提示词可接 Qwen H3 Prompt，音频直接接数字人 H3 生成。"

    @staticmethod
    def image_batch(images):
        target_h, target_w = images[0].shape[1:3]
        normalized = []
        for image in images:
            if image.shape[1:3] != (target_h, target_w):
                channels_first = image.permute(0, 3, 1, 2)
                channels_first = torch.nn.functional.interpolate(
                    channels_first,
                    size=(target_h, target_w),
                    mode="bilinear",
                    align_corners=False,
                )
                image = channels_first.permute(0, 2, 3, 1)
            normalized.append(image[:1])
        return torch.cat(normalized, dim=0)

    def encode(
        self,
        clip,
        vae,
        audio_vae,
        length,
        ref_image_size,
        studio_state,
        selection_mode,
        optimized_prompt=None,
    ):
        state, shot = self.state(studio_state)
        if not shot["prompt"]:
            raise ValueError("当前分镜的提示词为空。")
        images = [self.load_image(record) for record in shot.get("images", [])]
        if not images:
            raise ValueError("当前分镜还没有上传参考图。")
        audio = self.trim_audio(self.load_audio(state.get("music")), shot.get("audio_range"))
        actual_duration = audio["waveform"].shape[-1] / int(audio["sample_rate"])
        duration = shot.get("duration_override") or actual_duration
        width, height = self.dimensions(state["resolution"])
        final_prompt = _text(optimized_prompt) or _text(shot.get("optimized_prompt"))
        if not final_prompt:
            raise ValueError("优化后提示词为空，请连接 Qwen H3 Prompt 的 h3_prompt 输出。")
        requested_length = int(length)
        if requested_length <= 0:
            base_frames = max(5, round(float(duration) * 24))
            requested_length = base_frames + (5 - base_frames % 17) % 17
        result = MiniMaxH3ReferenceToVideo.execute(
            clip=clip,
            vae=vae,
            audio_vae=audio_vae,
            prompt=final_prompt,
            width=width,
            height=height,
            length=requested_length,
            ref_image_size=ref_image_size,
            ref_images={f"ref_image_{index}": item for index, item in enumerate(images)},
            ref_videos={},
            ref_video_audios={},
            ref_audios={"ref_audio_0": audio},
        )
        return (*result.result, self.image_batch(images), audio, float(duration), int(requested_length))

    @classmethod
    def VALIDATE_INPUTS(cls, studio_state, selection_mode, **_kwargs):
        if selection_mode not in SELECTION_MODES:
            return "未知的数字人任务范围。"
        try:
            cls.state(studio_state)
        except ValueError as error:
            return str(error)
        return True

    @classmethod
    def IS_CHANGED(cls, studio_state, selection_mode, **_kwargs):
        digest = hashlib.sha256()
        digest.update(str(studio_state).encode("utf-8"))
        digest.update(str(selection_mode).encode("utf-8"))
        return digest.hexdigest()


class XiantuDigitalHumanH3Encode:
    """接收 Qwen 优化后的提示词和素材，调用 ComfyUI 原生 MiniMax H3 编码。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "clip": ("CLIP",),
                "vae": ("VAE",),
                "audio_vae": ("VAE",),
                "materials": ("DIGITAL_HUMAN_MATERIALS",),
                "optimized_prompt": ("STRING", {"default": "", "multiline": True}),
                "length": ("INT", {"default": 0, "min": 0, "max": 3600, "step": 1}),
                "ref_image_size": (["match", "max"],),
            },
            "optional": {
                "ref_video_0": ("IMAGE",),
                "ref_video_audio_0": ("AUDIO",),
                "ref_audio_0": ("AUDIO",),
                "ref_audio_1": ("AUDIO",),
            },
        }

    RETURN_TYPES = ("CONDITIONING", "LATENT")
    RETURN_NAMES = ("条件", "LATENT")
    FUNCTION = "encode"
    CATEGORY = "闲兔/数字人"
    DESCRIPTION = "使用 Qwen H3 Prompt 输出的优化提示词和数字人工作台素材，生成原生 MiniMax H3 条件与 LATENT。"

    def encode(
        self,
        clip,
        vae,
        audio_vae,
        materials,
        optimized_prompt,
        length,
        ref_image_size,
        ref_video_0=None,
        ref_video_audio_0=None,
        ref_audio_0=None,
        ref_audio_1=None,
    ):
        prompt = _text(optimized_prompt)
        if not prompt:
            raise ValueError("优化后提示词为空，请连接 Qwen H3 Prompt 的 h3_prompt 输出。")
        if not isinstance(materials, dict):
            raise ValueError("请连接数字人工作台的数字人素材包输出。")
        images = [item for item in materials.get("images", []) if item is not None][:9]
        source_audio = materials.get("audio")
        segment_duration = float(materials.get("duration") or 0.0)
        width = int(materials.get("width") or 0)
        height = int(materials.get("height") or 0)
        if not images or source_audio is None or width <= 0 or height <= 0:
            raise ValueError("数字人素材包缺少参考图、分段音频或有效尺寸。")
        requested_length = int(length)
        if requested_length <= 0:
            if float(segment_duration) <= 0:
                raise ValueError("自动视频长度需要连接数字人工作台的分段时长输出。")
            base_frames = max(5, round(float(segment_duration) * 24))
            requested_length = base_frames + (5 - base_frames % 17) % 17
        audios = [item for item in (source_audio, ref_audio_0, ref_audio_1) if item is not None]
        result = MiniMaxH3ReferenceToVideo.execute(
            clip=clip,
            vae=vae,
            audio_vae=audio_vae,
            prompt=prompt,
            width=int(width),
            height=int(height),
            length=requested_length,
            ref_image_size=ref_image_size,
            ref_images={f"ref_image_{index}": item for index, item in enumerate(images)},
            ref_videos={"ref_video_0": ref_video_0} if ref_video_0 is not None else {},
            ref_video_audios={"ref_video_audio_0": ref_video_audio_0} if ref_video_audio_0 is not None else {},
            ref_audios={f"ref_audio_{index}": item for index, item in enumerate(audios)},
        )
        return result.result


class XiantuDigitalHumanQwenBridge:
    """只在需要外接 Qwen H3 Prompt 时展开最多九张参考图。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"materials": ("DIGITAL_HUMAN_MATERIALS",)}}

    RETURN_TYPES = ("IMAGE",) * 9 + ("STRING",)
    RETURN_NAMES = tuple(f"参考图{i}" for i in range(1, 10)) + ("原始提示词",)
    FUNCTION = "unpack"
    CATEGORY = "闲兔/数字人"
    DESCRIPTION = "将数字人工作台内部上传的参考图展开给 Qwen H3 Prompt 的 reference_images 接口。"

    def unpack(self, materials):
        if not isinstance(materials, dict):
            raise ValueError("请连接数字人工作台的数字人素材包输出。")
        images = [item for item in materials.get("images", []) if item is not None][:9]
        if not images:
            raise ValueError("当前分镜没有参考图。")
        return tuple(images + [None] * (9 - len(images)) + [_text(materials.get("prompt"))])


class XiantuDigitalHumanImageOutput(_DigitalHumanState):
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"studio_state": ("STRING", {"default": "{}", "multiline": False})}}

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图片",)
    FUNCTION = "output"
    CATEGORY = "闲兔/数字人/输出"

    def output(self, studio_state):
        _state, shot = self.state(studio_state)
        images = [self.load_image(record) for record in shot.get("images", [])]
        if not images:
            raise ValueError("当前分镜还没有上传参考图。")
        return (XiantuDigitalHumanStudio.image_batch(images),)


class XiantuDigitalHumanPromptOutput(_DigitalHumanState):
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"studio_state": ("STRING", {"default": "{}", "multiline": False})}}

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("提示词",)
    FUNCTION = "output"
    CATEGORY = "闲兔/数字人/输出"

    def output(self, studio_state):
        _state, shot = self.state(studio_state)
        if not shot["prompt"]:
            raise ValueError("当前分镜的提示词为空。")
        return (shot["prompt"],)


class XiantuDigitalHumanAudioOutput(_DigitalHumanState):
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"studio_state": ("STRING", {"default": "{}", "multiline": False})}}

    RETURN_TYPES = ("AUDIO",)
    RETURN_NAMES = ("音乐",)
    FUNCTION = "output"
    CATEGORY = "闲兔/数字人/输出"

    def output(self, studio_state):
        state, shot = self.state(studio_state)
        audio = self.trim_audio(self.load_audio(state.get("music")), shot.get("audio_range"))
        return (audio,)


NODE_CLASS_MAPPINGS = {
    "XiantuDigitalHumanStudio": XiantuDigitalHumanStudio,
    "XiantuDigitalHumanImageOutput": XiantuDigitalHumanImageOutput,
    "XiantuDigitalHumanPromptOutput": XiantuDigitalHumanPromptOutput,
    "XiantuDigitalHumanAudioOutput": XiantuDigitalHumanAudioOutput,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiantuDigitalHumanStudio": "闲兔｜数字人工作台",
    "XiantuDigitalHumanImageOutput": "闲兔｜数字人图片输出",
    "XiantuDigitalHumanPromptOutput": "闲兔｜数字人提示词输出",
    "XiantuDigitalHumanAudioOutput": "闲兔｜数字人音乐输出",
}
