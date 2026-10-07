import asyncio
import atexit
import json
import re
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path

from aiohttp import web
import folder_paths
from server import PromptServer

from .storyboard import XiantuStoryboardDirector
from .story_model_lora import resolve_story_model_config


MAX_STORY_CHARS = 200_000
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
_EXTERNAL_SERVER_LOCK = threading.Lock()
_EXTERNAL_STORY_JOB_LOCK = asyncio.Lock()
_EXTERNAL_SERVER_PROCESS = None
_EXTERNAL_SERVER_SIGNATURE = ""
_EXTERNAL_SERVER_URL = ""


SYSTEM_PROMPT = """
你是专业的电影分镜导演和AI影像制片人。请把用户提供的故事自动拆分为可执行的连续分镜。
你必须只输出一个 JSON 对象，不要使用 Markdown，不要解释。JSON 结构：
{
  "project": {
    "title": "故事名称",
    "visual_style": "统一视觉风格",
    "global_positive": "所有镜头继承的正向要求",
    "global_negative": "所有镜头继承的负向要求",
    "continuity": "角色、服装、道具、时间和空间连续性规则"
  },
  "shots": [
    {
      "id": "shot-001",
      "title": "分镜标题",
      "scene": "场次",
      "media_type": "图片关键帧或视频镜头",
      "duration": 3,
      "shot_size": "景别",
      "camera_angle": "机位",
      "camera_movement": "运镜",
      "characters": "出场角色及服装状态",
      "location": "场景、时间和天气",
      "action": "人物动作、表情、站位和画面调度",
      "dialogue": "对白或旁白",
      "positive": "可直接用于生图或生视频的详细提示词",
      "negative": "该镜头的负向提示词",
      "notes": "与上一镜的连续性、建议参考素材和制作注意事项",
      "selected": false,
      "assets": []
    }
  ]
}
要求：镜头必须覆盖完整剧情，景别和机位有变化，动作可执行，相邻镜头保持轴线、角色身份、服装、道具和场景连续。
""".strip()


def _chat_url(base_url):
    value = str(base_url or "").strip().rstrip("/")
    if not value:
        raise ValueError("请填写语言模型接口地址。")
    if value.endswith("/chat/completions"):
        return value
    if value.endswith("/v1"):
        return f"{value}/chat/completions"
    return f"{value}/v1/chat/completions"


def _extract_json(content):
    text = str(content or "").strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines:
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("语言模型未返回可识别的分镜 JSON。")
    candidate = re.sub(r",\s*([}\]])", r"\1", text[start : end + 1])
    last_error = None
    for _attempt in range(4096):
        try:
            return json.loads(candidate)
        except json.JSONDecodeError as error:
            last_error = error
            position = max(0, min(len(candidate), error.pos))
            before = position - 1
            while before >= 0 and candidate[before].isspace():
                before -= 1
            current = candidate[position] if position < len(candidate) else ""
            previous = candidate[before] if before >= 0 else ""
            if current in "{[\"" and previous in "}]\"0123456789eElL":
                candidate = candidate[:position] + "," + candidate[position:]
                continue
            break
    if last_error is not None:
        raise ValueError(
            f"语言模型返回的分镜 JSON 无效：{last_error.msg}，"
            f"第 {last_error.lineno} 行第 {last_error.colno} 列"
        ) from last_error
    raise ValueError("语言模型返回的分镜 JSON 无效。")


def _toolkit_api_module():
    for module in tuple(sys.modules.values()):
        if module is None:
            continue
        call_local = getattr(module, "_call_storyboard_local", None)
        system_prompt = getattr(module, "_storyboard_system_prompt", None)
        if callable(call_local) and callable(system_prompt):
            return module
    raise ValueError("闲兔本地语言组件尚未加载，请重启 ComfyUI。")


def _story_runtime_executable():
    custom_nodes = Path(folder_paths.base_path) / "custom_nodes"
    candidates = [
        custom_nodes / "XiantuAIToolkit" / "runtime" / "llama.cpp" / "vulkan" / "llama-server.exe",
        custom_nodes / "XiantuAIToolkit" / "runtime" / "llama.cpp" / "cuda" / "llama-server.exe",
        custom_nodes / "XiantuAIToolkit" / "runtime" / "llama.cpp" / "llama-server.exe",
    ]
    for path in candidates:
        if path.is_file():
            return path
    matches = list((custom_nodes / "XiantuAIToolkit" / "runtime").rglob("llama-server.exe"))
    if matches:
        return matches[0]
    raise ValueError("未找到闲兔本地语言组件的 llama-server.exe。")


def _free_local_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
        server.bind(("127.0.0.1", 0))
        return int(server.getsockname()[1])


def _server_healthy(base_url, timeout=1.0):
    try:
        with urllib.request.urlopen(f"{base_url}/health", timeout=timeout) as response:
            return 200 <= response.status < 500
    except Exception:
        return False


def _story_log(level, message):
    print(f"[{level}] [闲兔故事分镜] {message}", file=sys.stderr, flush=True)


def _effective_shot_count(story, requested):
    try:
        requested_count = int(requested or 0)
    except (TypeError, ValueError):
        requested_count = 0
    if requested_count > 0:
        return max(1, min(500, requested_count)), False
    story_units = len(re.sub(r"\s+", "", story))
    return max(3, min(120, round(story_units / 120))), True


