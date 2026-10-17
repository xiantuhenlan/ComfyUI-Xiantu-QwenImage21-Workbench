"""Workbench-owned video face and scene-text repair.

These nodes deliberately live in XiantuQwenImage21Director.  They do not import
or execute another ComfyUI custom node.  The optional YOLO weights are loaded
directly by this module and all tracking, restoration, inpainting and compositing
is performed here.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import cv2
import comfy.model_management as model_management
import comfy.model_patcher
import comfy.storage
import comfy.utils
import folder_paths
import numpy as np
import torch
from comfy.utils import ProgressBar
from spandrel import ImageModelDescriptor, ModelLoader


FACE_MODEL_NAME = "face_yolov8m.pt"
PERSON_MODEL_NAME = "person_yolov8m-seg.pt"
FACE_RESTORE_MODEL_NAME = "GFPGANv1.4.pth"
FACE_MODEL_PATH = Path(folder_paths.models_dir) / "ultralytics" / "bbox" / FACE_MODEL_NAME
PERSON_MODEL_PATH = Path(folder_paths.models_dir) / "ultralytics" / "segm" / PERSON_MODEL_NAME
FACE_RESTORE_MODEL_PATH = Path(folder_paths.models_dir) / "facerestore" / FACE_RESTORE_MODEL_NAME
_YOLO_CACHE = {}
_YOLO_DEVICE_CACHE = {}
_FACE_RESTORER = None


def _settings(raw):
    try:
        value = json.loads(str(raw or "{}"))
    except (TypeError, json.JSONDecodeError) as error:
        raise ValueError("修复设置不是有效 JSON。") from error
    return value if isinstance(value, dict) else {}


def _to_numpy(images):
    return np.clip(images.detach().cpu().numpy()[..., :3] * 255.0, 0, 255).astype(np.uint8)


def _to_tensor(frames, source):
    result = torch.from_numpy(np.ascontiguousarray(frames)).to(dtype=torch.float32).div_(255.0)
    return result.to(device=source.device)


def _load_yolo(path: Path, label: str):
    if not path.is_file():
        raise FileNotFoundError(
            f"缺少{label}模型：{path.name}\n请放到：{path}\n"
            "模型只由闲兔插件直接读取，不需要安装或调用其他 ComfyUI 插件。"
        )
    key = str(path.resolve())
    if key not in _YOLO_CACHE:
        try:
            from ultralytics import YOLO
        except ImportError as error:
            raise RuntimeError("当前 Python 缺少 ultralytics，请在 ComfyUI 环境安装：pip install ultralytics") from error
        _YOLO_CACHE[key] = YOLO(key)
    return _YOLO_CACHE[key]


def _load_face_restorer():
    global _FACE_RESTORER
    if _FACE_RESTORER is not None:
        return _FACE_RESTORER
    if not FACE_RESTORE_MODEL_PATH.is_file():
        raise FileNotFoundError(
            f"缺少生成式人脸恢复模型：{FACE_RESTORE_MODEL_NAME}\n"
            f"请放到：{FACE_RESTORE_MODEL_PATH}"
        )
    state_dict = comfy.utils.load_torch_file(str(FACE_RESTORE_MODEL_PATH), safe_load=True)
    descriptor = ModelLoader().load_from_state_dict(state_dict).eval()
    if not isinstance(descriptor, ImageModelDescriptor) or descriptor.purpose != "FaceSR":
        raise RuntimeError(f"{FACE_RESTORE_MODEL_NAME} 不是可用的人脸恢复模型")
    descriptor.patcher = comfy.model_patcher.CoreModelPatcher(
        descriptor.model,
        load_device=model_management.get_torch_device(),
        offload_device=model_management.unet_offload_device(),
        fast_disk=comfy.storage.state_dict_fast_disk(state_dict),
    )
    _FACE_RESTORER = descriptor
    return descriptor


def _boxes(model, frame, confidence, classes=None, imgsz=1280, max_det=300):
    key = id(model)
    device = _YOLO_DEVICE_CACHE.get(key, 0 if torch.cuda.is_available() else "cpu")
    try:
        result = model.predict(
            frame,
            conf=float(confidence),
            classes=classes,
            imgsz=int(imgsz),
            max_det=int(max_det),
            agnostic_nms=True,
            verbose=False,
            device=device,
        )[0]
        _YOLO_DEVICE_CACHE[key] = device
    except RuntimeError:
        if device == "cpu":
            raise
        torch.cuda.empty_cache()
        _YOLO_DEVICE_CACHE[key] = "cpu"
        result = model.predict(
            frame,
            conf=float(confidence),
            classes=classes,
            imgsz=int(imgsz),
            max_det=int(max_det),
            agnostic_nms=True,
            verbose=False,
            device="cpu",
        )[0]
    if result.boxes is None or len(result.boxes) == 0:
        return []
    xyxy = result.boxes.xyxy.detach().cpu().numpy()
    scores = result.boxes.conf.detach().cpu().numpy()
    return [([float(v) for v in box], float(score)) for box, score in zip(xyxy, scores)]


def _iou(a, b):
    x1, y1, x2, y2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    intersection = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    area_a = max(1.0, (a[2] - a[0]) * (a[3] - a[1]))
    area_b = max(1.0, (b[2] - b[0]) * (b[3] - b[1]))
    return intersection / max(1.0, area_a + area_b - intersection)


def _dedupe_boxes(items, overlap=0.45):
    """Keep high confidence boxes while removing duplicate face/head proposals."""
    kept = []
    for box, score in sorted(items, key=lambda item: item[1], reverse=True):
        if any(_iou(box, previous) >= overlap for previous, _ in kept):
            continue
        kept.append((box, score))
    return kept


def _head_boxes_from_people(people, existing_faces):
    """Convert every detected person to a conservative head proposal.

    This is intentionally run even when some faces were found: crowded frames
    commonly contain one detectable foreground face and many tiny missed faces.
    """
    proposals = []
    for person, score in people:
        px1, py1, px2, py2 = person
        pw, ph = px2 - px1, py2 - py1
        if pw <= 4 or ph <= 12:
            continue
        head = [px1 + pw * .20, py1 + ph * .015, px2 - pw * .20, py1 + ph * .285]
        if any(_iou(head, face) >= .08 for face, _ in existing_faces):
            continue
        proposals.append((head, score * .72))
    return proposals


def _track_boxes(detections, max_gap=5):
    tracks = []
    for frame_index, frame_boxes in enumerate(detections):
        candidates = [(score, box) for box, score in frame_boxes]
        used = set()
        for track in tracks:
            if frame_index - track["last"] > max_gap:
                continue
            previous = track["boxes"][track["last"]]
            best = None
            for index, (score, box) in enumerate(candidates):
                if index in used:
                    continue
                overlap = _iou(previous, box)
                pcx, pcy = (previous[0] + previous[2]) / 2, (previous[1] + previous[3]) / 2
                cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
                scale = max(previous[2] - previous[0], previous[3] - previous[1], 1.0)
                distance = math.hypot(cx - pcx, cy - pcy) / scale
                affinity = overlap - 0.12 * distance
                if (overlap >= 0.08 or distance <= 1.2) and (best is None or affinity > best[0]):
                    best = (affinity, index, box)
            if best is not None:
                used.add(best[1]); track["boxes"][frame_index] = best[2]; track["last"] = frame_index
        for index, (_, box) in enumerate(candidates):
            if index not in used:
                tracks.append({"boxes": {frame_index: box}, "last": frame_index})
    return tracks


def _smooth_track(track, frame_count):
    keys = sorted(track["boxes"])
    if not keys:
        return {}
    values = np.asarray([track["boxes"][key] for key in keys], np.float32)
    all_frames = np.arange(keys[0], keys[-1] + 1)
    interpolated = np.stack([np.interp(all_frames, keys, values[:, index]) for index in range(4)], axis=1)
    smoothed = interpolated.copy()
    for index in range(len(interpolated)):
        lo, hi = max(0, index - 2), min(len(interpolated), index + 3)
        smoothed[index] = np.median(interpolated[lo:hi], axis=0)
    return {int(frame): box.tolist() for frame, box in zip(all_frames, smoothed) if 0 <= frame < frame_count}


def _expanded_square(box, width, height, factor):
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    size = max(box[2] - box[0], box[3] - box[1]) * factor
    x1, y1 = max(0, int(round(cx - size / 2))), max(0, int(round(cy - size / 2)))
    x2, y2 = min(width, int(round(cx + size / 2))), min(height, int(round(cy + size / 2)))
    return x1, y1, x2, y2


def _restore_face(crop, strength):
    if crop.size == 0:
        return crop
    h, w = crop.shape[:2]
    scale = max(2.0, min(5.0, 480.0 / max(24.0, min(h, w))))
    large = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    lab = cv2.cvtColor(large, cv2.COLOR_RGB2LAB)
    l, a, b = cv2.split(lab)
    clip = 1.2 + 1.8 * strength
    l = cv2.createCLAHE(clipLimit=clip, tileGridSize=(8, 8)).apply(l)
    enhanced = cv2.cvtColor(cv2.merge((l, a, b)), cv2.COLOR_LAB2RGB)
    smooth = cv2.bilateralFilter(enhanced, 0, 3 + 5 * strength, 3 + 5 * strength)
    sharp = cv2.addWeighted(enhanced, 1.0 + 0.9 * strength, smooth, -0.9 * strength, 0)
    return cv2.resize(sharp, (w, h), interpolation=cv2.INTER_AREA)


def _restore_face_generative(crop, strength, restorer):
    """Run GFPGAN on one localized face crop and mix by user strength."""
    if crop.size == 0:
        return crop
    height, width = crop.shape[:2]
    resized = cv2.resize(crop, (512, 512), interpolation=cv2.INTER_LANCZOS4)
    tensor = torch.from_numpy(np.ascontiguousarray(resized)).to(
        device=restorer.patcher.load_device,
        dtype=torch.float32,
    ).permute(2, 0, 1).unsqueeze(0).div_(255.0)
    with torch.inference_mode():
        generated = restorer(tensor).squeeze(0).permute(1, 2, 0).detach().float().cpu().numpy()
    generated = np.clip(generated * 255.0, 0, 255).astype(np.uint8)
    generated = cv2.resize(generated, (width, height), interpolation=cv2.INTER_AREA)
    # Keep some source colour/lighting and use the control as true model weight.
    amount = 0.45 + 0.55 * float(strength)
    return cv2.addWeighted(generated, amount, crop, 1.0 - amount, 0)


def _blend_face(frame, restored, face_box, crop_box, strength):
    x1, y1, x2, y2 = crop_box
    if x2 <= x1 or y2 <= y1:
        return
    fh, fw = y2 - y1, x2 - x1
    mask = np.zeros((fh, fw), np.float32)
    fx1 = max(0, int(face_box[0] - x1)); fy1 = max(0, int(face_box[1] - y1))
    fx2 = min(fw, int(face_box[2] - x1)); fy2 = min(fh, int(face_box[3] - y1))
    if fx2 <= fx1 or fy2 <= fy1:
        return
    center = ((fx1 + fx2) // 2, (fy1 + fy2) // 2)
    axes = (max(2, int((fx2 - fx1) * 0.62)), max(2, int((fy2 - fy1) * 0.75)))
    cv2.ellipse(mask, center, axes, 0, 0, 360, 1.0, -1)
    sigma = max(2.0, min(fw, fh) * 0.045)
    mask = cv2.GaussianBlur(mask, (0, 0), sigmaX=sigma, sigmaY=sigma)[..., None]
    mask *= 0.45 + 0.5 * strength
    source = frame[y1:y2, x1:x2].astype(np.float32)
    frame[y1:y2, x1:x2] = np.clip(source * (1.0 - mask) + restored.astype(np.float32) * mask, 0, 255).astype(np.uint8)


class XiantuVideoFaceRepair:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"images": ("IMAGE",), "settings": ("STRING", {"default": "{}", "multiline": True})}}

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("修复后画面", "处理报告")
    FUNCTION = "run"
    CATEGORY = "闲兔/视频编辑/修复"

    def run(self, images, settings="{}"):
        config = _settings(settings)
        if not bool(config.get("enabled", True)):
            return images, "人脸修复未启用"
        frames = _to_numpy(images)
        progress = ProgressBar(1000)
        progress.update_absolute(1)
        face_model = _load_yolo(FACE_MODEL_PATH, "远景人脸检测")
        progress.update_absolute(50)
        confidence = max(0.05, min(0.95, float(config.get("confidence", 0.25))))
        detection_size = max(640, min(1536, int(config.get("detectionSize", 1280))))
        maximum_faces = max(20, min(500, int(config.get("maximumFaces", 300))))
        person_model = _load_yolo(PERSON_MODEL_PATH, "人物兜底检测") if bool(config.get("personFallback", True)) else None
        progress.update_absolute(80)
        detections = []
        frame_total = max(1, len(frames))
        for index, frame in enumerate(frames):
            frame_boxes = _boxes(face_model, frame, confidence, imgsz=detection_size, max_det=maximum_faces)
            detections.append(frame_boxes)
            progress.update_absolute(80 + round(240 * (index + 1) / frame_total))
        if person_model is not None:
            person_confidence = max(0.05, confidence * .72)
            for index, frame_boxes in enumerate(detections):
                people = _boxes(
                    person_model,
                    frames[index],
                    person_confidence,
                    classes=[0],
                    imgsz=detection_size,
                    max_det=maximum_faces,
                )
                frame_boxes.extend(_head_boxes_from_people(people, frame_boxes))
                detections[index] = _dedupe_boxes(frame_boxes)
                progress.update_absolute(320 + round(130 * (index + 1) / frame_total))
        else:
            progress.update_absolute(450)
        tracks = _track_boxes(detections)
        progress.update_absolute(480)
        # A tiny background face may only be detectable in one frame.  Keep
        # those tracks for "全部人脸" instead of silently discarding them.
        minimum = max(1, int(config.get("minimumFrames", 2)))
        if str(config.get("target", "全部人脸")) == "全部人脸":
            minimum = 1
        tracks = [track for track in tracks if len(track["boxes"]) >= minimum]
        target = str(config.get("target", "全部人脸"))
        if target == "主要人物" and tracks:
            tracks = [max(tracks, key=lambda item: sum((b[2] - b[0]) * (b[3] - b[1]) for b in item["boxes"].values()))]
        strength = max(0.0, min(1.0, float(config.get("strength", 0.65))))
        factor = max(1.25, min(4.0, float(config.get("cropFactor", 2.25))))
        restorer = _load_face_restorer()
        memory_required = 512 * 512 * 3 * 4 * 512
        model_management.load_models_gpu([restorer.patcher], memory_required=memory_required, force_full_load=True)
        repaired = frames.copy()
        face_count = 0
        jobs_by_frame = {index: [] for index in range(len(frames))}
        for track in tracks:
            for frame_index, face_box in _smooth_track(track, len(frames)).items():
                jobs_by_frame[frame_index].append(face_box)
        progress.update_absolute(550)
        for frame_index in range(len(frames)):
            for face_box in jobs_by_frame[frame_index]:
                # GFPGAN is trained on aligned, tightly framed faces.  Keep the
                # detected face large in its 512px input instead of sending a
                # mostly-background 2.25x crop.
                crop_box = _expanded_square(face_box, frames.shape[2], frames.shape[1], min(factor, 1.65))
                x1, y1, x2, y2 = crop_box
                restored = _restore_face_generative(frames[frame_index, y1:y2, x1:x2], strength, restorer)
                _blend_face(repaired[frame_index], restored, face_box, crop_box, strength)
                face_count += 1
            progress.update_absolute(550 + round(430 * (frame_index + 1) / frame_total))
        result = _to_tensor(repaired, images)
        progress.update_absolute(1000)
        return result, f"GFPGAN 已跟踪 {len(tracks)} 人，共生成式修复 {face_count} 帧人脸"

NODE_CLASS_MAPPINGS = {
    "XiantuVideoFaceRepair": XiantuVideoFaceRepair,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiantuVideoFaceRepair": "闲兔｜远景人脸修复",
}
