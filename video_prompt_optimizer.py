"""Local H3 prompt optimization owned by the video workbench."""

import asyncio
import base64
import hashlib
import io
import json
import logging
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from urllib.error import URLError
import urllib.request
import zipfile

from aiohttp import web
import folder_paths
from server import PromptServer


ROUTE = "/xiantu/video-editor/prompt"
RUNTIME_DIRECTORY = Path(__file__).resolve().parent / "runtime" / "video-prompt" / "b10689"
RUNTIME_URL = "https://github.com/ggml-org/llama.cpp/releases/download/b10689/llama-b10689-bin-win-vulkan-x64.zip"
RUNTIME_SHA256 = "3da600ff52a746d82e32a2ba3f0382e3bf782bd3a8fece661b646e1dee7ac1c6"
RUNTIME_LICENSE_URL = "https://raw.githubusercontent.com/ggml-org/llama.cpp/57291f264/LICENSE"
RUNTIME_LICENSE_SHA256 = "94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d"
DEFAULT_MODEL = "Qwen3VL-4B-Instruct-Q4_K_M.gguf"
DEFAULT_PROJECTOR = "mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf"
MODEL_REPO = "https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/main/"
MODEL_DOWNLOADS = {
    "model": (DEFAULT_MODEL, "66358cb18bb6b3b1b6675aa412c7a88ef01d228f481184d13668e5201c730a0a"),
    "projector": (DEFAULT_PROJECTOR, "30ba2c7dd3127a4561b6cba9d13d0f711c91bdb38742e2f56d73c8cb596bd06d"),
}
# Hashes distinguish the verified projectors, even when the filename is only mmproj-F16.gguf.
VERIFIED_PROJECTORS = {
    "qwen3.8-27b-q4_k_m.gguf": (927607488, "cbb841a9ee0636b2ec172f5bb8df2ea8dfeb01e90fe7c6126581d662a0b4e43e"),
    "qwen3.8-27b-abliterated-q4_k_m.gguf": (931145888, "c9a09064683620bea3d3bfed5d4462e1a97a7d2fff7e5045d6862a0a85eeb5b5"),
    "qwen3.8-9b-distill-heretic_nvfp4_q8_0.gguf": (921705024, "853698ce7aa6c7ba732478bad280240969ddf7b0fcbf93900046f63903a83383"),
    DEFAULT_MODEL.casefold(): (453974304, MODEL_DOWNLOADS["projector"][1]),
}
PROMPT_OPTIMIZER_VERSION = "xiantu-video-editor-h3-local-v1"
PROMPT_SKILL_SOURCE = "https://github.com/MiniMax-AI/MiniMax-H3/tree/main/.agents/skills/h3-prompt-writing"

_OPTIMIZER_LOCK = threading.Lock()
_PROCESS_LOCK = threading.Lock()
_INSTALL_LOCK = threading.Lock()
_OPTIMIZER_CANCELLED = threading.Event()
_active_task = ""
_process = None
_projector_hashes = {}


def _runtime_executable():
    return RUNTIME_DIRECTORY / "llama-server.exe"


def _storyboard_progress(task_id, stage, percent, detail=""):
    if task_id:
        PromptServer.instance.send_sync("xiantu-video-prompt-progress", {
            "task_id": task_id, "stage": stage, "percent": percent, "detail": detail,
        })


