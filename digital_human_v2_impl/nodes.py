from __future__ import annotations

import importlib
import math
import re
import sys
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from comfy_extras.nodes_minimax_h3 import MiniMaxH3ReferenceToVideo
from comfy_extras.nodes_lt import LTXVConcatAVLatent, LTXVSeparateAVLatent
from comfy_extras.nodes_lt_audio import LTXVAudioVAEEncode

from .storage import project_dir, read_state, save_state


def resolution_dimensions(settings):
    """Match ComfyUI's ResolutionSelector calculation exactly."""
    match = re.search(r"(\d+)\s*:\s*(\d+)", str(settings.get("aspect") or "16:9"))
    if not match:
        return int(settings.get("width", 1056)), int(settings.get("height", 608))
    ratio_w, ratio_h = int(match.group(1)), int(match.group(2))
    megapixels = max(0.1, float(settings.get("megapixels") or 0.6))
    multiple = int(settings.get("multiple") or 32)
    if multiple <= 0:
        multiple = 32
    scale = math.sqrt((megapixels * 1024 * 1024) / (ratio_w * ratio_h))
    width = max(multiple, round(ratio_w * scale / multiple) * multiple)
    height = max(multiple, round(ratio_h * scale / multiple) * multiple)
    return int(width), int(height)


def resolve_qwen_h3():
    """Resolve an optional Qwen H3 implementation without tripping torch namespaces."""
    for module in list(sys.modules.values()):
        namespace = getattr(module, "__dict__", None) if module is not None else None
        if isinstance(namespace, dict):
            node_class = namespace.get("QwenH3Prompt")
            if isinstance(node_class, type) and callable(node_class.__dict__.get("execute")):
                return (
                    node_class,
                    getattr(module, "DEFAULT_MODEL", "Qwen3.8-27B-Q4_K_M.gguf"),
                    getattr(module, "DEFAULT_MMPROJ", "mmproj-F16.gguf"),
                )
    errors = []
    for module_name in (
        "ComfyUI_Qwen_H3_Prompt.node",
        "custom_nodes.ComfyUI_Qwen_H3_Prompt.node",
    ):
        try:
            module = importlib.import_module(module_name)
            return module.QwenH3Prompt, module.DEFAULT_MODEL, module.DEFAULT_MMPROJ
        except Exception as error:  # noqa: BLE001
            errors.append(f"{module_name}: {error}")
    raise RuntimeError("；".join(errors))


def load_audio(path: Path, start: float, end: float):
    import soundfile as sf
    samples, sample_rate = sf.read(str(path), always_2d=True, dtype="float32")
    left = max(0, round(float(start) * sample_rate))
    right = min(len(samples), round(float(end) * sample_rate)) if end > start else len(samples)
    samples = samples[left:right]
    return {"waveform": torch.from_numpy(samples.T.copy()).unsqueeze(0), "sample_rate": int(sample_rate)}


def load_mixed_audio(base: Path, tracks: list[dict], start: float, end: float):
    """Mix the selected time range from every unmuted project track."""
    import soundfile as sf

    if not tracks:
        raise ValueError("工作台中还没有上传音频。")
    start = max(0.0, float(start))
    end = max(start + 0.01, float(end))
    target_rate = max((int(item.get("sample_rate") or 0) for item in tracks), default=0) or 44100
    target_length = max(1, round((end - start) * target_rate))
    mixed = np.zeros((target_length, 2), dtype=np.float32)
    for item in tracks:
        if item.get("muted"):
            continue
        path = base / str(item.get("path") or "")
        if not path.is_file():
            continue
        samples, sample_rate = sf.read(str(path), always_2d=True, dtype="float32")
        if samples.shape[1] == 1:
            samples = np.repeat(samples, 2, axis=1)
        elif samples.shape[1] > 2:
            samples = samples[:, :2]
        sample_rate = int(sample_rate)
        if sample_rate != target_rate and len(samples) > 1:
            target_count = max(1, round(len(samples) * target_rate / sample_rate))
            source_axis = np.linspace(0.0, 1.0, len(samples), endpoint=False)
            target_axis = np.linspace(0.0, 1.0, target_count, endpoint=False)
            samples = np.column_stack([
                np.interp(target_axis, source_axis, samples[:, channel])
                for channel in range(samples.shape[1])
            ]).astype(np.float32)
        offset = max(0.0, float(item.get("offset") or 0))
        overlap_start = max(start, offset)
        overlap_end = min(end, offset + len(samples) / target_rate)
        if overlap_end <= overlap_start:
            continue
        source_left = max(0, round((overlap_start - offset) * target_rate))
        target_left = max(0, round((overlap_start - start) * target_rate))
        count = min(
            len(samples) - source_left,
            target_length - target_left,
            max(0, round((overlap_end - overlap_start) * target_rate)),
        )
        if count > 0:
            volume = max(0.0, min(2.0, float(item.get("volume", 1.0))))
            mixed[target_left:target_left + count] += samples[source_left:source_left + count] * volume
    mixed = np.clip(mixed, -1.0, 1.0)
    return {"waveform": torch.from_numpy(mixed.T.copy()).unsqueeze(0), "sample_rate": target_rate}