def _story_bible_response_format():
    def text_field(max_length):
        return {"type": "string", "maxLength": max_length}

    character_properties = {
        "id": text_field(32),
        "name": text_field(80),
        "role": text_field(120),
        "appearance": text_field(500),
        "wardrobe": text_field(400),
        "fixed_props": {"type": "array", "maxItems": 12, "items": text_field(100)},
        "reference_needs": {"type": "array", "maxItems": 8, "items": text_field(100)},
    }
    scene_properties = {
        "id": text_field(32),
        "name": text_field(100),
        "time": text_field(80),
        "weather_environment": text_field(240),
        "spatial_structure": text_field(400),
        "fixed_visuals": text_field(400),
        "reference_needs": {"type": "array", "maxItems": 8, "items": text_field(100)},
    }
    prop_properties = {
        "id": text_field(32),
        "name": text_field(100),
        "category": text_field(80),
        "appearance": text_field(400),
        "owner_character_id": text_field(32),
        "reference_needs": {"type": "array", "maxItems": 8, "items": text_field(100)},
    }
    beat_properties = {
        "id": text_field(32),
        "source_text": text_field(700),
        "scene_id": text_field(32),
        "character_ids": {"type": "array", "maxItems": 12, "items": text_field(32)},
        "prop_ids": {"type": "array", "maxItems": 12, "items": text_field(32)},
        "action": text_field(400),
        "dialogue": text_field(400),
        "importance": {"type": "string", "enum": ["核心", "重要", "过渡"]},
    }
    schema = {
        "type": "object",
        "properties": {
            "project": {
                "type": "object",
                "properties": {
                    "title": text_field(120),
                    "visual_style": text_field(300),
                    "global_positive": text_field(600),
                    "global_negative": text_field(400),
                    "continuity": text_field(600),
                },
                "required": ["title", "visual_style", "global_positive", "global_negative", "continuity"],
                "additionalProperties": False,
            },
            "characters": {
                "type": "array", "minItems": 1, "maxItems": 40,
                "items": {"type": "object", "properties": character_properties, "required": list(character_properties), "additionalProperties": False},
            },
            "scenes": {
                "type": "array", "minItems": 1, "maxItems": 80,
                "items": {"type": "object", "properties": scene_properties, "required": list(scene_properties), "additionalProperties": False},
            },
            "props": {
                "type": "array", "maxItems": 80,
                "items": {"type": "object", "properties": prop_properties, "required": list(prop_properties), "additionalProperties": False},
            },
            "story_beats": {
                "type": "array", "minItems": 1, "maxItems": 500,
                "items": {"type": "object", "properties": beat_properties, "required": list(beat_properties), "additionalProperties": False},
            },
        },
        "required": ["project", "characters", "scenes", "props", "story_beats"],
        "additionalProperties": False,
    }
    return {"type": "json_schema", "json_schema": {"name": "story_bible", "strict": True, "schema": schema}}


def _storyboard_response_format(shot_count, max_seconds):
    def text_field(max_length):
        return {"type": "string", "maxLength": max_length}

    shot_properties = {
        "shot_id": text_field(32),
        "title": text_field(80),
        "group_id": text_field(32),
        "duration": {"type": "integer", "minimum": 1, "maximum": max_seconds},
        "shot_type": text_field(24),
        "camera_angle": text_field(24),
        "technique": text_field(40),
        "source_beat_ids": {
            "type": "array", "minItems": 1, "maxItems": 12, "items": text_field(32)
        },
        "protagonist_refs": {
            "type": "array", "maxItems": 8, "items": text_field(60)
        },
        "supporting_refs": {
            "type": "array", "maxItems": 12, "items": text_field(60)
        },
        "prop_refs": {
            "type": "array", "maxItems": 12, "items": text_field(32)
        },
        "scene_ref": text_field(160),
        "opening_state": text_field(240),
        "action_progression": text_field(320),
        "ending_state": text_field(240),
        "story_beat": text_field(240),
        "dialogue": text_field(400),
        "image_prompt_engine": {"type": "string", "enum": ["Qwen Image 2.1", "KR"]},
        "image_generation_mode": {"type": "string", "enum": ["文生图", "图片编辑"]},
        "video_generation_mode": {
            "type": "string",
            "enum": ["图生视频", "首尾帧", "多参考图", "文生视频", "参考视频", "视频延长"],
        },
        "video_generation_reason": text_field(240),
        "reference_requirements": {
            "type": "array", "maxItems": 12, "items": text_field(120)
        },
        "first_frame_asset_refs": {
            "type": "array", "maxItems": 12, "items": text_field(32)
        },
        "last_frame_asset_refs": {
            "type": "array", "maxItems": 12, "items": text_field(32)
        },
        "multi_reference_asset_refs": {
            "type": "array", "maxItems": 16, "items": text_field(32)
        },
        "first_frame_prompt": text_field(700),
        "last_frame_prompt": text_field(700),
        "image_prompt": text_field(900),
        "video_prompt": text_field(1000),
        "negative_prompt": text_field(400),
        "continuity": text_field(400),
    }
    schema = {
        "type": "object",
        "properties": {
            "project": {
                "type": "object",
                "properties": {
                    "title": text_field(120),
                    "visual_style": text_field(300),
                    "default_shot_duration": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": max_seconds,
                    },
                },
                "required": ["title", "visual_style", "default_shot_duration"],
                "additionalProperties": False,
            },
            "shots": {
                "type": "array",
                "minItems": shot_count,
                "maxItems": shot_count,
                "items": {
                    "type": "object",
                    "properties": shot_properties,
                    "required": list(shot_properties),
                    "additionalProperties": False,
                },
            },
        },
        "required": ["project", "shots"],
        "additionalProperties": False,
    }
    return {
        "type": "json_schema",
        "json_schema": {"name": "storyboard", "strict": True, "schema": schema},
    }


