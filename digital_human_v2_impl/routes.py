from __future__ import annotations

import mimetypes
import io
import importlib
import re
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

import folder_paths
from aiohttp import web
from server import PromptServer

from .storage import (
    create_project,
    project_dir,
    read_state,
    safe_media,
    save_state,
    save_state_preserving_generated_prompts,
)


routes = PromptServer.instance.routes


def ok(**payload):
    return web.json_response({"ok": True, **payload})


def error(exc, status=400):
    return web.json_response({"ok": False, "error": str(exc)}, status=status)


def qwen_h3_model_catalog():
    """Read the same GGUF directory and classification used by Qwen H3 Prompt."""
    module = None
    for loaded in list(sys.modules.values()):
        namespace = getattr(loaded, "__dict__", None) if loaded is not None else None
        if isinstance(namespace, dict) and isinstance(namespace.get("QwenH3Prompt"), type):
            module = loaded
            break
    if module is None:
        for module_name in (
            "ComfyUI_Qwen_H3_Prompt.node",
            "custom_nodes.ComfyUI_Qwen_H3_Prompt.node",
        ):
            try:
                module = importlib.import_module(module_name)
                break
            except Exception:  # noqa: BLE001
                continue

    default_model = getattr(module, "DEFAULT_MODEL", "Qwen3.8-27B-Q4_K_M.gguf")
    default_mmproj = getattr(module, "DEFAULT_MMPROJ", "mmproj-F16.gguf")
    model_dir = Path(
        getattr(module, "MODEL_DIR", Path(folder_paths.models_dir) / "LLM" / "Qwen3.8")
    )
    files = sorted(
        (path.name for path in model_dir.glob("*.gguf") if path.is_file()),
        key=str.casefold,
    ) if model_dir.is_dir() else []
    return {
        "installed": module is not None,
        "directory": str(model_dir),
        "models": [name for name in files if "mmproj" not in name.lower()],
        "projectors": [name for name in files if "mmproj" in name.lower()],
        "default_model": default_model,
        "default_projector": default_mmproj,
    }


async def multipart_fields(request):
    reader = await request.multipart()
    values, uploads = {}, {}
    while True:
        part = await reader.next()
        if part is None:
            break
        if part.filename:
            uploads[part.name] = (part.filename, await part.read(decode=False))
        else:
            values[part.name] = await part.text()
    return values, uploads


@routes.get("/xiantu/dhv2/qwen-models")
async def qwen_models(_request):
    try:
        return ok(**qwen_h3_model_catalog())
    except Exception as exc:
        return error(exc, 500)


@routes.post("/xiantu/dhv2/projects")
async def create(_request):
    try:
        return ok(project=create_project())
    except Exception as exc:
        return error(exc, 500)


@routes.get("/xiantu/dhv2/projects/{project_id}")
async def get_project(request):
    try:
        return ok(project=read_state(request.match_info["project_id"]))
    except FileNotFoundError as exc:
        return error(exc, 404)
    except Exception as exc:
        return error(exc)


@routes.put("/xiantu/dhv2/projects/{project_id}")
async def put_project(request):
    try:
        state = await request.json()
        if state.get("id") != request.match_info["project_id"]:
            raise ValueError("项目编号不一致")
        explicit_optimized_ids = {
            str(value)
            for value in state.pop("_write_optimized_prompt_ids", [])
            if str(value)
        }
        return ok(
            project=save_state_preserving_generated_prompts(
                state, explicit_optimized_ids
            )
        )
    except Exception as exc:
        return error(exc)


