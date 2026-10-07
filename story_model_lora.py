import hashlib
import json
from pathlib import Path

import folder_paths


EMPTY_MODEL = "未检测到 GGUF 主模型"
EMPTY_LORA = "未检测到 llama LoRA"
MODEL_EXTENSIONS = {".gguf"}
LORA_EXTENSIONS = {".gguf", ".bin"}


def _relative_catalog(folder, extensions, empty_label):
    root = Path(folder)
    if not root.is_dir():
        return [empty_label]
    names = sorted(
        str(path.relative_to(root)).replace("\\", "/")
        for path in root.rglob("*")
        if path.is_file() and path.suffix.lower() in extensions
    )
    return names or [empty_label]


def story_model_root():
    return Path(folder_paths.models_dir) / "llm"


def story_lora_root():
    return Path(folder_paths.models_dir) / "llm_loras"


def _model_catalog():
    return _relative_catalog(story_model_root(), MODEL_EXTENSIONS, EMPTY_MODEL)


def _resolve_model_path(model_name):
    root = story_model_root().resolve()
    requested = Path(str(model_name or "").strip())
    direct = (root / requested).resolve()
    try:
        direct.relative_to(root)
    except ValueError as error:
        raise ValueError("故事主模型必须放在 ComfyUI/models/llm 目录内。") from error
    if direct.is_file() and direct.suffix.lower() == ".gguf":
        return direct
    matches = [
        path.resolve()
        for path in root.rglob(requested.name)
        if path.is_file() and path.suffix.lower() in MODEL_EXTENSIONS
    ]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        choices = "、".join(str(path.relative_to(root)).replace("\\", "/") for path in matches[:8])
        raise ValueError(f"检测到多个同名 GGUF，请在外置模型节点选择完整相对路径：{choices}")
    available = sorted(
        (
            path.resolve()
            for path in root.rglob("*")
            if path.is_file() and path.suffix.lower() in MODEL_EXTENSIONS
        ),
        key=lambda path: str(path.relative_to(root)).lower(),
    ) if root.is_dir() else []
    if available:
        return available[0]
    raise ValueError("ComfyUI/models/llm 中没有可用的 GGUF 模型。")


def _lora_catalog():
    return _relative_catalog(story_lora_root(), LORA_EXTENSIONS, EMPTY_LORA)


def _safe_child(root, relative_name, label):
    root = root.resolve()
    path = (root / str(relative_name or "")).resolve()
    try:
        path.relative_to(root)
    except ValueError as error:
        raise ValueError(f"{label}路径超出允许目录。") from error
    if not path.is_file():
        raise ValueError(f"找不到{label}：{relative_name}")
    return path


def parse_lora_stack(value):
    if isinstance(value, list):
        raw = value
    else:
        try:
            raw = json.loads(str(value or "[]"))
        except json.JSONDecodeError as error:
            raise ValueError("故事 LoRA 配置不是有效 JSON。") from error
    if not isinstance(raw, list):
        raise ValueError("故事 LoRA 配置必须是列表。")
    result = []
    for index, item in enumerate(raw[:32], start=1):
        if not isinstance(item, dict) or not item.get("enabled", True):
            continue
        name = str(item.get("name") or "").strip()
        if not name or name == EMPTY_LORA:
            continue
        strength = float(item.get("strength", 1.0))
        if not -4.0 <= strength <= 4.0:
            raise ValueError(f"第 {index} 个故事 LoRA 强度必须在 -4 到 4 之间。")
        result.append(
            {
                "name": name,
                "strength": strength,
                "note": str(item.get("note") or "").strip()[:500],
            }
        )
    return result


def resolve_story_model_config(config):
    if isinstance(config, str):
        try:
            config = json.loads(config)
        except json.JSONDecodeError as error:
            raise ValueError("故事模型接口配置不是有效 JSON。") from error
    if not isinstance(config, dict):
        raise ValueError("故事模型接口没有提供有效配置。")
    requested_model_name = str(config.get("model_name") or "").strip()
    model_path = _resolve_model_path(requested_model_name)
    model_name = str(model_path.relative_to(story_model_root().resolve())).replace("\\", "/")
    loras = []
    for item in parse_lora_stack(config.get("loras", config.get("lora_stack", []))):
        loras.append({**item, "path": str(_safe_child(story_lora_root(), item["name"], "故事 LoRA"))})
    return {
        "model_name": model_name,
        "model_path": str(model_path),
        "context_length": max(4096, min(131072, int(config.get("context_length") or 32768))),
        "gpu_layers": max(0, min(999, int(config.get("gpu_layers") or 99))),
        "loras": loras,
    }


class XiantuStoryModelLora:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model_name": (_model_catalog(),),
                "context_length": (
                    "INT",
                    {"default": 32768, "min": 4096, "max": 131072, "step": 1024},
                ),
                "gpu_layers": (
                    "INT",
                    {"default": 99, "min": 0, "max": 999, "step": 1},
                ),
                "lora_catalog": (_lora_catalog(),),
                "lora_stack": (
                    "STRING",
                    {"default": "[]", "multiline": False},
                ),
            }
        }

    RETURN_TYPES = ("STORY_MODEL_CONFIG",)
    RETURN_NAMES = ("模型接口",)
    FUNCTION = "build_config"
    CATEGORY = "闲兔/故事分镜"
    DESCRIPTION = "为故事分镜导演台提供外置 GGUF 主模型和 llama.cpp LoRA Adapter。"

    def build_config(
        self,
        model_name,
        context_length,
        gpu_layers,
        lora_catalog,
        lora_stack,
    ):
        del lora_catalog
        config = {
            "model_name": model_name,
            "context_length": context_length,
            "gpu_layers": gpu_layers,
            "loras": parse_lora_stack(lora_stack),
        }
        resolve_story_model_config(config)
        return (config,)

    @classmethod
    def VALIDATE_INPUTS(cls, model_name, lora_stack, **_kwargs):
        try:
            resolve_story_model_config(
                {"model_name": model_name, "loras": parse_lora_stack(lora_stack)}
            )
        except ValueError as error:
            return str(error)
        return True

    @classmethod
    def IS_CHANGED(cls, model_name, context_length, gpu_layers, lora_stack, **_kwargs):
        digest = hashlib.sha256()
        digest.update(str(model_name).encode("utf-8"))
        digest.update(str(context_length).encode("utf-8"))
        digest.update(str(gpu_layers).encode("utf-8"))
        digest.update(str(lora_stack).encode("utf-8"))
        return digest.hexdigest()


NODE_CLASS_MAPPINGS = {"XiantuStoryModelLora": XiantuStoryModelLora}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiantuStoryModelLora": "闲兔｜故事模型与 LoRA",
}
