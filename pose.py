import asyncio
import posixpath
import threading
from datetime import datetime
from pathlib import Path
from uuid import uuid4

import folder_paths
import numpy as np
import torch
from PIL import Image
from aiohttp import web
from server import PromptServer


OUTPUT_SUBFOLDER = "xiantu_pose_extractions"
_POSE_LOCK = threading.Lock()


def _get_dwpose_detector():
    try:
        import comfy.model_management as model_management
        from custom_controlnet_aux.dwpose import DwposeDetector
    except ImportError as error:
        raise RuntimeError(
            "没有找到 DWPose Estimator。请确认 comfyui_controlnet_aux 已安装并成功加载。"
        ) from error
    return DwposeDetector.from_pretrained(
        "hr16/DWPose-TorchScript-BatchSize5",
        "yzd-v/DWPose",
        det_filename="yolox_l.onnx",
        pose_filename="dw-ll_ucoco_384_bs5.torchscript.pt",
        torchscript_device=model_management.get_torch_device(),
    )


def _run_dwpose(image, detail="body_hand", resolution=768):
    settings = {
        "body": ("disable", "disable"),
        "body_hand": ("enable", "disable"),
        "full": ("enable", "enable"),
    }
    if detail not in settings:
        raise ValueError("姿势检测范围无效。")
    detect_hand, detect_face = settings[detail]
    detect_resolution = max(256, min(2048, int(resolution)))
    with _POSE_LOCK:
        detector = _get_dwpose_detector()
        results = []
        for tensor_image in image:
            np_image = np.asarray(tensor_image.cpu() * 255.0, dtype=np.uint8)
            np_result = detector(
                np_image,
                output_type="np",
                detect_resolution=detect_resolution,
                include_body=True,
                include_hand=detect_hand == "enable",
                include_face=detect_face == "enable",
                xinsr_stick_scaling=False,
            )
            results.append(torch.from_numpy(np_result.astype(np.float32) / 255.0))
        del detector
    if not results:
        raise RuntimeError("DWPose 没有返回姿势图。")
    return torch.stack(results)


def _save_pose_image(pose_image):
    output_root = Path(folder_paths.get_output_directory())
    output_folder = output_root / OUTPUT_SUBFOLDER
    output_folder.mkdir(parents=True, exist_ok=True)
    filename = (
        f"pose_{datetime.now().strftime('%Y%m%d_%H%M%S_%f')}_"
        f"{uuid4().hex[:8]}.png"
    )
    array = pose_image[0].detach().cpu().numpy()
    array = np.clip(array * 255.0, 0, 255).astype(np.uint8)
    if array.ndim != 3 or array.shape[-1] not in (3, 4):
        raise RuntimeError("DWPose 返回了无法保存的图片格式。")
    Image.fromarray(array).save(output_folder / filename, format="PNG")
    return {
        "filename": filename,
        "subfolder": OUTPUT_SUBFOLDER,
        "type": "output",
    }


def _extract_and_save(image, detail="body_hand", resolution=768):
    pose_image = _run_dwpose(image, detail, resolution)
    saved = _save_pose_image(pose_image)
    return pose_image, saved


def _input_asset_path(asset):
    if not isinstance(asset, dict) or str(asset.get("type", "input")) != "input":
        raise ValueError("姿势来源必须是 ComfyUI input 图片。")
    name = str(asset.get("name", "")).replace("\\", "/").strip("/")
    subfolder = str(asset.get("subfolder", "")).replace("\\", "/").strip("/")
    relative = posixpath.normpath(posixpath.join(subfolder, name) if subfolder else name)
    if (
        not relative
        or relative in {".", ".."}
        or relative.startswith("../")
        or relative.startswith("/")
        or ":" in relative
    ):
        raise ValueError("姿势来源图片路径无效。")
    if not folder_paths.exists_annotated_filepath(relative):
        raise ValueError(f"姿势来源图片不存在：{relative}")
    return relative


def _load_input_asset(asset):
    import nodes as comfy_nodes

    relative = _input_asset_path(asset)
    image, _mask = comfy_nodes.LoadImage().load_image(relative)
    return image


class XiantuPoseExtractor:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "检测范围": (["身体+手部", "仅身体", "身体+手部+面部"],),
                "分辨率": (
                    "INT",
                    {"default": 768, "min": 256, "max": 2048, "step": 64},
                ),
            }
        }

    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("姿势图", "输出文件")
    FUNCTION = "extract"
    CATEGORY = "闲兔/Qwen Image 2.1"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "使用已安装的 DWPose 提取姿势，并将 PNG 保存到 "
        "ComfyUI/output/xiantu_pose_extractions。"
    )

    def extract(self, image, 检测范围="身体+手部", 分辨率=768):
        detail = {
            "仅身体": "body",
            "身体+手部": "body_hand",
            "身体+手部+面部": "full",
        }[检测范围]
        pose_image, saved = _extract_and_save(image, detail, 分辨率)
        relative = f"{saved['subfolder']}/{saved['filename']}"
        return {"ui": {"images": [saved]}, "result": (pose_image, relative)}


async def xiantu_qwen21_pose_extract(request):
    try:
        payload = await request.json()
        image = _load_input_asset(payload.get("image"))
        detail = str(payload.get("detail", "body_hand"))
        resolution = int(payload.get("resolution", 768))
        _pose_image, saved = await asyncio.to_thread(
            _extract_and_save, image, detail, resolution
        )
        return web.json_response({"ok": True, "image": saved})
    except Exception as error:
        return web.json_response({"ok": False, "error": str(error)}, status=400)


def _register_routes():
    prompt_server = getattr(PromptServer, "instance", None)
    if prompt_server is not None:
        prompt_server.routes.post("/xiantu/qwen21/pose/extract")(
            xiantu_qwen21_pose_extract
        )


_register_routes()


NODE_CLASS_MAPPINGS = {"XiantuPoseExtractor": XiantuPoseExtractor}
NODE_DISPLAY_NAME_MAPPINGS = {"XiantuPoseExtractor": "闲兔姿势提取"}