@routes.get("/xiantu/dhv2/projects/{project_id}/audio/mix")
async def mixed_audio(request):
    """Return the project's single sequential audio lane as a playable WAV."""
    try:
        import numpy as np
        import soundfile as sf

        project_id = request.match_info["project_id"]
        state = read_state(project_id)
        tracks = state.get("audio_tracks") or []
        if not tracks:
            raise FileNotFoundError("项目还没有音频")
        sample_rate = max((int(item.get("sample_rate") or 0) for item in tracks), default=0) or 44100
        total_length = max(1, round(float(state.get("duration") or 0) * sample_rate))
        mixed = np.zeros((total_length, 2), dtype=np.float32)
        base = project_dir(project_id)
        for item in tracks:
            if item.get("muted"):
                continue
            path = base / str(item.get("path") or "")
            if not path.is_file():
                continue
            samples, source_rate = sf.read(str(path), always_2d=True, dtype="float32")
            if samples.shape[1] == 1:
                samples = np.repeat(samples, 2, axis=1)
            elif samples.shape[1] > 2:
                samples = samples[:, :2]
            source_rate = int(source_rate)
            if source_rate != sample_rate and len(samples) > 1:
                count = max(1, round(len(samples) * sample_rate / source_rate))
                source_axis = np.linspace(0.0, 1.0, len(samples), endpoint=False)
                target_axis = np.linspace(0.0, 1.0, count, endpoint=False)
                samples = np.column_stack([
                    np.interp(target_axis, source_axis, samples[:, channel])
                    for channel in range(samples.shape[1])
                ]).astype(np.float32)
            left = max(0, round(float(item.get("offset") or 0) * sample_rate))
            count = min(len(samples), total_length - left)
            if count > 0:
                volume = max(0.0, min(2.0, float(item.get("volume", 1.0))))
                mixed[left:left + count] += samples[:count] * volume
        stream = io.BytesIO()
        sf.write(stream, np.clip(mixed, -1.0, 1.0), sample_rate, format="WAV", subtype="PCM_16")
        payload = stream.getvalue()
        total = len(payload)
        headers = {"Cache-Control": "no-store", "Accept-Ranges": "bytes"}
        requested = request.headers.get("Range", "")
        match = re.fullmatch(r"bytes=(\d*)-(\d*)", requested.strip()) if requested else None
        if match:
            start_text, end_text = match.groups()
            if start_text:
                start = int(start_text)
                end = min(total - 1, int(end_text)) if end_text else total - 1
            elif end_text:
                length = min(total, int(end_text))
                start, end = total - length, total - 1
            else:
                start, end = 0, total - 1
            if start >= total or start > end:
                return web.Response(status=416, headers={**headers, "Content-Range": f"bytes */{total}"})
            body = payload[start:end + 1]
            headers.update({"Content-Range": f"bytes {start}-{end}/{total}", "Content-Length": str(len(body))})
            return web.Response(status=206, body=body, content_type="audio/wav", headers=headers)
        headers["Content-Length"] = str(total)
        return web.Response(body=payload, content_type="audio/wav", headers=headers)
    except FileNotFoundError as exc:
        return error(exc, 404)
    except Exception as exc:
        return error(exc, 500)


@routes.post("/xiantu/dhv2/projects/{project_id}/audio")
async def upload_audio(request):
    try:
        project_id = request.match_info["project_id"]
        values, uploads = await multipart_fields(request)
        if "file" not in uploads:
            raise ValueError("没有收到音频文件")
        filename, content = uploads["file"]
        suffix = Path(filename).suffix.lower() or ".wav"
        if suffix not in {".wav", ".mp3", ".flac", ".m4a", ".aac", ".ogg"}:
            raise ValueError("不支持的音频格式")
        directory = project_dir(project_id) / "audio"
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / f"{uuid.uuid4().hex}{suffix}"
        target.write_bytes(content)
        duration, sample_rate = 0.0, 0
        try:
            import soundfile as sf
            info = sf.info(str(target))
            duration, sample_rate = float(info.duration), int(info.samplerate)
        except Exception:
            pass
        state = read_state(project_id)
        tracks = state.setdefault("audio_tracks", [])
        mode = str(values.get("mode") or "add").strip().lower()
        track_id = str(values.get("track_id") or "").strip()
        record = {
            "id": uuid.uuid4().hex[:12],
            "name": Path(filename).name,
            "path": target.relative_to(project_dir(project_id)).as_posix(),
            "duration": round(duration, 3),
            "sample_rate": sample_rate,
            "offset": 0.0,
            "volume": 1.0,
            "muted": False,
        }
        had_tracks = bool(tracks)
        if mode == "replace" and tracks:
            index = next((i for i, item in enumerate(tracks) if str(item.get("id")) == track_id),
                         int(state.get("selected_audio_track") or 0))
            index = max(0, min(index, len(tracks) - 1))
            previous = tracks[index]
            record["id"] = str(previous.get("id") or record["id"])
            record["offset"] = max(0.0, float(previous.get("offset") or 0))
            record["volume"] = max(0.0, min(2.0, float(previous.get("volume", 1.0))))
            record["muted"] = bool(previous.get("muted", False))
            tracks[index] = record
            old_path = project_dir(project_id) / str(previous.get("path") or "")
            if old_path.is_file() and old_path.resolve().parent == directory.resolve():
                old_path.unlink(missing_ok=True)
        else:
            tracks.append(record)
            index = len(tracks) - 1
        state["selected_audio_track"] = index
        state["sample_rate"] = max((int(item.get("sample_rate") or 0) for item in tracks), default=0)
        state["duration"] = round(max((float(item.get("offset") or 0) + float(item.get("duration") or 0)
                                       for item in tracks), default=0.0), 3)
        if not had_tracks and state.get("segments"):
            state["segments"][0]["start"] = 0.0
            state["segments"][0]["end"] = state["duration"]
        return ok(project=save_state(state))
    except Exception as exc:
        return error(exc)