def load_image(path: Path):
    image = Image.open(path).convert("RGB")
    array = np.asarray(image, dtype=np.float32) / 255.0
    return torch.from_numpy(array).unsqueeze(0)


def make_image_batch(images: list[torch.Tensor], width: int, height: int) -> torch.Tensor:
    """Create a uniform IMAGE batch without changing the reference tensors used by H3."""
    target_width = max(64, int(width))
    target_height = max(64, int(height))
    batch = []
    for image in images:
        source = image.movedim(-1, 1)
        source_height, source_width = int(source.shape[-2]), int(source.shape[-1])
        scale = min(target_width / source_width, target_height / source_height)
        resized_width = max(1, round(source_width * scale))
        resized_height = max(1, round(source_height * scale))
        resized = torch.nn.functional.interpolate(
            source,
            size=(resized_height, resized_width),
            mode="bilinear",
            align_corners=False,
        )
        canvas = torch.zeros(
            (resized.shape[0], resized.shape[1], target_height, target_width),
            dtype=resized.dtype,
            device=resized.device,
        )
        top = (target_height - resized_height) // 2
        left = (target_width - resized_width) // 2
        canvas[:, :, top:top + resized_height, left:left + resized_width] = resized
        batch.append(canvas.movedim(1, -1))
    return torch.cat(batch, dim=0)


def normalize_reference_tokens(prompt: str, image_count: int) -> str:
    """Map UI image tokens to MiniMax H3's native <Picture N> labels."""
    def replace_picture(match):
        index = int(match.group(1))
        return f"<Picture {index}>" if 1 <= index <= image_count else match.group(0)

    def replace_image(match):
        zero_based = bool(match.group(1))
        raw_index = int(match.group(2))
        index = raw_index + 1 if zero_based else raw_index
        return f"<Picture {index}>" if 1 <= index <= image_count else match.group(0)

    value = re.sub(r"<\s*picture\s*(\d+)\s*>", replace_picture, str(prompt), flags=re.IGNORECASE)
    return re.sub(r"<\s*image\s*(_?)\s*(\d+)\s*>", replace_image, value, flags=re.IGNORECASE)


DIGITAL_HUMAN_CAMERA_RULES = (
    (
        "slow_push_in",
        "中近景缓慢推近至近景，幅度轻微，人物面部始终清晰且占据画面主体。",
    ),
    (
        "truck_left",
        "保持中近景，摄影机极缓慢向左横移，人物大小基本不变，面部持续清晰。",
    ),
    (
        "micro_arc_right",
        "保持近景，摄影机围绕人物做小幅右弧移动，不改变人物主体大小。",
    ),
    (
        "locked_closeup",
        "稳定近景机位，仅允许自然的微小呼吸感构图变化，禁止明显缩放。",
    ),
    (
        "truck_right",
        "保持中近景，摄影机极缓慢向右横移，人物大小基本不变，面部持续清晰。",
    ),
    (
        "micro_arc_left",
        "保持近景，摄影机围绕人物做小幅左弧移动，不改变人物主体大小。",
    ),
    (
        "micro_reframe",
        "保持中近景到近景，只做轻微重构图，人物面部位置和大小保持稳定。",
    ),
)

# A camera move may only reappear after at least five different segments.
MIN_CAMERA_REPEAT_GAP = 5


def digital_human_director_guidance(segment_index: int) -> tuple[str, str]:
    """Return a repeatable close-shot camera rule for the current segment."""
    if len(DIGITAL_HUMAN_CAMERA_RULES) <= MIN_CAMERA_REPEAT_GAP:
        raise RuntimeError("Digital-human camera rules must exceed the five-segment repeat gap.")
    camera_move, movement = DIGITAL_HUMAN_CAMERA_RULES[int(segment_index) % len(DIGITAL_HUMAN_CAMERA_RULES)]
    framing = (
        "景别硬规则：默认使用中近景、近景或自然面部特写；内容明确需要时允许近距离全身构图，"
        "但人物必须保持足够大的画面占比。禁止远景、大全景和把人物拍得过小，禁止大幅拉远或快速缩放。"
        "人物脸部和口型必须始终清晰可见。"
    )
    return camera_move, f"{movement}\n{framing}"


