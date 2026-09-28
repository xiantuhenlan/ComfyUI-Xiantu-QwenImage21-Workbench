import hashlib
import json
import math
import os

import comfy.sd
import comfy.utils
import folder_paths


EMPTY_LORA_LABEL = "未找到 LoRA 文件"


def _lora_catalog():
    names = folder_paths.get_filename_list("loras")
    return names or [EMPTY_LORA_LABEL]


def _parse_stack(value):
    try:
        raw = json.loads(value or "[]")
    except (TypeError, json.JSONDecodeError) as error:
        raise ValueError("LoRA 清单不是有效 JSON。") from error
    if not isinstance(raw, list):
        raise ValueError("LoRA 清单必须是数组。")

    entries = []
    for index, item in enumerate(raw, start=1):
        if not isinstance(item, dict):
            raise ValueError(f"第 {index} 条 LoRA 配置格式无效。")
        if not bool(item.get("enabled", True)):
            continue
        name = str(item.get("name", "")).strip()
        if not name or name == EMPTY_LORA_LABEL:
            continue
        try:
            strength_model = float(item.get("strength_model", 1.0))
        except (TypeError, ValueError) as error:
            raise ValueError(f"第 {index} 条 LoRA 强度不是数字。") from error
        if not math.isfinite(strength_model):
            raise ValueError(f"第 {index} 条 LoRA 强度必须是有限数字。")
        if not -100.0 <= strength_model <= 100.0:
            raise ValueError(f"第 {index} 条 LoRA 强度必须在 -100 到 100 之间。")
        entries.append(
            {
                "name": name,
                "strength_model": strength_model,
                "note": str(item.get("note", "")).strip(),
            }
        )
    return entries


class XiantuLoraManager:
    """Apply an ordered list of LoRAs while keeping human-readable notes."""

    def __init__(self):
        self._loaded_loras = {}

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "lora_catalog": (_lora_catalog(),),
                "lora_stack": (
                    "STRING",
                    {"default": "[]", "multiline": False},
                ),
            }
        }

    RETURN_TYPES = ("MODEL", "STRING")
    RETURN_NAMES = ("model", "LoRA清单")
    FUNCTION = "apply_loras"
    CATEGORY = "闲兔/Qwen Image 2.1"
    DESCRIPTION = "按列表顺序向扩散模型加载多个 LoRA，可设置模型强度并保存用途备注。"

    def _load_lora(self, path):
        stat = os.stat(path)
        signature = (stat.st_mtime_ns, stat.st_size)
        cached = self._loaded_loras.get(path)
        if cached and cached[0] == signature:
            return cached[1], cached[2]
        lora, metadata = comfy.utils.load_torch_file(
            path, safe_load=True, return_metadata=True
        )
        self._loaded_loras[path] = (signature, lora, metadata)
        return lora, metadata

    def apply_loras(self, model, lora_catalog, lora_stack):
        del lora_catalog
        entries = _parse_stack(lora_stack)
        active_paths = set()
        summary = []
        for entry in entries:
            path = folder_paths.get_full_path_or_raise("loras", entry["name"])
            active_paths.add(path)
            if entry["strength_model"] != 0.0:
                lora, metadata = self._load_lora(path)
                model, _ = comfy.sd.load_lora_for_models(
                    model,
                    None,
                    lora,
                    entry["strength_model"],
                    0.0,
                    lora_metadata=metadata,
                )
            detail = f'{entry["name"]} | 强度 {entry["strength_model"]:g}'
            if entry["note"]:
                detail += f' | {entry["note"]}'
            summary.append(detail)

        self._loaded_loras = {
            path: cached
            for path, cached in self._loaded_loras.items()
            if path in active_paths
        }
        return model, "\n".join(summary)

    @classmethod
    def VALIDATE_INPUTS(cls, lora_stack, **_kwargs):
        try:
            for entry in _parse_stack(lora_stack):
                folder_paths.get_full_path_or_raise("loras", entry["name"])
        except (OSError, ValueError) as error:
            return str(error)
        return True

    @classmethod
    def IS_CHANGED(cls, lora_stack, **_kwargs):
        digest = hashlib.sha256(str(lora_stack).encode("utf-8"))
        try:
            for entry in _parse_stack(lora_stack):
                path = folder_paths.get_full_path_or_raise("loras", entry["name"])
                stat = os.stat(path)
                digest.update(path.encode("utf-8"))
                digest.update(str(stat.st_mtime_ns).encode("ascii"))
                digest.update(str(stat.st_size).encode("ascii"))
        except (OSError, ValueError):
            pass
        return digest.hexdigest()


NODE_CLASS_MAPPINGS = {"XiantuLoraManager": XiantuLoraManager}
NODE_DISPLAY_NAME_MAPPINGS = {"XiantuLoraManager": "闲兔 LoRA 管理器"}