@routes.post("/xiantu/dhv2/projects/{project_id}/audio/remove")
async def remove_audio_track(request):
    try:
        project_id = request.match_info["project_id"]
        payload = await request.json()
        track_id = str(payload.get("track_id") or "").strip()
        state = read_state(project_id)
        tracks = state.get("audio_tracks") or []
        index = next((i for i, item in enumerate(tracks) if str(item.get("id")) == track_id), -1)
        if index < 0:
            raise ValueError("音轨不存在")
        removed = tracks.pop(index)
        path = project_dir(project_id) / str(removed.get("path") or "")
        audio_root = (project_dir(project_id) / "audio").resolve()
        if path.is_file() and path.resolve().parent == audio_root:
            path.unlink(missing_ok=True)
        state["selected_audio_track"] = max(0, min(index, len(tracks) - 1))
        state["duration"] = round(max((float(item.get("offset") or 0) + float(item.get("duration") or 0)
                                       for item in tracks), default=0.0), 3)
        state["sample_rate"] = max((int(item.get("sample_rate") or 0) for item in tracks), default=0)
        return ok(project=save_state(state))
    except Exception as exc:
        return error(exc)


@routes.post("/xiantu/dhv2/projects/{project_id}/refs")
async def upload_refs(request):
    try:
        project_id = request.match_info["project_id"]
        values, uploads = await multipart_fields(request)
        index = int(values.get("segment_index", 0))
        state = read_state(project_id)
        segment = state["segments"][index]
        target_refs = segment.setdefault("refs", [])
        total_refs = len(target_refs)
        if total_refs >= 9:
            raise ValueError("当前分镜最多上传 9 张参考图")
        directory = project_dir(project_id) / "refs"
        directory.mkdir(parents=True, exist_ok=True)
        added = []
        for _field, (filename, content) in uploads.items():
            if total_refs + len(added) >= 9:
                break
            suffix = Path(filename).suffix.lower() or ".png"
            if suffix not in {".png", ".jpg", ".jpeg", ".webp"}:
                continue
            target = directory / f"{uuid.uuid4().hex}{suffix}"
            target.write_bytes(content)
            record = {"name": Path(filename).name, "path": target.relative_to(project_dir(project_id)).as_posix()}
            target_refs.append(record)
            added.append(record)
        if not added:
            raise ValueError("没有收到可用图片")
        return ok(project=save_state(state))
    except Exception as exc:
        return error(exc)


@routes.post("/xiantu/dhv2/projects/{project_id}/assets")
async def upload_assets(request):
    try:
        project_id = request.match_info["project_id"]
        values, uploads = await multipart_fields(request)
        category = str(values.get("category") or "other")
        if category not in {"character", "scene", "prop", "other"}:
            category = "other"
        state = read_state(project_id)
        assets = state.setdefault("assets", [])
        directory = project_dir(project_id) / "assets"
        directory.mkdir(parents=True, exist_ok=True)
        added = []
        for _field, (filename, content) in uploads.items():
            suffix = Path(filename).suffix.lower() or ".png"
            if suffix not in {".png", ".jpg", ".jpeg", ".webp"}:
                continue
            target = directory / f"{uuid.uuid4().hex}{suffix}"
            target.write_bytes(content)
            record = {
                "id": uuid.uuid4().hex[:12],
                "name": Path(filename).name,
                "path": target.relative_to(project_dir(project_id)).as_posix(),
                "category": category,
            }
            assets.append(record)
            added.append(record)
        if not added:
            raise ValueError("没有收到可用图片")
        return ok(project=save_state(state), added=added)
    except Exception as exc:
        return error(exc)


@routes.post("/xiantu/dhv2/projects/{project_id}/assets/delete")
async def delete_assets(request):
    try:
        project_id = request.match_info["project_id"]
        values = await request.json()
        selected_ids = {str(value) for value in values.get("asset_ids") or []}
        if not selected_ids:
            raise ValueError("请先选择要删除的资产")
        state = read_state(project_id)
        removed = [item for item in state.get("assets") or [] if str(item.get("id")) in selected_ids]
        state["assets"] = [item for item in state.get("assets") or [] if str(item.get("id")) not in selected_ids]
        referenced_paths = {
            str(item.get("path"))
            for segment in state.get("segments") or []
            for item in segment.get("refs") or []
            if isinstance(item, dict) and item.get("path")
        }
        asset_root = (project_dir(project_id) / "assets").resolve()
        for item in removed:
            path = project_dir(project_id) / str(item.get("path") or "")
            if str(item.get("path") or "") in referenced_paths:
                continue
            resolved = path.resolve()
            if resolved.is_file() and resolved.parent == asset_root:
                resolved.unlink()
        return ok(project=save_state(state), deleted=len(removed))
    except Exception as exc:
        return error(exc)