def append_director_guidance(prompt: str, guidance: str) -> str:
    """Keep hard camera/framing rules in the final H3 prompt, even after optimization."""
    block = f"【数字人导演硬规则】\n{guidance}"
    value = str(prompt).strip()
    return value if block in value else f"{value}\n\n{block}".strip()


def video_filename_prefixes(settings: dict, segment: dict, segment_index: int) -> tuple[str, str]:
    """Apply the V3 director naming rule inside fixed digital-human folders."""
    number = int(segment_index) + 1
    rule = str(settings.get("filename_prefix") or "").strip().replace("\\", "/")

    def clean_part(value: str, fallback: str) -> str:
        value = re.sub(r'[<>:"|?*\x00-\x1f]+', "_", str(value))
        value = re.sub(r"\s+", " ", value).strip(" ._")
        return value or fallback

    if rule:
        parts = [clean_part(part, "") for part in rule.split("/") if part.strip(" ._")]
        if parts:
            parts[-1] = f"{parts[-1]}{number:02d}"
            relative = "/".join(parts)
        else:
            relative = f"{number:02d}-{clean_part(segment.get('name'), f'分镜 {number:02d}')}"
    else:
        relative = f"{number:02d}-{clean_part(segment.get('name'), f'分镜 {number:02d}')}"
    return (f"数字人/放大前/{relative}", f"数字人/放大后/{relative}")


MODEL_ADAPTERS = {
    "h3": {
        "inputs": {
            "H3_CLIP": ("CLIP",),
            "H3_VIDEO_VAE": ("VAE",),
            "H3_AUDIO_VAE": ("VAE",),
        },
        "outputs": (
            ("H3条件", "CONDITIONING"),
            ("H3 Latent", "LATENT"),
            ("H3图像", "IMAGE"),
            ("H3音频", "AUDIO"),
            ("H3放大前文件名", "STRING"),
            ("H3放大后文件名", "STRING"),
        ),
    },
}