def _output_token_budget(config, shot_count):
    context_limit = max(8192, int(config.get("context_length") or 32768))
    return min(24000, max(6000, shot_count * 1000), max(2048, context_limit - 5000))


def _balance_uniform_durations(board, max_seconds):
    shots = board.get("shots") if isinstance(board, dict) else None
    if not isinstance(shots, list) or len(shots) < 4 or max_seconds < 2:
        return board
    durations = {
        max(1, min(max_seconds, int(shot.get("duration") or max_seconds)))
        for shot in shots
        if isinstance(shot, dict)
    }
    if len(durations) > 1:
        return board
    for index, shot in enumerate(shots):
        if not isinstance(shot, dict):
            continue
        shot_type = str(shot.get("shot_type") or "")
        dialogue = re.sub(r"\s+", "", str(shot.get("dialogue") or ""))
        action = "".join(
            str(shot.get(name) or "")
            for name in ("opening_state", "action_progression", "ending_state", "story_beat")
        )
        if dialogue:
            seconds = max(2, (len(dialogue) + 4) // 5 + 1)
        elif any(name in shot_type for name in ("远景", "全景")):
            seconds = 4
        elif any(name in shot_type for name in ("特写", "大特写")):
            seconds = 3
        elif len(action) >= 160:
            seconds = 4
        else:
            seconds = 2 + (index % 2)
        shot["duration"] = max(1, min(max_seconds, seconds))
    return board


def _unique_texts(values):
    result = []
    for value in values:
        text = str(value or "").strip()
        if text and text not in result:
            result.append(text)
    return result


def _asset_image_prompt(asset, kind, project, image_model="Qwen Image 2.1"):
    style = str((project or {}).get("visual_style") or "电影感写实").strip()
    global_positive = str((project or {}).get("global_positive") or "").strip()
    name = str(asset.get("name") or asset.get("id") or "未命名资产").strip()
    if kind == "character":
        fixed_props = "、".join(str(item) for item in (asset.get("fixed_props") or []) if item)
        details = _unique_texts((
            asset.get("role"), asset.get("appearance"), asset.get("wardrobe"),
            f"固定道具：{fixed_props}" if fixed_props else "",
        ))
        subject = f"角色资产设定图，{name}，" + "，".join(details)
        framing = "单人全身，正面站姿，人物完整入镜，身份特征、服装、发型和固定道具清晰稳定，干净中性背景，无其他人物"
    elif kind == "scene":
        details = _unique_texts((
            asset.get("time"), asset.get("weather_environment"),
            asset.get("spatial_structure"), asset.get("fixed_visuals"),
        ))
        subject = f"场景资产设定图，{name}，" + "，".join(details)
        framing = "宽幅建立镜头，空间结构、入口、道路、主要建筑和固定陈设清晰，无人物，便于后续镜头保持场景一致"
    else:
        details = _unique_texts((
            asset.get("category"), asset.get("appearance"),
            f"所属角色编号：{asset.get('owner_character_id')}" if asset.get("owner_character_id") else "",
        ))
        subject = f"道具资产设定图，{name}，" + "，".join(details)
        framing = "单个道具居中完整展示，三分之四视角，形状、材质、颜色、比例、磨损和标志细节清楚，干净中性背景，无人物"
    if "qwen" in str(image_model).lower():
        model_rule = "使用完整自然语言明确描述主体、空间关系、光线、构图与材质，不使用标签堆砌"
    else:
        model_rule = "使用清晰具体的自然语言描述内容与视觉效果，以稳定身份、构图、媒介、光线和色彩减少随机变化"
    return "。".join(_unique_texts((subject, framing, style, global_positive, model_rule))) + "。"


def _video_prompt_for(shot, video_model):
    parts = _unique_texts((
        shot.get("opening_state"), shot.get("action_progression"), shot.get("ending_state"),
        shot.get("camera") or shot.get("technique"), shot.get("dialogue"), shot.get("sound"),
    ))
    content = "；".join(parts)
    model = str(video_model or "MiniMax H3")
    if "H3" in model.upper():
        return f"MiniMax H3 导演描述：{content}。保持角色身份、服装、道具、场景空间和动作连续，明确主体表演、运镜与起止状态。"
    if "WAN" in model.upper():
        return f"Wan 2.2 视频提示词：{content}。主体、环境、动作进程、运镜、光线、风格与时间连续性清晰，运动符合物理规律。"
    if "SEEDANCE" in model.upper():
        return f"Seedance 2.0 导演提示词：{content}。明确镜头语言、主体表演、运镜、节奏、空间连续性和起止变化。"
    return f"{model} 视频提示词：{content}。保持主体、场景和时间连续。"


def _apply_video_mode_policy(shot, strategy="首尾帧+多参生视频", video_model="MiniMax H3"):
    refs = _unique_texts(
        list(shot.get("protagonist_refs") or [])
        + list(shot.get("supporting_refs") or [])
        + list(shot.get("prop_refs") or [])
        + ([shot.get("scene_ref")] if shot.get("scene_ref") else [])
    )
    normalized_strategy = str(strategy or "首尾帧+多参生视频").replace("＋", "+")
    if not refs:
        mode = "文生视频"
        reason = "镜头没有可用参考资产，回退为文生视频。"
    elif "多参" in normalized_strategy and "首尾" not in normalized_strategy:
        mode = "多参考图"
        shot["multi_reference_asset_refs"] = refs[:16]
        reason = "项目指定多参生视频，使用角色、场景和道具资产保持一致性。"
    elif "首尾" in normalized_strategy and "多参" not in normalized_strategy:
        mode = "首尾帧"
        shot["first_frame_asset_refs"] = refs[:12]
        shot["last_frame_asset_refs"] = refs[:12]
        shot["first_frame_prompt"] = str(shot.get("first_frame_prompt") or shot.get("opening_state") or shot.get("image_prompt") or "").strip()
        shot["last_frame_prompt"] = str(shot.get("last_frame_prompt") or shot.get("ending_state") or shot.get("image_prompt") or "").strip()
        reason = "项目指定首尾帧，使用起止画面约束动作与运镜。"
    elif len(refs) >= 2:
        mode = "多参考图"
        shot["multi_reference_asset_refs"] = refs[:16]
        reason = "混合策略下镜头包含多个资产，使用多参考图保持身份与场景一致。"
    else:
        mode = "首尾帧"
        shot["first_frame_asset_refs"] = refs[:12]
        shot["last_frame_asset_refs"] = refs[:12]
        shot["first_frame_prompt"] = str(shot.get("first_frame_prompt") or shot.get("opening_state") or shot.get("image_prompt") or "").strip()
        shot["last_frame_prompt"] = str(shot.get("last_frame_prompt") or shot.get("ending_state") or shot.get("image_prompt") or "").strip()
        reason = "混合策略下镜头只有一个核心资产，使用首尾帧约束动作变化。"
    shot["video_generation_mode"] = mode
    shot["video_generation_reason"] = reason
    shot["video_prompt"] = _video_prompt_for(shot, video_model)
    return shot


def _apply_board_generation_settings(board, payload):
    if not isinstance(board, dict):
        return board
    project = board.get("project") if isinstance(board.get("project"), dict) else {}
    image_model = str(payload.get("image_prompt_engine") or payload.get("image_model") or "Qwen Image 2.1")
    video_model = str(payload.get("video_model") or "MiniMax H3")
    strategy = str(payload.get("video_generation_strategy") or "首尾帧+多参生视频")
    nested_assets = board.get("assets") if isinstance(board.get("assets"), dict) else {}
    for key, kind in (("characters", "character"), ("scenes", "scene"), ("props", "prop")):
        assets = board.get(key) if isinstance(board.get(key), list) else nested_assets.get(key, [])
        for asset in assets if isinstance(assets, list) else []:
            if not isinstance(asset, dict):
                continue
            if not asset.get("id") and asset.get("asset_id"):
                asset["id"] = str(asset["asset_id"])
            asset["selected"] = bool(asset.get("selected", False))
            asset["images"] = asset.get("images") if isinstance(asset.get("images"), list) else []
            asset["image_prompt"] = _asset_image_prompt(asset, kind, project, image_model)
            asset["image_prompt_engine"] = image_model
    for shot in board.get("shots", []) if isinstance(board.get("shots"), list) else []:
        if isinstance(shot, dict):
            shot["image_prompt_engine"] = image_model
            shot["video_model"] = video_model
            _apply_video_mode_policy(shot, strategy, video_model)
    board["generation_settings"] = {
        "image_model": image_model,
        "video_model": video_model,
        "video_generation_strategy": strategy,
    }
    return board


def _external_chat(base_url, config, messages, response_format, max_tokens, temperature=0.2):
    body = {
        "model": config["model_name"],
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "response_format": response_format,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    request = urllib.request.Request(
        f"{base_url}/v1/chat/completions",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=900) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        detail = error.read(4096).decode("utf-8", "replace")
        raise ValueError(f"故事模型请求失败（HTTP {error.code}）：{detail}") from error
    except urllib.error.URLError as error:
        raise ValueError(f"无法连接故事模型：{error.reason}") from error
    if len(raw) > MAX_RESPONSE_BYTES:
        raise ValueError("故事模型返回内容超过 4 MiB。")
    try:
        response_data = json.loads(raw.decode("utf-8"))
        return response_data["choices"][0]["message"]["content"]
    except (UnicodeDecodeError, json.JSONDecodeError, KeyError, IndexError, TypeError) as error:
        raise ValueError("故事模型返回格式不兼容 OpenAI Chat Completions。") from error


def _enrich_storyboard(
    board,
    bible,
    max_seconds,
    image_model="Qwen Image 2.1",
    video_model="MiniMax H3",
    video_strategy="首尾帧+多参生视频",
):
    board["project"] = bible.get("project") or board.get("project") or {}
    for key in ("characters", "scenes", "props", "story_beats"):
        board[key] = bible.get(key) if isinstance(bible.get(key), list) else []
    for key, kind in (("characters", "character"), ("scenes", "scene"), ("props", "prop")):
        for asset in board[key]:
            if not isinstance(asset, dict):
                continue
            asset["selected"] = bool(asset.get("selected", False))
            asset["images"] = asset.get("images") if isinstance(asset.get("images"), list) else []
            asset["image_prompt"] = _asset_image_prompt(asset, kind, board["project"], image_model)
            asset["image_prompt_engine"] = image_model
    shots = board.get("shots") if isinstance(board.get("shots"), list) else []
    valid_ids = {
        "characters": {str(item.get("id")) for item in board["characters"] if isinstance(item, dict)},
        "scenes": {str(item.get("id")) for item in board["scenes"] if isinstance(item, dict)},
        "props": {str(item.get("id")) for item in board["props"] if isinstance(item, dict)},
        "beats": {str(item.get("id")) for item in board["story_beats"] if isinstance(item, dict)},
    }
    used_beats = set()
    invalid_refs = []
    for asset in board["characters"] + board["scenes"] + board["props"]:
        if isinstance(asset, dict):
            asset["usage_shots"] = []
    assets_by_id = {
        str(asset.get("id")): asset
        for asset in board["characters"] + board["scenes"] + board["props"]
        if isinstance(asset, dict) and asset.get("id")
    }
    for index, shot in enumerate(shots):
        if not isinstance(shot, dict):
            continue
        shot_id = str(shot.get("shot_id") or f"SH{index + 1:03d}")
        shot["shot_id"] = shot_id
        shot["duration"] = max(1, min(max_seconds, int(shot.get("duration") or 1)))
        refs = []
        for field, valid_group in (
            ("protagonist_refs", "characters"),
            ("supporting_refs", "characters"),
            ("prop_refs", "props"),
        ):
            values = shot.get(field) if isinstance(shot.get(field), list) else []
            shot[field] = [str(value) for value in values]
            refs.extend(shot[field])
            invalid_refs.extend(
                f"{shot_id}:{value}" for value in shot[field] if value not in valid_ids[valid_group]
            )
        scene_ref = str(shot.get("scene_ref") or "")
        if scene_ref:
            refs.append(scene_ref)
            if scene_ref not in valid_ids["scenes"]:
                invalid_refs.append(f"{shot_id}:{scene_ref}")
        all_asset_ids = valid_ids["characters"] | valid_ids["scenes"] | valid_ids["props"]
        for field in (
            "first_frame_asset_refs",
            "last_frame_asset_refs",
            "multi_reference_asset_refs",
        ):
            values = [str(value) for value in (shot.get(field) or [])]
            shot[field] = values
            invalid_refs.extend(f"{shot_id}:{value}" for value in values if value not in all_asset_ids)
        beat_ids = [str(value) for value in (shot.get("source_beat_ids") or [])]
        shot["source_beat_ids"] = beat_ids
        used_beats.update(value for value in beat_ids if value in valid_ids["beats"])
        invalid_refs.extend(f"{shot_id}:{value}" for value in beat_ids if value not in valid_ids["beats"])
        for ref in refs:
            if ref in assets_by_id:
                assets_by_id[ref]["usage_shots"].append(shot_id)
        shot["image_prompt_engine"] = image_model
        _apply_video_mode_policy(shot, video_strategy, video_model)
    missing_beats = sorted(valid_ids["beats"] - used_beats)
    total_beats = len(valid_ids["beats"])
    board["validation"] = {
        "source_coverage": round(len(used_beats) / total_beats, 4) if total_beats else 1.0,
        "covered_beats": len(used_beats),
        "total_beats": total_beats,
        "uncovered_beat_ids": missing_beats,
        "invalid_refs": sorted(set(invalid_refs)),
    }
    board["story_bible"] = {
        "continuity_rules": [str(board["project"].get("continuity") or "")]
    }
    return _balance_uniform_durations(board, max_seconds)


def _stop_external_story_server():
    global _EXTERNAL_SERVER_PROCESS, _EXTERNAL_SERVER_SIGNATURE, _EXTERNAL_SERVER_URL
    process = _EXTERNAL_SERVER_PROCESS
    _EXTERNAL_SERVER_PROCESS = None
    _EXTERNAL_SERVER_SIGNATURE = ""
    _EXTERNAL_SERVER_URL = ""
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=8)
    except subprocess.TimeoutExpired:
        process.kill()


atexit.register(_stop_external_story_server)


def _ensure_external_story_server(raw_config):
    global _EXTERNAL_SERVER_PROCESS, _EXTERNAL_SERVER_SIGNATURE, _EXTERNAL_SERVER_URL
    config = resolve_story_model_config(raw_config)
    signature = json.dumps(
        {
            "model_path": config["model_path"],
            "context_length": config["context_length"],
            "gpu_layers": config["gpu_layers"],
            "loras": [(item["path"], item["strength"]) for item in config["loras"]],
        },
        ensure_ascii=False,
        sort_keys=True,
    )
    with _EXTERNAL_SERVER_LOCK:
        if (
            _EXTERNAL_SERVER_PROCESS is not None
            and _EXTERNAL_SERVER_PROCESS.poll() is None
            and _EXTERNAL_SERVER_SIGNATURE == signature
            and _server_healthy(_EXTERNAL_SERVER_URL)
        ):
            return _EXTERNAL_SERVER_URL, config
        _stop_external_story_server()
        port = _free_local_port()
        base_url = f"http://127.0.0.1:{port}"
        command = [
            str(_story_runtime_executable()),
            "--model", config["model_path"],
            "--host", "127.0.0.1",
            "--port", str(port),
            "--ctx-size", str(config["context_length"]),
            "--n-gpu-layers", str(config["gpu_layers"]),
            "--alias", config["model_name"],
            "--jinja",
            "--no-webui",
        ]
        if config["loras"]:
            command.extend(
                [
                    "--lora-scaled",
                    ",".join(
                        f'{item["path"]}:{item["strength"]:g}'
                        for item in config["loras"]
                    ),
                ]
            )
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        _story_log(
            "INFO",
            f"正在启动外置故事模型：{config['model_name']}；"
            f"上下文={config['context_length']}；GPU层={config['gpu_layers']}；"
            f"LoRA={len(config['loras'])} 个。",
        )
        process = subprocess.Popen(
            command,
            cwd=str(_story_runtime_executable().parent),
            stdin=subprocess.DEVNULL,
            creationflags=creationflags,
        )
        _EXTERNAL_SERVER_PROCESS = process
        _EXTERNAL_SERVER_SIGNATURE = signature
        _EXTERNAL_SERVER_URL = base_url
        deadline = time.monotonic() + 600
        while time.monotonic() < deadline:
            if process.poll() is not None:
                code = process.returncode
                _stop_external_story_server()
                raise ValueError(f"故事模型启动失败，llama-server 退出码：{code}")
            if _server_healthy(base_url, timeout=2.0):
                _story_log("INFO", f"外置故事模型已就绪：{base_url}")
                return base_url, config
            time.sleep(1.0)
        _stop_external_story_server()
        raise ValueError("故事模型加载超过 10 分钟，请检查主模型、LoRA 与显存。")


def _call_external_story_model(payload, system_prompt, story):
    base_url, config = _ensure_external_story_server(payload.get("story_model_config"))
    shot_count = int(payload.get("shot_count") or 0)
    output_budget = _output_token_budget(config, shot_count)
    max_seconds = max(1, min(60, int(payload.get("max_generation_seconds") or 8)))
    _story_log(
        "INFO",
        f"阶段 1/2：正在提取角色、场景、道具和剧情节拍；故事={len(story)} 字。",
    )
    bible_text = _external_chat(
        base_url,
        config,
        [
            {
                "role": "system",
                "content": (
                    "你是影视前期制片与连续性监督。只提取原文中真实存在的角色、场景、"
                    "重要道具和完整剧情节拍，不得省略剧情，不得生成镜头。所有资产使用稳定编号："
                    "角色 CHAR001、场景 SC001、道具 PROP001、节拍 BEAT001。"
                ),
            },
            {
                "role": "user",
                "content": (
                    f"视觉风格：{payload.get('visual_category') or '电影写实'}。"
                    "story_beats 必须按原文顺序覆盖全部有效内容，每个节拍保留对应 source_text。\n\n"
                    f"故事原文：\n{story}"
                ),
            },
        ],
        _story_bible_response_format(),
        min(output_budget, 12000),
        temperature=0.1,
    )
    bible = _extract_json(bible_text)
    _story_log(
        "INFO",
        f"阶段 1/2 完成：角色={len(bible.get('characters') or [])}；"
        f"场景={len(bible.get('scenes') or [])}；道具={len(bible.get('props') or [])}；"
        f"剧情节拍={len(bible.get('story_beats') or [])}。",
    )
    _story_log(
        "INFO",
        f"阶段 2/2：正在生成 {shot_count} 个镜头并规划图片与视频任务。",
    )
    request_text = (
        f"请把下面故事拆成分镜。必须输出恰好 {shot_count} 个分镜，不得合并或省略关键剧情；"
        f"单镜头最长 {max_seconds} 秒；duration 是上限内的动态值，"
        "必须根据对白长度、动作复杂度和镜头节奏分配，禁止所有镜头使用相同时长；"
        f"视觉风格：{payload.get('visual_category') or '电影写实'}；"
        f"细节程度：{payload.get('detail') or '标准'}。"
        f"资产图片提示词必须使用：{payload.get('image_prompt_engine') or 'Qwen Image 2.1'} 的提示词规则。"
        f"视频模型：{payload.get('video_model') or 'MiniMax H3'}；"
        f"项目视频生成方式：{payload.get('video_generation_strategy') or '首尾帧+多参生视频'}。"
        "每个镜头必须填写 image_prompt_engine；没有任何参考资产时 image_generation_mode=文生图，"
        "使用角色、场景、道具或上一镜结果作为参考时 image_generation_mode=图片编辑。"
        "每个分镜只表达一个明确的视觉动作或叙事节拍，相邻分镜必须保持角色、服装、道具、场景和时间连续。"
        "protagonist_refs、supporting_refs、prop_refs、scene_ref 只能使用资产表中的编号；"
        "source_beat_ids 必须引用剧情节拍编号，并确保所有节拍至少被一个镜头引用。"
        "严格服从项目视频生成方式：首尾帧=所有有资产镜头使用首尾帧；"
        "多参生视频=所有有资产镜头使用多参考图；首尾帧+多参生视频=多资产镜头用多参考图，单一核心资产镜头用首尾帧。"
        "完全没有参考资产时才允许文生视频，不得把全部镜头统一设为文生视频。"
        "若为首尾帧，分别填写 first_frame_asset_refs、last_frame_asset_refs、first_frame_prompt、last_frame_prompt；"
        "若为多参考图，填写 multi_reference_asset_refs，并在 image_prompt/video_prompt 中用 @CHAR001、@SC001、@PROP001 引用资产；"
        "reference_requirements 要说明每张图的职责。\n\n"
        f"已锁定资产与剧情节拍：\n{json.dumps(bible, ensure_ascii=False)}\n\n"
        f"故事原文：\n{story}"
    )
    content = _external_chat(
        base_url,
        config,
        [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": request_text},
        ],
        _storyboard_response_format(shot_count, max_seconds),
        output_budget,
        temperature=float(payload.get("temperature") or 0.3),
    )
    board = _extract_json(content)
    board = _enrich_storyboard(
        board,
        bible,
        max_seconds,
        image_model=str(payload.get("image_prompt_engine") or payload.get("image_model") or "Qwen Image 2.1"),
        video_model=str(payload.get("video_model") or "MiniMax H3"),
        video_strategy=str(payload.get("video_generation_strategy") or "首尾帧+多参生视频"),
    )
    _story_log(
        "INFO",
        f"两阶段生成完成：{len(board.get('shots') or [])} 镜；"
        f"原文节拍覆盖率={board['validation']['source_coverage']:.0%}。",
    )
    return json.dumps(board, ensure_ascii=False)


def _repair_external_story_json(payload, invalid_content):
    base_url, config = _ensure_external_story_server(payload.get("story_model_config"))
    shot_count = int(payload.get("shot_count") or 0)
    max_seconds = max(1, min(60, int(payload.get("max_generation_seconds") or 8)))
    body = {
        "model": config["model_name"],
        "messages": [
            {
                "role": "system",
                "content": (
                    "你是 JSON 修复器。保留原分镜信息，修复语法并严格转换为指定 schema。"
                    "只输出 JSON，不解释，不新增或删除分镜。"
                ),
            },
            {"role": "user", "content": str(invalid_content)},
        ],
        "temperature": 0,
        "max_tokens": _output_token_budget(config, shot_count),
        "response_format": _storyboard_response_format(shot_count, max_seconds),
        "chat_template_kwargs": {"enable_thinking": False},
    }
    request = urllib.request.Request(
        f"{base_url}/v1/chat/completions",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=900) as response:
            response_data = json.loads(response.read(MAX_RESPONSE_BYTES + 1).decode("utf-8"))
        return response_data["choices"][0]["message"]["content"]
    except Exception as error:
        raise ValueError(f"分镜 JSON 自动修复失败：{error}") from error


def _request_storyboard(payload):
    story = str(payload.get("story") or "").strip()
    if not story:
        raise ValueError("请先上传或粘贴故事内容。")
    if len(story) > MAX_STORY_CHARS:
        raise ValueError("故事内容超过 20 万字限制。")
    model = str(payload.get("model") or "").strip()
    if not model:
        raise ValueError("请填写语言模型名称。")
    target_type = str(payload.get("target_type") or "图片分镜")
    shot_count = max(0, min(500, int(payload.get("shot_count") or 0)))
    duration = str(payload.get("duration") or "3-5")
    style = str(payload.get("style") or "").strip()
    detail = str(payload.get("detail") or "标准").strip()
    language = str(payload.get("language") or "中文").strip()
    output_options = {
        "提取角色信息": bool(payload.get("extract_characters", True)),
        "提取场景信息": bool(payload.get("extract_scenes", True)),
        "为每个分镜生成可直接用于生图的画面提示词": bool(payload.get("make_prompts", True)),
        "根据剧情生成对白或旁白": bool(payload.get("make_dialogue", True)),
        "跨分镜保持人物身份、服装、道具、场景和时间连续性": bool(payload.get("keep_consistency", True)),
    }
    option_text = "\n".join(
        f"- {name}：{'必须执行' if enabled else '不要求；对应字段可留空'}"
        for name, enabled in output_options.items()
    )
    user_prompt = (
        f"目标类型：{target_type}\n"
        f"期望分镜数：{shot_count if shot_count else '由你根据剧情自动判断'}\n"
        f"单镜头建议时长：{duration}秒\n"
        f"用户指定视觉风格：{style or '根据故事自动判断'}\n"
        f"细节程度：{detail}\n"
        f"输出语言：{language}\n"
        f"输出要求：\n{option_text}\n\n"
        f"故事原文：\n{story}"
    )
    request_body = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": float(payload.get("temperature", 0.4)),
    }
    headers = {"Content-Type": "application/json"}
    api_key = str(payload.get("api_key") or "").strip()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    request = urllib.request.Request(
        _chat_url(payload.get("base_url")),
        data=json.dumps(request_body, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        detail = error.read(2048).decode("utf-8", "replace")
        raise ValueError(f"语言模型请求失败（HTTP {error.code}）：{detail}") from error
    except urllib.error.URLError as error:
        raise ValueError(f"无法连接语言模型：{error.reason}") from error
    if len(raw) > MAX_RESPONSE_BYTES:
        raise ValueError("语言模型返回内容过大。")
    try:
        response_data = json.loads(raw.decode("utf-8"))
        content = response_data["choices"][0]["message"]["content"]
    except (UnicodeDecodeError, json.JSONDecodeError, KeyError, IndexError, TypeError) as error:
        raise ValueError("语言模型返回格式不兼容 OpenAI Chat Completions。") from error
    storyboard = _extract_json(content)
    normalized = XiantuStoryboardDirector._parse(
        json.dumps(storyboard, ensure_ascii=False)
    )
    return normalized


async def _generate_storyboard(request):
    try:
        payload = await request.json()
        storyboard = await asyncio.to_thread(_request_storyboard, payload)
        return web.json_response({"ok": True, "storyboard": storyboard})
    except Exception as error:
        _story_log("ERROR", f"生成失败：{error}")
        traceback.print_exc(file=sys.stderr)
        return web.json_response({"ok": False, "error": str(error)}, status=400)


async def _run_external_story_job(payload, system_prompt, story):
    async with _EXTERNAL_STORY_JOB_LOCK:
        try:
            raw = await asyncio.to_thread(
                _call_external_story_model, payload, system_prompt, story
            )
            try:
                return _extract_json(raw)
            except ValueError:
                _story_log("WARNING", "首次结果 JSON 无效，正在执行一次结构化自动修复。")
                repaired = await asyncio.to_thread(
                    _repair_external_story_json, payload, raw
                )
                return _extract_json(repaired)
        finally:
            await asyncio.to_thread(_stop_external_story_server)
            _story_log("INFO", "外接故事模型已卸载，显存已释放。")


async def _generate_with_local_component(request):
    try:
        payload = await request.json()
        story = str(payload.get("story") or "").strip()
        if len(story) < 20:
            raise ValueError("故事内容太短，请至少提供 20 个字。")
        if len(story) > 300_000:
            raise ValueError("故事内容超过 30 万字，请拆分后生成。")
        shot_count, automatic_count = _effective_shot_count(
            story, payload.get("shot_count")
        )
        payload["shot_count"] = shot_count
        toolkit = _toolkit_api_module()
        max_seconds = max(1, min(60, int(payload.get("max_generation_seconds") or 8)))
        system_prompt = toolkit._storyboard_system_prompt(
            str(payload.get("video_model") or "MiniMax H3"),
            str(payload.get("image_model") or "Qwen Image 2.1"),
            str(payload.get("video_skill") or "自动匹配官方规则"),
            str(payload.get("image_skill") or "自动匹配模型规则"),
            str(payload.get("visual_category") or "电影写实"),
        )
        image_model = str(payload.get("image_prompt_engine") or payload.get("image_model") or "Qwen Image 2.1")
        video_model = str(payload.get("video_model") or "MiniMax H3")
        video_strategy = str(payload.get("video_generation_strategy") or "首尾帧+多参生视频")
        system_prompt += (
            f"\nHard constraint: every shot duration must be <= {max_seconds} seconds."
            f"\nHard constraint: output exactly {shot_count} shots. Do not merge story beats."
            f"\nAsset prompts must follow {image_model} prompting rules."
            f"\nVideo prompts must follow {video_model} prompting rules."
            f"\nProject video generation strategy is {video_strategy}; obey it for every shot."
            "\nDo not specify image or video aspect ratio; the downstream workflow owns dimensions."
            "\nBefore returning, validate the complete JSON. Every adjacent array item "
            "must be separated by a comma. Return one JSON object only."
        )
        _story_log(
            "INFO",
            f"分镜数量={'自动计算' if automatic_count else '用户指定'}：{shot_count} 个；"
            f"故事={len(re.sub(r'\s+', '', story))} 个有效字符。",
        )
        if payload.get("story_model_config"):
            board = await _run_external_story_job(payload, system_prompt, story)
        elif str(payload.get("engine") or "local") == "online":
            raw = await toolkit._call_storyboard_online(payload, system_prompt, story)
            board = _extract_json(raw)
        else:
            raw = await asyncio.to_thread(
                toolkit._call_storyboard_local, payload, system_prompt, story
            )
            board = _extract_json(raw)
        normalize_board = getattr(toolkit, "_normalize_board", None)
        if callable(normalize_board) and not payload.get("story_model_config"):
            board = normalize_board(board)
        if not isinstance(board, dict) or not isinstance(board.get("shots"), list):
            raise ValueError("模型返回结果缺少有效分镜列表。")
        if len(board["shots"]) != shot_count:
            raise ValueError(
                f"模型应生成 {shot_count} 个分镜，实际返回 {len(board['shots'])} 个，请重新生成。"
            )
        board = _apply_board_generation_settings(board, payload)
        board = _balance_uniform_durations(board, max_seconds)
        return web.json_response(
            {"ok": True, "board": board, "count": len(board["shots"])}
        )
    except Exception as error:
        _story_log("ERROR", f"生成失败：{error}")
        traceback.print_exc(file=sys.stderr)
        return web.json_response({"ok": False, "error": str(error)}, status=400)


def _register_routes():
    prompt_server = getattr(PromptServer, "instance", None)
    if prompt_server is not None:
        prompt_server.routes.post("/xiantu/qwen21/storyboard/generate")(
            _generate_with_local_component
        )
        prompt_server.routes.post("/xiantu/qwen21/storyboard/generate-online")(
            _generate_storyboard
        )


_register_routes()
