from __future__ import annotations

import json
import re
import threading
import time
import uuid
from pathlib import Path

import folder_paths


ROOT = Path(folder_paths.get_output_directory()) / "XiantuDigitalHumanV2" / "projects"
PROJECT_RE = re.compile(r"^[a-zA-Z0-9_-]{8,80}$")
STATE_LOCK = threading.RLock()


def project_dir(project_id: str) -> Path:
    project_id = str(project_id or "").strip()
    if not PROJECT_RE.fullmatch(project_id):
        raise ValueError("无效的项目编号")
    root = ROOT.resolve()
    path = (root / project_id).resolve()
    if root not in path.parents:
        raise ValueError("项目路径越界")
    return path


def default_state(project_id: str) -> dict:
    return {
        "id": project_id,
        "created": int(time.time()),
        "audio": None,
        "audio_tracks": [],
        "selected_audio_track": 0,
        "duration": 0.0,
        "sample_rate": 0,
        "audio_cuts": [],
        "assets": [],
        "results": [],
        "selected_segment": 0,
        "settings": {
            "aspect": "16:9（宽屏）",
            "megapixels": "0.6",
            "resolution": "1056 × 608",
            "auto_optimize": False,
            "llm_model": "Qwen3.8-27B-Q4_K_M.gguf",
            "vision_model": "mmproj-F16.gguf",
            "think_mode": False,
            "reasoning_effort": "medium",
            "seed": 0,
            "max_tokens": 8192,
            "video_sample_frames_per_sec": 2,
            "force_unload_model": True,
            "multiple": "32",
            "width": 1056,
            "height": 608,
            "reference_size": "max",
            "fps": 24,
            "skill": "auto",
            "performance_mode": "singing",
            "model_profile": "h3",
            "filename_prefix": "",
            "filename_rule_v3": True,
        },
        "segments": [new_segment(0.0, 0.0, 1)],
    }


def new_segment(start: float, end: float, index: int) -> dict:
    return {
        "id": uuid.uuid4().hex[:12],
        "name": f"分镜 {index:02d}",
        "start": round(max(0.0, float(start)), 3),
        "end": round(max(float(start), float(end)), 3),
        "refs": [],
        "original_prompt": "",
        "optimized_prompt": "",
    }


def create_project() -> dict:
    ROOT.mkdir(parents=True, exist_ok=True)
    project_id = time.strftime("dhv2_%Y%m%d_") + uuid.uuid4().hex[:10]
    state = default_state(project_id)
    save_state(state)
    return state


def read_state(project_id: str) -> dict:
    with STATE_LOCK:
        path = project_dir(project_id) / "state.json"
        if not path.is_file():
            raise FileNotFoundError("数字人项目不存在")
        return normalize_state(json.loads(path.read_text(encoding="utf-8")))