def _output_file(record: dict) -> Path:
    roots = {
        "output": Path(folder_paths.get_output_directory()),
        "temp": Path(folder_paths.get_temp_directory()),
        "input": Path(folder_paths.get_input_directory()),
    }
    root = roots.get(str(record.get("type") or "output"), roots["output"]).resolve()
    path = (root / str(record.get("subfolder") or "") / str(record.get("filename") or "")).resolve()
    if root != path and root not in path.parents:
        raise ValueError("视频路径越界")
    if not path.is_file():
        raise FileNotFoundError(f"视频不存在：{path.name}")
    return path


def _result_kind(record: dict) -> str:
    path = f"/{record.get('subfolder') or ''}/{record.get('filename') or ''}/".replace("\\", "/")
    if "/合并成品/" in path or str(record.get("segment_id")) == "merged":
        return "merged"
    if "/放大前/" in path or str(record.get("filename") or "").startswith("H3_Director_Final"):
        return "before"
    return "after"


@routes.post("/xiantu/dhv2/projects/{project_id}/merge")
async def merge_results(request):
    try:
        project_id = request.match_info["project_id"]
        payload = await request.json()
        wanted = {str(value) for value in payload.get("result_ids") or []}
        state = read_state(project_id)
        records = [item for item in state.get("results") or []
                   if str(item.get("id")) in wanted and _result_kind(item) == "after"]
        records.sort(key=lambda item: (
            int(item.get("segment_index")) if str(item.get("segment_index", "")).lstrip("-").isdigit() else 10**9,
            str(item.get("filename") or ""),
        ))
        if len(records) < 2:
            raise ValueError("请至少选择两个放大后视频")
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            try:
                import imageio_ffmpeg
                ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
            except Exception:
                ffmpeg = None
        if not ffmpeg:
            raise RuntimeError("未找到 ffmpeg，无法合并视频")
        sources = [_output_file(item) for item in records]
        directory = Path(folder_paths.get_output_directory()) / "数字人" / "合并成品"
        directory.mkdir(parents=True, exist_ok=True)
        counters = []
        for path in directory.glob("成品-*.mp4"):
            match = re.fullmatch(r"成品-(\d+)\.mp4", path.name, re.IGNORECASE)
            if match:
                counters.append(int(match.group(1)))
        counter = max(counters, default=0) + 1
        concat_file = directory / f".合并清单-{uuid.uuid4().hex}.txt"
        concat_file.write_text("\n".join(f"file '{path.as_posix().replace(chr(39), chr(39) + '\\\\' + chr(39))}'" for path in sources), encoding="utf-8")
        target = directory / f"成品-{counter:03d}.mp4"
        first = subprocess.run([ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(concat_file), "-c", "copy", str(target)], capture_output=True, text=True, timeout=3600)
        if first.returncode != 0:
            second = subprocess.run([ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(concat_file), "-c:v", "libx264", "-c:a", "aac", "-movflags", "+faststart", str(target)], capture_output=True, text=True, timeout=3600)
            if second.returncode != 0:
                raise RuntimeError((second.stderr or first.stderr or "视频合并失败")[-1200:])
        concat_file.unlink(missing_ok=True)
        subfolder = target.parent.relative_to(Path(folder_paths.get_output_directory())).as_posix()
        result = {
            "id": uuid.uuid4().hex[:12],
            "fingerprint": f"output/{subfolder}/{target.name}",
            "filename": target.name,
            "subfolder": subfolder,
            "type": "output",
            "format": "video/mp4",
            "segment_id": "merged",
            "segment_index": -1,
            "segment_name": f"成品-{counter:03d}（{len(records)} 段）",
            "duration": round(sum(float(item.get("duration") or 0) for item in records), 3),
            "created": int(time.time() * 1000),
            "selected": False,
        }
        state.setdefault("results", []).append(result)
        return ok(project=save_state(state), result=result)
    except Exception as exc:
        return error(exc)


@routes.post("/xiantu/dhv2/projects/{project_id}/results/open-folder")
async def open_results_folder(request):
    try:
        directory = Path(folder_paths.get_output_directory()) / "数字人"
        directory.mkdir(parents=True, exist_ok=True)
        subprocess.Popen(["explorer.exe", str(directory)], creationflags=0x08000000)
        return ok(path=str(directory))
    except Exception as exc:
        return error(exc, 500)


@routes.get("/xiantu/dhv2/projects/{project_id}/media/{path:.*}")
async def media(request):
    try:
        path = safe_media(request.match_info["project_id"], request.match_info["path"])
        return web.FileResponse(path, headers={"Content-Type": mimetypes.guess_type(path.name)[0] or "application/octet-stream"})
    except FileNotFoundError as exc:
        return error(exc, 404)
    except Exception as exc:
        return error(exc)