def _sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _projector_matches(model, projector):
    expected = VERIFIED_PROJECTORS.get(model.name.casefold())
    if expected is None:
        return False
    stat = projector.stat()
    if stat.st_size != expected[0]:
        return False
    cached = _projector_hashes.get(projector)
    state = (stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
    if not cached or cached[0] != state:
        cached = _projector_hashes[projector] = (state, _sha256(projector))
    return cached[1] == expected[1]


def _catalog(*, verify_projectors=True):
    models_dir = Path(folder_paths.models_dir).resolve()
    roots = {models_dir / "llm", models_dir / "LLM"}
    for group in ("llm", "LLM"):
        if group in folder_paths.folder_names_and_paths:
            roots.update(Path(item) for item in folder_paths.get_folder_paths(group))
    files = {path.resolve() for root in roots if root.is_dir()
             for path in root.rglob("*.gguf") if path.is_file()}
    ordered = sorted(files, key=lambda path: str(path).casefold())
    projectors = [path for path in ordered if any(part in path.name.casefold() for part in ("mmproj", "projector", "mm-project"))]
    projector_set = set(projectors)
    models = []
    pairings = {}
    for path in ordered:
        if path in projector_set or path.name.casefold().startswith(("mtp-", "dflash-", "draft-")):
            continue
        relative = path.relative_to(models_dir) if path.is_relative_to(models_dir) else path
        display = f"[本地] {relative.as_posix()}"
        models.append({"display": display, "name": path.name, "path": str(path)})
        if verify_projectors:
            pairings[display] = [str(item) for item in projectors if _projector_matches(path, item)]
    selected = next((entry["display"] for entry in models if entry["name"] == DEFAULT_MODEL), "")
    selected_projector = next((str(path) for path in projectors if path.name == DEFAULT_PROJECTOR), "")
    ready = _runtime_executable().is_file()
    return {
        "ok": True, "dependency_installed": ready,
        "dependency_error": "" if ready else "尚未安装导演台本地 llama.cpp 运行时。",
        "runtime_package_available": sys.platform == "win32",
        "selected_model": selected, "selected_mmproj": selected_projector,
        "preferred_filename": DEFAULT_MODEL, "preferred_mmproj_filename": DEFAULT_PROJECTOR,
        "installed": bool(selected), "mmproj_installed": bool(selected_projector),
        "model_url": MODEL_REPO + DEFAULT_MODEL, "mmproj_url": MODEL_REPO + DEFAULT_PROJECTOR,
        "models": models,
        "mmproj_models": [{"name": path.name, "path": str(path)} for path in projectors],
        "projectors_by_model": pairings,
        "pairings_verified": verify_projectors,
    }


def _download(url, destination, expected, task_id, label):
    digest = hashlib.sha256()
    written = 0
    last_percent = -1
    with urllib.request.urlopen(url, timeout=60) as response, destination.open("wb") as stream:
        total = int(response.headers.get("Content-Length") or 0)
        while chunk := response.read(1024 * 1024):
            stream.write(chunk)
            digest.update(chunk)
            written += len(chunk)
            if total:
                percent = min(99, written * 100 // total)
                if percent != last_percent:
                    _storyboard_progress(task_id, label, percent)
                    last_percent = percent
    if digest.hexdigest() != expected:
        raise ValueError(f"{label}的文件校验失败。")


def _install_resource(kind, task_id):
    with _INSTALL_LOCK:
        if kind == "runtime":
            if _runtime_executable().is_file():
                return
            if sys.platform != "win32":
                raise ValueError("当前内置运行时支持 Windows x64。")
            RUNTIME_DIRECTORY.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(dir=RUNTIME_DIRECTORY.parent) as temp:
                directory = Path(temp)
                archive = directory / "runtime.zip"
                _download(RUNTIME_URL, archive, RUNTIME_SHA256, task_id, "下载本地运行时")
                staged = directory / "files"
                staged.mkdir()
                with zipfile.ZipFile(archive) as bundle:
                    for member in bundle.infolist():
                        name = Path(member.filename).name
                        if member.is_dir() or not name or not (
                            name == "llama-server.exe" or name.endswith(".dll") or name.startswith("LICENSE")
                        ):
                            continue
                        with bundle.open(member) as source, (staged / name).open("wb") as target:
                            shutil.copyfileobj(source, target)
                if not (staged / "llama-server.exe").is_file():
                    raise ValueError("运行时压缩包中缺少 llama-server.exe。")
                _download(RUNTIME_LICENSE_URL, staged / "LICENSE-llama.cpp", RUNTIME_LICENSE_SHA256, "", "下载运行时许可证")
                staged.rename(RUNTIME_DIRECTORY)
            return
        if kind not in MODEL_DOWNLOADS:
            raise ValueError("未知的模型资源。")
        filename, digest = MODEL_DOWNLOADS[kind]
        directory = Path(folder_paths.models_dir) / "llm"
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / filename
        if target.is_file():
            if _sha256(target) != digest:
                raise ValueError(f"{filename} 已存在且与推荐文件不同，请确认现有文件。")
            return
        with tempfile.TemporaryDirectory(dir=directory) as temp:
            staged = Path(temp) / filename
            _download(MODEL_REPO + filename, staged, digest, task_id, f"下载 {filename}")
            staged.rename(target)


def _optimizer_file(name):
    relative, directory = folder_paths.annotated_filepath(str(name or ""))
    base = Path(directory or folder_paths.get_input_directory()).resolve()
    path = (base / relative).resolve()
    if not path.is_relative_to(base) or not path.is_file():
        raise FileNotFoundError(f"找不到分镜素材：{name}")
    return path


def _story_free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def _story_server_request(url, payload=None, timeout=5):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=timeout) as response:
        return json.load(response)


def _release_story_llm_runtime():
    global _process
    with _PROCESS_LOCK:
        process, _process = _process, None
    if process and process.poll() is None:
        process.terminate()
        try:
            process.wait(5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def _start_story_llm_server(model_path, context_length, task_id, mmproj_path, gpu_layers):
    global _process
    executable = _runtime_executable()
    if not executable.is_file():
        raise ValueError("请先安装导演台本地 llama.cpp 运行时。")
    port = _story_free_port()
    command = [
        str(executable), "--offline", "-m", str(model_path), "--host", "127.0.0.1", "--port", str(port),
        "-ngl", "auto" if gpu_layers < 0 else str(gpu_layers), "-c", str(context_length),
        "-b", str(min(2048, context_length)), "-ub", str(min(512, context_length)),
        "-fa", "on", "--jinja", "--no-webui",
    ]
    if mmproj_path:
        command.extend(["--mmproj", str(mmproj_path)])
    with tempfile.TemporaryFile(mode="w+b") as log:
        with _PROCESS_LOCK:
            if _OPTIMIZER_CANCELLED.is_set():
                raise InterruptedError("提示词优化已取消。")
            process = _process = subprocess.Popen(
                command, cwd=executable.parent, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        started = time.monotonic()
        last_update = 0
        while (elapsed := time.monotonic() - started) < 180:
            if _OPTIMIZER_CANCELLED.is_set():
                raise InterruptedError("提示词优化已取消。")
            if process.poll() is not None:
                log.seek(max(0, os.fstat(log.fileno()).st_size - 6000))
                lines = log.read().decode("utf-8", "replace").strip().splitlines()
                raise RuntimeError("本地模型加载失败：" + "；".join(lines[-10:]))
            try:
                if _story_server_request(f"http://127.0.0.1:{port}/health", timeout=1).get("status") == "ok":
                    return port
            except (URLError, TimeoutError, ConnectionError):
                pass
            if elapsed >= last_update:
                _storyboard_progress(task_id, "加载本地模型", 20 + min(30, int(elapsed / 3)), f"{model_path.name} · {elapsed:.0f} 秒")
                last_update += 4
            time.sleep(0.2)
    raise RuntimeError("本地模型加载超时（180 秒）。")


def _mode_instruction(mode, skill):
    mode_notes = {
        "T2VA": "This is text-to-video. Describe every visible subject and the complete temporal action.",
        "I2VA": "This is first-frame image-to-video. Preserve the identity, clothing, composition, and scene established by every @ reference.",
        "FL2VA": "This is first-and-last-frame video. Describe a plausible continuous transition between the referenced boundary frames.",
        "REF2VA": "This is reference generation. Preserve every referenced subject and use each @ image, video, or audio tag exactly as written.",
        "SWAPVA": "This is character replacement. Preserve source motion, timing, camera, background, and audio while maintaining replacement identity.",
        "EDITVA": "This is localized video editing. Preserve every unedited time range and change only the explicitly requested subjects, regions, or intervals.",
    }
    skill_notes = {
        "standard": "Balance subject, action, environment, camera, lighting, atmosphere, timing, and synchronized sound.",
        "motion": "Prioritize precise body mechanics, action order, speed, contact, and physically plausible motion.",
        "camera": "Prioritize shot size, camera height, lens feeling, movement path, speed, stabilization, and composition changes.",
        "identity": "Prioritize stable facial identity, hairstyle, body shape, clothing, props, and continuity; never invent identity changes.",
        "audio": "Prioritize synchronized dialogue, ambience, Foley, music cues, and their timing without adding visible speakers.",
    }
    return (
        f"{mode_notes.get(mode, mode_notes['T2VA'])} "
        f"{skill_notes.get(skill, skill_notes['standard'])} "
        "Keep all <Picture N>, <Video N>, and <Audio N> material tags verbatim. Return only one final production-ready MiniMax H3 prompt."
    )


def _official_h3_prompt_contract(mode, duration, output_language="en"):
    mode = str(mode or "T2VA").upper()
    duration_text = f"{float(duration):.2f}"
    prompt_language = "English" if str(output_language).lower() == "en" else "Simplified Chinese"
    chinese_output = prompt_language == "Simplified Chinese"
    shared = (
        f"The final prompt is {prompt_language}, while dialogue, lyrics, and visible scene text stay verbatim in their original language. "
        "Every prompt must contain [Shot 1] without a timestamp. Later cuts use sequential [Shot N] At 00:SS.mmm timestamps that strictly increase and remain inside the requested duration. "
        "Each shot describes composition, subject appearance and position, environment, lighting, observable action progression, reactions, camera movement, and synchronized diegetic sound. "
        "Camera movement is natural prose using motion type plus meaningful amplitude and speed. Use stable (S1), (S2) speaker IDs; keep only the untouched utterance inside <d>[Language] ...</d>. "
        "Use <scenetrans> only for speech crossing a cut and <cutoff> only for intentional truncation at the video end. Preserve visible text exactly inside double quotes. "
        "overall_soundscape is one paragraph of ambience, physical sounds, and non-verbal human sounds without repeating dialogue. non_diegetic_music describes only audience-only score instrumentation, tempo, rhythm, and dynamics, or N/A."
    )
    if mode == "T2VA":
        specific = (
            "T2VA has no image-alignment preamble and starts directly with integrated_multimodal_description:. "
            "Build the complete audiovisual timeline from the supplied text."
        )
    elif mode == "I2VA":
        specific = (
            "首行用中文明确说明目标视频在 0.00 秒完整参考 <Picture 1>（来自 [Shot 1]），然后空一行。将 Picture 1 作为真实首帧，保持身份、服装、色彩、构图、场景锚点、关键物体与空间关系，再向后发展动作起始、连续过程和可见结果或反应。"
            if chinese_output else
            "The exact first line must be: For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced. Then leave one blank line. Establish Picture 1 as the actual first frame, preserve identity, clothing, colors, composition, scene anchors, key objects, and spatial relationships, then develop forward through action onset, continuous development, and a visible result or reaction."
        )
    elif mode == "FL2VA":
        specific = (
            f"首行用中文明确说明参考图与目标视频的时间对齐：<Picture 1>（来自 [Shot 1]）对应 0.00 秒，<Picture 2> 对应 {duration_text} 秒，然后空一行。除非明确要求切镜，否则优先使用连续镜头；描述从首帧状态经过中间姿态、物体、构图、摄影机、场景和光线变化，直至末帧准确落到 Picture 2 的可见路径。"
            if chinese_output else
            f"The first line must use this exact template, replacing N with the actual final shot number: How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot N) aligns with the {duration_text}-second mark of the target video. Then leave one blank line. Prefer one continuous shot unless cuts were explicitly requested. Describe the observable path from the first-frame state through intermediate pose, object, composition, camera, scene, and lighting changes until the final state lands exactly on Picture 2."
        )
    else:
        specific = (
            "Use exactly six sections in this order: subject_definitions:, summary:, retention_analysis:, detailed_description:, overall_soundscape:, non_diegetic_music:. "
            "Define reusable visible people, objects, environments, clothing, styles, actions, expressions, and poses as stable <Subject N> units sourced from the supplied media. "
            "Use standalone <Picture N> only for a concrete keyframe/composition/storyboard anchor; <Video N> for editing, continuation, camera/cut/rhythm/temporal structure; and <Audio N> only for an explicitly enabled copied or referenced audio role. "
            "summary begins with the actual bracketed task combination chosen from keyframe completion, reference generation, video editing, video continuation, audio reuse, and audio reference. "
            "retention_analysis covers every used label with only the official relations fully_preserved, partially_preserved, attribute_transfer, weak_reference, fully_copy, partially_copy, or reference. "
            "detailed_description provides the full playback-order audiovisual timeline and cites each reference exactly where its role takes effect."
        )
    core = (
        "Use exactly three core sections in this order: integrated_multimodal_description:, overall_soundscape:, non_diegetic_music:. "
        if mode != "REF2VA" else ""
    )
    return f"{specific} {core}{shared}"


def _optimizer_image_url(image):
    from PIL import Image

    image = image.convert("RGB")
    image.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=88, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def _optimizer_media_content(materials, *, return_warnings=False, adaptive=False, max_visuals=12):
    from PIL import Image

    content = []
    visual_count = 0
    warnings = []
    for material in materials[:16]:
        if not isinstance(material, dict) or not material.get("file"):
            continue
        kind = str(material.get("kind") or "").lower()
        tag = str(material.get("h3_media_tag") or material.get("tag") or material.get("alias") or "<Material>")
        role = str(material.get("semantic_role") or material.get("role") or "")
        try:
            path = _optimizer_file(material["file"])
        except Exception as exc:
            warnings.append({"code": "MATERIAL_READ_FAILED", "tag": tag, "message": str(exc)})
            continue
        content.append({"type": "text", "text": f"Material {tag}: kind={kind}; semantic_role={role}. The semantic role is authoritative; never infer content or purpose from the filename."})
        if kind == "audio":
            content.append({"type": "text", "text": f"Audio {tag} was NOT listened to. Use only semantic_role={role} and supplied structured dialogue/delivery data; never infer voice or sound from its filename."})
        elif kind == "image" and visual_count < max_visuals:
            try:
                with Image.open(path) as image:
                    content.append({"type": "text", "text": f"Visual evidence: material_tag={tag}; frame=still; frame_index=0; approx_time_seconds=0."})
                    content.append({"type": "image_url", "image_url": {"url": _optimizer_image_url(image)}})
                visual_count += 1
            except Exception as exc:
                warnings.append({"code": "IMAGE_READ_FAILED", "tag": tag, "message": str(exc)})
        elif kind == "video" and visual_count < max_visuals:
            import cv2

            capture = cv2.VideoCapture(str(path))
            try:
                frame_count = max(1, int(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 1))
                fps = float(capture.get(cv2.CAP_PROP_FPS) or 24.0)
                wanted = 6 if adaptive else 3
                indices = [frame_count - 1] if material.get("tail_only") else sorted({
                    round((frame_count - 1) * step / max(1, wanted - 1)) for step in range(wanted)
                })
                succeeded = 0
                for position, frame_index in enumerate(indices):
                    if visual_count >= max_visuals:
                        break
                    capture.set(cv2.CAP_PROP_POS_FRAMES, frame_index)
                    ok, frame = capture.read()
                    if not ok:
                        warnings.append({"code": "VIDEO_FRAME_READ_FAILED", "tag": tag, "frame_index": frame_index, "message": f"{tag} 第 {frame_index} 帧读取失败。"})
                        continue
                    phase = "first" if position == 0 else ("last" if position == len(indices) - 1 else "middle")
                    approx_time = frame_index / fps if fps > 0 else 0.0
                    image = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
                    content.append({"type": "text", "text": f"Visual evidence: material_tag={tag}; frame={phase}; frame_index={frame_index}; approx_time_seconds={approx_time:.3f}."})
                    content.append({"type": "image_url", "image_url": {"url": _optimizer_image_url(image)}})
                    visual_count += 1
                    succeeded += 1
                if succeeded < len(indices):
                    warnings.append({"code": "VIDEO_EVIDENCE_PARTIAL", "tag": tag, "message": f"{tag} 计划读取 {len(indices)} 帧，实际成功 {succeeded} 帧。"})
            finally:
                capture.release()
    return (content, warnings) if return_warnings else content


def _normalize_h3_executable_structure(mode, prompt):
    """Repair deterministic H3 protocol wrappers without rewriting creative content."""
    text = str(prompt or "").strip()
    normalized_mode = str(mode or "").upper()
    reference_mode = normalized_mode in {"REF2VA", "SWAPVA", "EDITVA"}

    if not re.search(r"\[Shot\s+1\]", text, flags=re.I):
        heading = "detailed_description:" if reference_mode else "integrated_multimodal_description:"
        heading_index = text.find(heading)
        if heading_index >= 0:
            insert_at = heading_index + len(heading)
            text = text[:insert_at] + "\n[Shot 1]" + text[insert_at:]

    if reference_mode:
        summary_start = text.find("summary:")
        summary_end = text.find("retention_analysis:", summary_start + 1)
        if summary_start >= 0 and summary_end > summary_start:
            body_start = summary_start + len("summary:")
            summary_body = text[body_start:summary_end].strip()
            if summary_body and not summary_body.startswith("["):
                task_prefix = {
                    "SWAPVA": "[Subject replacement]",
                    "EDITVA": "[Video editing]",
                }.get(normalized_mode, "[Reference-driven video]")
                text = text[:body_start] + f"\n{task_prefix} " + text[body_start:].lstrip()

        retention_start = text.find("retention_analysis:")
        retention_end = text.find("detailed_description:", retention_start + 1)
        if retention_start >= 0 and retention_end > retention_start:
            retention = text[retention_start:retention_end]
            official_relations = "fully_preserved|partially_preserved|attribute_transfer|weak_reference|fully_copy|partially_copy|reference"
            repair_lines = []
            for tag in sorted(set(re.findall(r"<(?:Subject|Picture|Video|Audio)\s+\d+>", text))):
                has_relation = (
                    re.search(rf"{re.escape(tag)}[^\n]*:\s*[\[(`]*\s*(?:{official_relations})\b", retention, flags=re.I)
                    or re.search(rf"(?:{official_relations})\b[^\n]*{re.escape(tag)}", retention, flags=re.I)
                )
                if not has_relation:
                    relation = "fully_preserved" if tag.startswith("<Subject ") else "reference"
                    repair_lines.append(f"- {tag}: {relation}")
            if repair_lines:
                insert_at = retention_start + len("retention_analysis:")
                text = text[:insert_at] + "\n" + "\n".join(repair_lines) + text[insert_at:]
    return text


def _validate_h3_prompt(mode, prompt, duration, dialogue_source, material_map, protected_texts=None, strict_official=False):
    text = str(prompt or "").strip()
    errors, warnings = [], []
    normalized_mode = str(mode).upper()
    reference_mode = normalized_mode in {"REF2VA", "SWAPVA", "EDITVA"}
    base_titles = ["integrated_multimodal_description:", "overall_soundscape:", "non_diegetic_music:"]
    ref_titles = ["subject_definitions:", "summary:", "retention_analysis:", "detailed_description:", "overall_soundscape:", "non_diegetic_music:"]
    expected = ref_titles if reference_mode else base_titles
    positions = [text.find(title) for title in expected]
    found_titles = re.findall(r"(?m)^([a-z_]+):", text)
    if any(position < 0 for position in positions) or positions != sorted(positions) or found_titles != [title[:-1] for title in expected]:
        errors.append({"code": "H3_SECTION_ORDER", "field": "video_job.compiled_prompt_en", "message": "H3 段落缺失、重复或顺序错误。"})
    if not reference_mode and any(title in text for title in ref_titles[:4]):
        errors.append({"code": "H3_MODE_SECTIONS", "field": "video_job.compiled_prompt_en", "message": "Base 提示词包含参考模式专用段落。"})
    protected = list(protected_texts or [])
    protected.extend({"kind": "dialogue", "text": value} for value in dialogue_source or [])
    seen_texts = set()
    for item in protected:
        original = str(item.get("text") or "") if isinstance(item, dict) else str(item or "")
        expected_hash = str(item.get("sha256") or "") if isinstance(item, dict) else ""
        if original and expected_hash and hashlib.sha256(original.encode("utf-8")).hexdigest() != expected_hash:
            errors.append({"code": "PROTECTED_TEXT_HASH_INVALID", "field": "protected_texts", "message": "受保护文本的原文哈希已发生变化。"})
        if original and original not in seen_texts and original not in text:
            errors.append({"code": "PROTECTED_TEXT_CHANGED", "field": "protected_texts", "message": f"受保护的对白、歌词或可见文字未逐字保留：{original}"})
        seen_texts.add(original)
    stamps = re.findall(r"\[Shot\s+\d+\]\s+At\s+00:(\d{2})\.(\d{3})", text, flags=re.I)
    milliseconds = [int(seconds) * 1000 + int(ms) for seconds, ms in stamps]
    if milliseconds != sorted(set(milliseconds)) or any(value >= float(duration or 0) * 1000 for value in milliseconds):
        errors.append({"code": "H3_TIMESTAMP_RANGE", "field": "video_job.compiled_prompt_en", "message": "切镜时间戳未严格递增或超出时长。"})
    if re.search(r"\[Shot\s+1\]\s+At\s+", text, flags=re.I):
        errors.append({"code": "H3_FIRST_SHOT_TIMESTAMP", "field": "video_job.compiled_prompt_en", "message": "第一镜不得带 At 时间戳。"})
    if strict_official and not re.search(r"\[Shot\s+1\]", text, flags=re.I):
        errors.append({"code": "H3_FIRST_SHOT_MISSING", "field": "video_job.compiled_prompt_en", "message": "提示词缺少官方要求的 [Shot 1]。"})
    expected_tags = [str(item.get("h3_media_tag") or item.get("tag") or "") for item in material_map or [] if isinstance(item, dict)]
    actual_tags = re.findall(r"<(?:Picture|Video|Audio)\s+\d+>", text)
    missing_tags = sorted(set(expected_tags) - set(actual_tags))
    unknown_tags = sorted(set(actual_tags) - set(expected_tags))
    if missing_tags or unknown_tags:
        errors.append({"code": "MATERIAL_TAG_SET_CHANGED", "field": "video_job.material_manifest", "message": f"素材标签集合不一致；缺少={missing_tags}，凭空新增={unknown_tags}。"})
    if reference_mode and not material_map:
        errors.append({"code": "MATERIAL_ROLE_REQUIRED", "field": "asset_refs.materials", "message": f"{normalized_mode} 缺少已确认的素材用途映射。"})
    if reference_mode:
        retention = text[text.find("retention_analysis:"):text.find("detailed_description:")]
        tracked_labels = sorted(set(re.findall(r"<(?:Subject|Picture|Video|Audio)\s+\d+>", text)))
        official_relations = "fully_preserved|partially_preserved|attribute_transfer|weak_reference|fully_copy|partially_copy|reference"
        for tag in tracked_labels:
            if tag not in retention:
                errors.append({"code": "RETENTION_REFERENCE_MISSING", "field": "video_job.compiled_prompt_en", "message": f"retention_analysis 未覆盖 {tag}。"})
            elif strict_official and not (
                re.search(rf"{re.escape(tag)}[^\n]*:\s*[\[(`]*\s*(?:{official_relations})\b", retention, flags=re.I)
                or re.search(rf"(?:{official_relations})\b[^\n]*{re.escape(tag)}", retention, flags=re.I)
            ):
                errors.append({"code": "RETENTION_RELATION_INVALID", "field": "video_job.compiled_prompt_en", "message": f"retention_analysis 中 {tag} 没有使用官方关系标记。"})
        summary_body = text[text.find("summary:") + len("summary:"):text.find("retention_analysis:")].strip()
        if strict_official and not summary_body.startswith("["):
            errors.append({"code": "REF_SUMMARY_TASK_PREFIX", "field": "video_job.compiled_prompt_en", "message": "Ref2VA summary 必须以官方方括号任务类型开头。"})
    if text.startswith("```") or "```" in text or text.lower().startswith(("here is", "sure,", "note:")):
        errors.append({"code": "H3_COMMENTARY_FORBIDDEN", "field": "video_job.compiled_prompt_en", "message": "输出含 Markdown、前言或解释。"})
    if re.search(r"\b(?:i|we)\s+(?:heard|listened to|analyzed the audio)\b", text, flags=re.I):
        errors.append({"code": "AUDIO_EVIDENCE_FALSE_CLAIM", "field": "video_job.compiled_prompt_en", "message": "输出声称已听取音频，但后端未读取音频内容。"})
    if len(dialogue_source or []) > 1:
        warnings.extend([
            {"code": "VOICE_BLEED", "field": "dialogue", "message": "多人对白存在音色串用风险。"},
            {"code": "LIP_SPEAKER_MISMATCH", "field": "dialogue", "message": "多人对白存在发声者与张嘴者错位风险。"},
        ])
    return {"errors": errors, "warnings": warnings}


def _official_skill_text(mode):
    bundle = json.loads(Path(__file__).with_name("h3_prompt_writing.json").read_text(encoding="utf-8"))
    guide = "references/ref-en.txt" if str(mode).upper() in {"REF2VA", "SWAPVA", "EDITVA"} else "references/base-en.txt"
    return ("OFFICIAL H3 PROMPT-WRITING SKILL\n" + bundle["files"]["SKILL.md"]
            + "\nOFFICIAL MODE GUIDE: " + guide + "\n" + bundle["files"][guide]
            + "\nEND OFFICIAL GUIDE. Examples illustrate the format; write this user's actual scene, not the examples. ")


def _has_visual_prompt_body(prompt):
    """Recognize empty protocol scaffolding before any deterministic tag repairs."""
    text = str(prompt or "").strip()
    headings = r"subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music"
    match = re.search(r"(?:detailed_description|integrated_multimodal_description)\s*:", text, flags=re.I)
    body = text[match.end():] if match else text
    body = re.split(rf"(?:{headings})\s*:", body, maxsplit=1, flags=re.I)[0]
    body = re.sub(r"\[Shot\s+\d+\](?:\s+At\s+\d{2}:\d{2}\.\d{3})?|<(?:Subject|Picture|Video|Audio)\s+\d+>", "", body, flags=re.I)
    body = re.sub(r"\b(?:N/A|none|null|TBD)\b|待填写|待补充", "", body, flags=re.I)
    return bool(re.search(r"[A-Za-z\u3400-\u9fff]", body))


def _run_optimizer(payload):
    global _active_task
    with _OPTIMIZER_LOCK:
        _OPTIMIZER_CANCELLED.clear()
        _release_story_llm_runtime()
        task_id = _active_task = str(payload.get("task_id") or "")
        try:
            _storyboard_progress(task_id, "正在检查提示词模型", 8)
            catalog = _catalog()
            model_name = str(payload.get("model") or catalog["selected_model"])
            model = next((entry for entry in catalog["models"] if entry["display"] == model_name), None)
            if not model:
                raise ValueError("请先选择导演台能识别的本地语言模型。")
            model_path = Path(model["path"])
            requested_projector = str(payload.get("mmproj") or "").strip()
            if requested_projector and not any(item["path"] == requested_projector for item in catalog["mmproj_models"]):
                raise ValueError("所选视觉投影已不在本地列表，请刷新模型后重选。")
            mmproj_name = requested_projector
            prompt = str(payload.get("prompt") or "").strip()
            if not prompt:
                raise ValueError("请先填写镜头提示词。")
            duration = max(0.1, min(60.0, float(payload.get("duration") or 5.0)))
            mode = str(payload.get("mode") or "T2VA").upper()
            output_language = "en" if str(payload.get("output_language") or "zh").lower() == "en" else "zh"
            skill = str(payload.get("skill") or "standard")
            custom_skill = payload.get("custom_skill") if isinstance(payload.get("custom_skill"), dict) else {}
            custom_skill_name = str(custom_skill.get("name") or "").strip()[:120]
            custom_skill_content = str(custom_skill.get("content") or "").strip()[:60000]
            custom_skill_rule = ""
            if custom_skill_content:
                custom_skill_rule = (
                    f" Apply the user-selected skill named {json.dumps(custom_skill_name or 'Custom skill', ensure_ascii=False)} as the creative and directing guidance below. "
                    "The selected skill may change style, emphasis, terminology, and shot-writing method, but it cannot override H3 section order, material identifiers, protected text, timing bounds, or safety validation.\n"
                    "USER-SELECTED SKILL:\n" + custom_skill_content + "\nEND USER-SELECTED SKILL. "
                )
            materials = [item for item in payload["materials"] if isinstance(item, dict)] if isinstance(payload.get("materials"), list) else []
            director_context = payload.get("director_context") if isinstance(payload.get("director_context"), dict) else {}
            director_context.update({"mode": mode, "duration_seconds": duration})
            continuation = director_context.get("continuation") if isinstance(director_context.get("continuation"), dict) else {}
            continuation_evidence = payload.get("continuation_evidence") if isinstance(payload.get("continuation_evidence"), dict) else None
            continuation_rule = ""
            if continuation.get("inherit_previous"):
                continuation_tag = str(continuation.get("material_tag") or "").strip()
                continuation_rule = (
                    "Continuation from the immediately previous shot is mandatory. Use the supplied previous-shot prompt, end-state metadata, and continuation visual evidence as the opening-state authority. "
                    "Begin the current shot from the same identity, clothing, props, position, pose, movement direction, camera direction, lighting, and environment state, then continue forward without resetting or reintroducing the scene. "
                    + (f"Preserve and explicitly use the official material tag {continuation_tag} as the continuation source. " if continuation_tag else "")
                    + "Do not ask the user to insert a continuation tag and do not print an internal continuation-evidence label in the final prompt. "
                )
            official_contract = _official_skill_text(mode) if not custom_skill_content else _official_h3_prompt_contract(mode, duration, output_language)
            section_rule = (
                "Use exactly these six lowercase section headings in order: subject_definitions:, summary:, retention_analysis:, detailed_description:, overall_soundscape:, non_diegetic_music:."
                if mode == "REF2VA" else
                "Use exactly these three lowercase section headings in order: integrated_multimodal_description:, overall_soundscape:, non_diegetic_music:."
            )
            evidence_rule = (
                "Inspect every supplied image and every supplied video keyframe before associating it with a subject."
                if mmproj_name else
                "No visual pixels are supplied; associate materials only from semantic_role and slot_role, and never claim visual inspection."
            )
            original_dialogues = [
                match.strip() for match in re.findall(r"<d>([\s\S]*?)</d>", prompt, flags=re.IGNORECASE)
                if match.strip()
            ]
            silence_rule = (
                "The original prompt contains no dialogue markup. Do not add spoken dialogue, voice-over, lyrics, "
                "whispering, singing, or intelligible vocalization; visible characters remain silent with closed lips. "
                if not original_dialogues else ""
            )
            language_rule = (
                "Write every section body in natural, production-ready English. Keep the mandatory lowercase section headings exactly as specified. "
                if output_language == "en" else
                "Write every section body in natural, production-ready Simplified Chinese. Keep only the mandatory lowercase section-heading tokens in English so deterministic H3 validation remains possible. "
            )
            output_label = "English" if output_language == "en" else "Simplified Chinese"
            system_prompt = (
                "You are the Xiantu MiniMax H3 multimodal director prompt optimizer. "
                + _mode_instruction(mode, skill) + " "
                + custom_skill_rule
                + official_contract + " "
                + section_rule + " "
                + language_rule
                + continuation_rule
                + "Do not translate numbered material tags. Use the semantic role/name from the manifest when referring to a material; never output, preserve, or invent internal ASCII role identifiers such as hero_xxx, guard_xxx, or patrol_uniform. "
                f"The target is exactly {duration:.3f} seconds. " + evidence_rule + " "
                + silence_rule
                + "Treat the supplied semantic role map as authoritative. Preserve identity, clothing, props, composition, "
                "screen direction, source motion, source audio role, dialogue, visible text, and every numbered material tag exactly. "
                "Associate every supplied numbered material tag with the matching person, prop, environment, action, or sound role in the prompt. "
                "Use visual evidence to identify the match only when visual inputs are actually supplied; otherwise rely only on semantic_role and slot_role. "
                "Declare every supplied tag explicitly in subject_definitions and cover it in retention_analysis for reference modes. "
                "Describe observable action progression and separate subject motion, camera motion, and background motion. "
                "Apply the director_context camera request, composition, aspect ratio, timing, and enabled LoRA purposes without printing irrelevant sampler settings. Never invent a material or claim to hear audio. "
                "For audio references, preserve the alias and state its intended voice/sound role. Return only one final, "
                f"production-ready {output_label} prompt with timing that stays inside the target duration. Return exactly one prompt in the selected output language. No alternate-language copy, Markdown, or commentary. "
                "Write each section heading on its own line and fill its body. Never return only headings, labels, or a blank schema. "
                "Keep the user's concrete subjects, actions, objects, and scene requirements in the visual timeline; elaborate them instead of replacing them with protocol labels. "
                f"The selected output language is {output_label}; this overrides the guide's English-body default, while field names remain unchanged."
            )
            user_content = [{"type": "text", "text": f"Original director prompt:\n{prompt}"}]
            user_content.append({"type": "text", "text": "Authoritative material-role manifest:\n" + json.dumps(materials, ensure_ascii=False)})
            user_content.append({"type": "text", "text": "Authoritative director context:\n" + json.dumps(director_context, ensure_ascii=False)})
            # Every discovered language model can optimize the written prompt.
            # Images/video frames are attached only when a compatible visual
            # projector is selected; otherwise keep their numbered aliases in
            # text and do not pretend the model inspected their pixels.
            media_materials = materials if mmproj_name else [
                item for item in materials if str(item.get("kind") or "").lower() == "audio"
            ]
            user_content.extend(_optimizer_media_content(media_materials))
            if mmproj_name and continuation_evidence:
                evidence = dict(continuation_evidence)
                evidence["alias"] = "Previous-shot continuation evidence"
                user_content.extend(_optimizer_media_content([evidence], max_visuals=3))
            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ]
            has_visuals = any(item.get("type") == "image_url" for item in user_content)
            context_length = max(4096, min(32768, int(payload.get("context_length") or 8192)))
            _storyboard_progress(
                task_id, "正在准备提示词与素材", 12,
                f"{len(materials)} 个素材；{'视觉核对' if has_visuals else '纯文字优化'}",
            )
            gpu_layers = int(payload.get("gpu_layers", -1))
            try:
                port = _start_story_llm_server(
                    model_path, context_length,
                    task_id=task_id,
                    mmproj_path=Path(mmproj_name) if mmproj_name else None,
                    gpu_layers=gpu_layers,
                )
            except RuntimeError as first_error:
                lowered_error = str(first_error).lower()
                can_retry_cpu = gpu_layers != 0 and any(
                    token in lowered_error for token in (
                        "memory", "allocate", "cuda", "vulkan", "out of memory", "device lost",
                    )
                )
                if not can_retry_cpu:
                    raise
                logging.warning(
                    "[闲兔提示词优化] GPU运行时启动失败，自动改用CPU重试：%s", first_error,
                )
                _release_story_llm_runtime()
                port = _start_story_llm_server(
                    model_path, min(context_length, 8192),
                    task_id=task_id,
                    mmproj_path=Path(mmproj_name) if mmproj_name else None,
                    gpu_layers=0,
                )
            completion_payload = {
                "model": "xiantu-h3-multimodal-optimizer",
                "messages": messages,
                "max_tokens": int(payload.get("max_tokens") or 1200),
                "temperature": float(payload.get("temperature") or 0.25),
                "top_p": 0.9,
                "repeat_penalty": 1.05,
                "seed": int(payload.get("seed") or 1),
                "chat_template_kwargs": {"enable_thinking": False},
                "stream": False,
            }
            _storyboard_progress(task_id, "正在生成 H3 提示词", 56, model_path.name)
            result = _story_server_request(
                f"http://127.0.0.1:{port}/v1/chat/completions",
                completion_payload,
                timeout=600,
            )
            if _OPTIMIZER_CANCELLED.is_set():
                raise InterruptedError("提示词优化已取消。")
            message = result.get("choices", [{}])[0].get("message", {})
            text = str(message.get("content") or "").strip()
            if not text:
                reasoning = str(message.get("reasoning_content") or "").strip()
                first_heading = "subject_definitions:" if mode == "REF2VA" else "integrated_multimodal_description:"
                heading_index = reasoning.lower().find(first_heading)
                if heading_index >= 0:
                    text = reasoning[heading_index:].strip()
            if not _has_visual_prompt_body(text):
                logging.warning("[闲兔提示词优化] 模型首次返回空正文或空格式模板，保留原文并重试一次；模型=%s", model_path.name)
                retry_payload = dict(completion_payload)
                retry_payload["messages"] = messages + [{
                    "role": "user",
                    "content": ("The previous response had no usable visual timeline. Rewrite the ORIGINAL director prompt supplied above, "
                                "preserving its concrete subjects, actions, scene, and all material roles. "
                                "Fill the required sections with actual scene descriptions; detailed_description or integrated_multimodal_description "
                                "must describe the user's action progression and camera, not merely [Shot 1] or field names. "
                                "Do not output analysis or reasoning. Return the final prompt directly. /no_think"),
                }]
                retry_payload["temperature"] = 0.1
                retry_payload["max_tokens"] = min(4096, max(1536, int(completion_payload["max_tokens"])))
                retry_result = _story_server_request(
                    f"http://127.0.0.1:{port}/v1/chat/completions",
                    retry_payload,
                    timeout=600,
                )
                retry_message = retry_result.get("choices", [{}])[0].get("message", {})
                text = str(retry_message.get("content") or "").strip()
            if not _has_visual_prompt_body(text):
                raise ValueError("本地模型只返回空模板，未生成镜头正文；已保留原提示词，请重试优化。")
            _storyboard_progress(task_id, f"正在整理{'英文' if output_language == 'en' else '中文'}提示词格式", 82)
            dialogues = original_dialogues
            material_map = [
                {
                    "h3_media_tag": str(item.get("h3_media_tag") or item.get("tag") or ""),
                    "semantic_role": str(item.get("role") or ""),
                    "slot_role": str(item.get("slot_role") or ""),
                }
                for item in materials if isinstance(item, dict) and str(item.get("h3_media_tag") or item.get("tag") or "").strip()
            ]
            # Small local models occasionally preserve every numbered material
            # reference but lowercase its type (for example ``<picture 1>``).
            # H3 aliases are protocol identifiers, so restore the authoritative
            # manifest spelling before set validation instead of rejecting an
            # otherwise valid prompt as if every material were missing.
            for item in material_map:
                canonical_tag = item["h3_media_tag"]
                if canonical_tag:
                    text = re.sub(re.escape(canonical_tag), canonical_tag, text, flags=re.IGNORECASE)
            allowed_tags = {
                str(item["h3_media_tag"]).casefold()
                for item in material_map if str(item.get("h3_media_tag") or "").strip()
            }
            original_tags = {
                tag.casefold()
                for tag in re.findall(r"<(?:Picture|Video|Audio)\s+\d+>", prompt, flags=re.IGNORECASE)
            }
            generated_tags = re.findall(r"<(?:Picture|Video|Audio)\s+\d+>", text, flags=re.IGNORECASE)
            invented_tags = sorted({
                tag for tag in generated_tags
                if tag.casefold() not in allowed_tags and tag.casefold() not in original_tags
            })
            for invented_tag in invented_tags:
                text = re.sub(re.escape(invented_tag), "", text, flags=re.IGNORECASE)
            if invented_tags:
                logging.warning(
                    "[闲兔提示词优化] 已删除模型凭空新增的素材标签：%s",
                    "、".join(invented_tags),
                )
            missing_materials = [
                item for item in material_map
                if item["h3_media_tag"].casefold() not in text.casefold()
            ]
            if missing_materials:
                # Small local models sometimes produce a valid H3 structure but
                # omit the manifest sentence. Repair only that deterministic
                # sentence; never ask the model to invent what a material is.
                binding_text = "; ".join(
                    (
                        f'{item["h3_media_tag"]} 对应 {item["semantic_role"] or item["slot_role"] or "参考素材"}'
                        if output_language == "zh" else
                        f'{item["h3_media_tag"]} is {item["semantic_role"] or item["slot_role"] or "reference material"}'
                    )
                    for item in missing_materials
                )
                binding_label = "素材绑定" if output_language == "zh" else "Material bindings"
                if mode == "REF2VA":
                    heading = "retention_analysis:"
                    heading_index = text.casefold().find(heading)
                    if heading_index >= 0:
                        insert_at = heading_index + len(heading)
                        text = text[:insert_at] + f"\n{binding_label}: {binding_text}." + text[insert_at:]
                else:
                    next_heading = "overall_soundscape:"
                    heading_index = text.casefold().find(next_heading)
                    if heading_index >= 0:
                        text = (
                            text[:heading_index].rstrip()
                            + f"\n{binding_label}: {binding_text}.\n"
                            + text[heading_index:].lstrip()
                        )
                logging.info(
                    "[闲兔提示词优化] 已按确定性素材清单补回 %d 个遗漏标签。",
                    len(missing_materials),
                )
            # Formatting gaps from small local models are repaired
            # deterministically. They must not discard an otherwise usable
            # optimization result or force the user to run optimization again.
            text = _normalize_h3_executable_structure(mode, text)
            validation = _validate_h3_prompt(mode, text, duration, dialogues, material_map)
            validation_warnings = [
                str(item.get("message") or item.get("code"))
                for item in validation.get("errors") or []
            ]
            if validation_warnings:
                logging.warning(
                    "[闲兔提示词优化] H3 格式仍有提示，但不再阻止保存：%s",
                    "; ".join(validation_warnings),
                )
            _storyboard_progress(task_id, "提示词优化完成", 100)
            return {
                "prompt": text,
                "output_language": output_language,
                "validation_warnings": validation_warnings,
                "optimizer_version": PROMPT_OPTIMIZER_VERSION,
                "skill_source": custom_skill_name or PROMPT_SKILL_SOURCE,
            }
        finally:
            _active_task = ""
            if task_id:
                _storyboard_progress(task_id, "正在卸载语言模型并释放缓存", 97)
            _release_story_llm_runtime()


@PromptServer.instance.routes.get(f"{ROUTE}/models")
async def prompt_models(request):
    try:
        verify_projectors = request.query.get("inventory") != "1"
        return web.json_response(await asyncio.to_thread(_catalog, verify_projectors=verify_projectors))
    except (ValueError, OSError) as error:
        return web.json_response({"ok": False, "error": str(error)}, status=400)


@PromptServer.instance.routes.post(f"{ROUTE}/optimize")
async def optimize_prompt(request):
    try:
        result = await asyncio.to_thread(_run_optimizer, await request.json())
        return web.json_response({"ok": True, **result})
    except (ValueError, OSError, RuntimeError) as error:
        message = "提示词优化已取消。" if _OPTIMIZER_CANCELLED.is_set() else str(error)
        return web.json_response({"ok": False, "error": message}, status=400)


@PromptServer.instance.routes.post(f"{ROUTE}/cancel")
async def cancel_prompt(request):
    payload = await request.json()
    with _PROCESS_LOCK:
        task_id = str(payload.get("task_id") or "")
        cancelled = bool(task_id and task_id == _active_task)
        if cancelled:
            _OPTIMIZER_CANCELLED.set()
            if _process and _process.poll() is None:
                _process.terminate()
    return web.json_response({"ok": True, "cancelled": cancelled})


@PromptServer.instance.routes.post(f"{ROUTE}/resource")
async def install_prompt_resource(request):
    try:
        payload = await request.json()
        await asyncio.to_thread(_install_resource, payload["kind"], str(payload.get("task_id") or ""))
        return web.json_response({"ok": True})
    except (ValueError, OSError, KeyError, zipfile.BadZipFile) as error:
        return web.json_response({"ok": False, "error": str(error)}, status=400)