class XiantuDigitalHumanStudioV2:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "project_id": ("STRING", {"default": ""}),
                "segment_index": ("INT", {"default": 0, "min": 0, "max": 9999}),
            },
            # Model-specific ports stay optional globally. The selected adapter
            # validates only its own group, so future model groups can coexist.
            "optional": {
                name: spec
                for adapter in MODEL_ADAPTERS.values()
                for name, spec in adapter["inputs"].items()
            },
        }

    RETURN_TYPES = tuple(item[1] for adapter in MODEL_ADAPTERS.values() for item in adapter["outputs"])
    RETURN_NAMES = tuple(item[0] for adapter in MODEL_ADAPTERS.values() for item in adapter["outputs"])
    FUNCTION = "process"
    CATEGORY = "闲兔/数字人 V2"
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, project_id="", segment_index=0, **_kwargs):
        try:
            state_file = project_dir(project_id) / "state.json"
            return f"{state_file.stat().st_mtime_ns}:{int(segment_index)}"
        except Exception:
            return float("nan")

    def process(self, project_id, segment_index=0, H3_CLIP=None, H3_VIDEO_VAE=None, H3_AUDIO_VAE=None, **_model_inputs):
        if not str(project_id).strip():
            raise ValueError("请先点击‘打开数字人工作台’，上传音频并设置当前分镜。")
        state = read_state(project_id)
        segments = state.get("segments") or []
        if not segments:
            raise ValueError("工作台中还没有分镜。")
        index = max(0, min(int(segment_index), len(segments) - 1))
        segment = segments[index]
        refs = list(segment.get("refs") or [])
        if not refs:
            raise ValueError("当前分镜还没有参考图。")
        tracks = list(state.get("audio_tracks") or [])
        if not tracks:
            raise ValueError("工作台中还没有上传音频。")
        settings = state.get("settings") or {}
        if str(settings.get("model_profile") or "h3") != "h3":
            raise ValueError("当前工作台节点仅处理 H3 模型配置，请连接所选模型对应的独立数字人节点。")
        if H3_CLIP is None or H3_VIDEO_VAE is None or H3_AUDIO_VAE is None:
            raise ValueError("当前选择 H3模型，请连接 H3_CLIP、H3_VIDEO_VAE 和 H3_AUDIO_VAE 输入口。")
        clip, vae, audio_vae = H3_CLIP, H3_VIDEO_VAE, H3_AUDIO_VAE
        auto_optimize = bool(settings.get("auto_optimize", False))
        original_prompt = str(segment.get("original_prompt") or "").strip()
        if not original_prompt:
            raise ValueError("当前分镜的提示词为空。")
        base = project_dir(project_id)
        reference_audio = load_mixed_audio(base, tracks, segment.get("start", 0), segment.get("end", 0))
        if segment.get("muted"):
            reference_audio["waveform"] = torch.zeros_like(reference_audio["waveform"])
        images = [load_image(base / item["path"]) for item in refs[:9]]
        duration = max(0.01, float(segment.get("end", 0)) - float(segment.get("start", 0)))
        width, height = resolution_dimensions(settings)
        settings["width"] = width
        settings["height"] = height
        settings["resolution"] = f"{width} × {height}"
        skill = str(settings.get("skill") or "auto")
        performance_mode = str(settings.get("performance_mode") or "singing")
        performance_label = "数字人口播" if performance_mode == "speaking" else "人物演唱"
        camera_move, director_guidance = digital_human_director_guidance(index)
        segment["camera_move"] = camera_move
        segment["director_guidance"] = director_guidance
        segment["camera_repeat_gap"] = MIN_CAMERA_REPEAT_GAP
        # Give Qwen the selected rule as context, then append it again after
        # optimization so the final H3 prompt cannot silently drop it.
        prompt = append_director_guidance(
            f"表演模式：{performance_label}\n{original_prompt}",
            director_guidance,
        )
        if auto_optimize:
            try:
                QwenH3Prompt, DEFAULT_MODEL, DEFAULT_MMPROJ = resolve_qwen_h3()
                optimized = QwenH3Prompt.execute(
                    prompt=prompt,
                    skill=skill,
                    duration=duration,
                    llm_model=str(settings.get("llm_model") or DEFAULT_MODEL),
                    vision_model=str(settings.get("vision_model") or DEFAULT_MMPROJ),
                    think_mode=bool(settings.get("think_mode", False)),
                    reasoning_effort=str(settings.get("reasoning_effort") or "medium"),
                    seed=int(settings.get("seed") or 0),
                    max_tokens=int(settings.get("max_tokens") or 8192),
                    video_sample_frames_per_sec=int(settings.get("video_sample_frames_per_sec") or 2),
                    force_unload_model=bool(settings.get("force_unload_model", True)),
                    reference_images={f"reference_image_{i}": image for i, image in enumerate(images)},
                    reference_videos=None,
                )
                model_prompt = str(optimized.result[0]).strip()
                if model_prompt:
                    prompt = model_prompt
                    segment["optimization_engine"] = "qwen_local"
                else:
                    segment["optimization_engine"] = "direct"
            except Exception:
                # Optimization is optional. If the original Qwen node cannot
                # run, preserve the user's prompt verbatim instead of inventing
                # replacement guidance in the workbench.
                segment["optimization_engine"] = "direct"
        prompt = append_director_guidance(prompt, director_guidance)
        prompt = normalize_reference_tokens(prompt, len(images))
        if auto_optimize:
            segment["optimized_prompt"] = prompt
        state["segments"][index] = segment
        save_state(state)
        frames = max(5, round(duration * 24))
        frames += (5 - frames % 17) % 17
        result = MiniMaxH3ReferenceToVideo.execute(
            clip=clip,
            vae=vae,
            audio_vae=audio_vae,
            prompt=prompt,
            width=width,
            height=height,
            length=int(frames),
            ref_image_size=settings.get("reference_size", "max"),
            ref_images={f"ref_image_{i}": image for i, image in enumerate(images)},
            ref_videos={},
            ref_video_audios={},
            ref_audios={},
        )
        # Match the proven H3 workflow exactly: the selected audio is not a
        # loose reference. Encode it into the AV latent, freeze that audio
        # stream with a zero noise mask, and let the sampler generate video
        # against the preserved audio timing.
        video_latent = LTXVSeparateAVLatent.execute(result.result[1]).result[0]
        audio_latent = LTXVAudioVAEEncode.execute(reference_audio, audio_vae).result[0]
        audio_latent = dict(audio_latent)
        audio_latent["noise_mask"] = torch.zeros((1, 1, 64, 64), dtype=torch.float32)
        av_latent = LTXVConcatAVLatent.execute(video_latent, audio_latent).result[0]
        image_batch = make_image_batch(
            images,
            width,
            height,
        )
        before_prefix, after_prefix = video_filename_prefixes(settings, segment, index)
        return (result.result[0], av_latent, image_batch, reference_audio, before_prefix, after_prefix)


NODE_CLASS_MAPPINGS = {"XiantuDigitalHumanStudioV2": XiantuDigitalHumanStudioV2}
NODE_DISPLAY_NAME_MAPPINGS = {"XiantuDigitalHumanStudioV2": "闲兔｜数字人工作台 V2"}