def normalize_state(state: dict) -> dict:
    """Upgrade legacy single-audio projects without invalidating their workflows."""
    tracks = state.get("audio_tracks")
    if not isinstance(tracks, list):
        tracks = []
    legacy = state.get("audio")
    if not tracks and isinstance(legacy, dict) and legacy.get("path"):
        tracks = [{
            "id": uuid.uuid4().hex[:12],
            "name": legacy.get("name") or Path(str(legacy["path"])).name,
            "path": legacy["path"],
            "duration": float(state.get("duration") or legacy.get("duration") or 0),
            "sample_rate": int(state.get("sample_rate") or legacy.get("sample_rate") or 0),
            "offset": 0.0,
            "volume": 1.0,
            "muted": False,
        }]
    cleaned = []
    timeline_offset = 0.0
    for index, item in enumerate(tracks):
        if not isinstance(item, dict) or not item.get("path"):
            continue
        cleaned.append({
            **item,
            "id": str(item.get("id") or uuid.uuid4().hex[:12]),
            "name": str(item.get("name") or Path(str(item["path"])).name),
            "duration": max(0.0, float(item.get("duration") or 0)),
            "sample_rate": max(0, int(item.get("sample_rate") or 0)),
            "offset": round(timeline_offset, 3),
            "volume": max(0.0, min(2.0, float(item.get("volume", 1.0)))),
            "muted": bool(item.get("muted", False)),
            "label": f"A{index + 1}",
        })
        timeline_offset += cleaned[-1]["duration"]
    state["audio_tracks"] = cleaned
    selected = max(0, min(int(state.get("selected_audio_track") or 0), max(0, len(cleaned) - 1)))
    state["selected_audio_track"] = selected
    state["audio"] = cleaned[selected] if cleaned else None
    assets = state.get("assets")
    if not isinstance(assets, list):
        assets = []
    known_asset_paths = set()
    cleaned_assets = []
    for item in assets:
        if not isinstance(item, dict) or not item.get("path"):
            continue
        path = str(item["path"])
        if path in known_asset_paths:
            continue
        known_asset_paths.add(path)
        cleaned_assets.append({
            "id": str(item.get("id") or uuid.uuid4().hex[:12]),
            "name": str(item.get("name") or Path(path).name),
            "path": path,
            "category": str(item.get("category") or "other"),
        })
    # Migrate references already stored in the project into the persistent
    # library. Browser-only files that were never uploaded cannot be recovered.
    for segment in state.get("segments") or []:
        for item in segment.get("refs") or []:
            if not isinstance(item, dict) or not item.get("path"):
                continue
            path = str(item["path"])
            if path in known_asset_paths:
                continue
            known_asset_paths.add(path)
            cleaned_assets.append({
                "id": str(item.get("id") or uuid.uuid4().hex[:12]),
                "name": str(item.get("name") or Path(path).name),
                "path": path,
                "category": "other",
            })
    state["assets"] = cleaned_assets
    calculated_duration = max(
        (float(item.get("offset") or 0) + float(item.get("duration") or 0) for item in cleaned),
        default=0.0,
    )
    if calculated_duration > 0:
        state["duration"] = round(calculated_duration, 3)
    elif not cleaned:
        state["duration"] = 0.0
    state.setdefault("settings", {})
    state["settings"].setdefault("reference_size", "max")
    state["settings"].setdefault("skill", "auto")
    state["settings"].setdefault("performance_mode", "singing")
    state["settings"].setdefault("model_profile", "h3")
    if not state["settings"].get("filename_rule_v3"):
        if str(state["settings"].get("filename_prefix") or "").strip() == "数字人":
            state["settings"]["filename_prefix"] = ""
        state["settings"]["filename_rule_v3"] = True
    state["settings"].setdefault("filename_prefix", "")
    state["settings"].setdefault("auto_optimize", False)
    state["settings"].setdefault("llm_model", "Qwen3.8-27B-Q4_K_M.gguf")
    state["settings"].setdefault("vision_model", "mmproj-F16.gguf")
    state["settings"].setdefault("think_mode", False)
    state["settings"].setdefault("reasoning_effort", "medium")
    state["settings"].setdefault("seed", 0)
    state["settings"].setdefault("max_tokens", 8192)
    state["settings"].setdefault("video_sample_frames_per_sec", 2)
    state["settings"].setdefault("force_unload_model", True)
    return state


def save_state(state: dict) -> dict:
    with STATE_LOCK:
        state = normalize_state(state)
        path = project_dir(state.get("id"))
        path.mkdir(parents=True, exist_ok=True)
        state_file = path / "state.json"
        temporary = state_file.with_suffix(".tmp")
        temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(state_file)
        return state


def save_state_preserving_generated_prompts(state: dict, writable_segment_ids: set[str]) -> dict:
    """Atomically preserve backend-generated prompts during ordinary UI saves."""
    with STATE_LOCK:
        try:
            current_state = read_state(state.get("id"))
        except FileNotFoundError:
            current_state = {}
        current_segments = current_state.get("segments", [])
        current_by_id = {
            str(segment.get("id")): segment
            for segment in current_segments
            if isinstance(segment, dict) and segment.get("id") is not None
        }
        for index, segment in enumerate(state.get("segments", [])):
            if not isinstance(segment, dict):
                continue
            segment_id = str(segment.get("id", ""))
            if segment_id in writable_segment_ids:
                continue
            current_segment = current_by_id.get(segment_id)
            if current_segment is None and index < len(current_segments):
                candidate = current_segments[index]
                current_segment = candidate if isinstance(candidate, dict) else None
            if not current_segment:
                continue
            if "optimized_prompt" in current_segment:
                segment["optimized_prompt"] = current_segment.get("optimized_prompt", "")
            if "optimization_engine" in current_segment:
                segment["optimization_engine"] = current_segment.get("optimization_engine")
        return save_state(state)


def safe_media(project_id: str, relative: str) -> Path:
    base = project_dir(project_id).resolve()
    path = (base / str(relative or "")).resolve()
    if base not in path.parents or not path.is_file():
        raise FileNotFoundError("素材不存在")
    return path
