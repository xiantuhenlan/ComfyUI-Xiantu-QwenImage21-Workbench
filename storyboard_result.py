import json
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path

import folder_paths
from aiohttp import web
from nodes import SaveImage
from server import PromptServer


_INDEX_LOCK = threading.Lock()
_OUTPUT_FOLDER = "xiantu_storyboard"


def _safe_segment(value, fallback):
    text = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff._-]+", "_", str(value or "").strip())
    return text.strip("._-")[:80] or fallback


def _index_path():
    return Path(folder_paths.get_output_directory()) / _OUTPUT_FOLDER / "results.json"


def _load_index():
    path = _index_path()
    if not path.exists():
        return {"version": 1, "shots": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"version": 1, "shots": {}}
    if not isinstance(data, dict) or not isinstance(data.get("shots"), dict):
        return {"version": 1, "shots": {}}
    return data


def _save_record(record):
    path = _index_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with _INDEX_LOCK:
        data = _load_index()
        existing = data["shots"].get(record["shot_id"], {})
        merged = dict(existing) if isinstance(existing, dict) else {}
        merged.update(record)
        task_id = str(record.get("image_task_id") or "").strip()
        if task_id:
            image_tasks = dict(existing.get("image_tasks") or {}) if isinstance(existing, dict) else {}
            image_tasks[task_id] = record
            merged["image_tasks"] = image_tasks
        if "images" not in record and isinstance(existing, dict):
            merged["images"] = existing.get("images", [])
        if "video_file" not in record and isinstance(existing, dict):
            merged["video_file"] = existing.get("video_file", "")
        data["shots"][record["shot_id"]] = merged
        temporary = path.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        os.replace(temporary, path)
        return merged


def _parse_shot(value, channel):
    try:
        shot = json.loads(str(value or ""))
    except json.JSONDecodeError as error:
        raise ValueError(f"{channel}分镜数据无效。") from error
    if not isinstance(shot, dict):
        raise ValueError(f"{channel}分镜必须是当前分镜对象。")
    shot_id = str(shot.get("id") or "").strip()
    if not shot_id:
        raise ValueError(f"{channel}分镜缺少 shot_id。")
    return shot


class XiantuStoryboardResult:
    """双通道传递图片/视频分镜，并按 shot_id 将结果回填导演台。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                "资产分镜": (
                    "STRING",
                    {"forceInput": True, "tooltip": "连接故事分镜导演台的“资产分镜”输出。"},
                ),
                "图片结果": ("IMAGE",),
                "视频分镜": (
                    "STRING",
                    {"forceInput": True, "tooltip": "连接故事分镜导演台的“视频分镜”输出。"},
                ),
                "视频帧": ("IMAGE",),
                "视频文件名": (
                    "STRING",
                    {"forceInput": True, "tooltip": "连接 V3 导演台的“视频文件名”输出。"},
                ),
            }
        }

    RETURN_TYPES = ("STRING", "STRING", "IMAGE", "IMAGE", "STRING", "STRING")
    RETURN_NAMES = (
        "资产分镜",
        "视频分镜",
        "图片结果",
        "视频帧",
        "视频文件名",
        "中转记录",
    )
    FUNCTION = "collect"
    CATEGORY = "闲兔/故事分镜"
    OUTPUT_NODE = True
    DESCRIPTION = "中转图片和视频分镜，并将生成结果按分镜 ID 回填导演台。"

    def collect(
        self,
        资产分镜="",
        图片结果=None,
        视频分镜="",
        视频帧=None,
        视频文件名="",
    ):
        asset_shot = _parse_shot(资产分镜, "资产") if str(资产分镜 or "").strip() else None
        video_shot = _parse_shot(视频分镜, "视频") if str(视频分镜 or "").strip() else None
        shot = video_shot or asset_shot
        if shot is None:
            raise ValueError("请连接导演台的“资产分镜”或“视频分镜”输出。")
        shot_id = str(shot["id"])
        asset_id = str(shot.get("asset_id") or "").strip()
        asset_kind = str(shot.get("asset_kind") or "").strip()
        active_task = shot.get("active_image_task") if isinstance(shot.get("active_image_task"), dict) else {}
        image_task_id = str(active_task.get("task_id") or "").strip()
        image_slot = str(active_task.get("slot") or "").strip()
        project = shot.get("project") if isinstance(shot.get("project"), dict) else {}
        project_name = str(project.get("title") or "未命名故事")
        image_records = []
        if 图片结果 is not None:
            prefix = "/".join(
                (
                    _OUTPUT_FOLDER,
                    _safe_segment(project_name, "project"),
                    _safe_segment(asset_id or shot_id, "asset" if asset_id else "shot"),
                    _safe_segment(image_slot or image_task_id, "image_task"),
                    "image",
                )
            )
            saved = SaveImage().save_images(图片结果, filename_prefix=prefix)
            image_records = list(saved.get("ui", {}).get("images", []))
        record = {
            "shot_id": shot_id,
            "shot_title": str(shot.get("title") or shot_id),
            "project": project_name,
            "image_task_id": image_task_id,
            "slot": image_slot,
            "asset_refs": active_task.get("asset_refs") if isinstance(active_task.get("asset_refs"), list) else [],
            "created_at": datetime.now(timezone.utc).isoformat(),
            "kind": "mixed" if 图片结果 is not None and (视频帧 is not None or str(视频文件名 or "").strip()) else "video" if video_shot else "image",
        }
        if asset_id:
            record["asset_id"] = asset_id
            record["asset_kind"] = asset_kind
        if 图片结果 is not None:
            record["images"] = image_records
        if str(视频文件名 or "").strip():
            record["video_file"] = str(视频文件名).strip()
        record = _save_record(record)
        prompt_server = getattr(PromptServer, "instance", None)
        if prompt_server is not None:
            prompt_server.send_sync("xiantu-storyboard-result", record)
        result_json = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
        return {
            "ui": {"images": image_records},
            "result": (
                str(资产分镜 or ""),
                str(视频分镜 or ""),
                图片结果,
                视频帧,
                str(视频文件名 or ""),
                result_json,
            ),
        }


async def _storyboard_results(_request):
    return web.json_response(_load_index())


def _register_routes():
    prompt_server = getattr(PromptServer, "instance", None)
    if prompt_server is not None:
        prompt_server.routes.get("/xiantu/storyboard/results")(_storyboard_results)


_register_routes()


NODE_CLASS_MAPPINGS = {"XiantuStoryboardResult": XiantuStoryboardResult}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiantuStoryboardResult": "闲兔｜分镜中转器",
}
