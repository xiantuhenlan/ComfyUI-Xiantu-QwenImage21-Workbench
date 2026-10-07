import hashlib
import json


MAX_STORYBOARD_BYTES = 2 * 1024 * 1024
MAX_SHOTS = 500
SELECTION_MODES = ("当前分镜", "勾选分镜", "从当前开始")


def _text(value):
    return str(value or "").strip()


def _join_prompt(*parts):
    return "\n".join(part for part in (_text(item) for item in parts) if part)


class XiantuStoryboardDirector:
    """独立的故事分镜管理与批量队列桥接节点。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "storyboard_json": (
                    "STRING",
                    {"default": "", "multiline": False},
                ),
                "active_shot_id": (
                    "STRING",
                    {"default": "", "multiline": False},
                ),
                "selection_mode": (SELECTION_MODES,),
            },
            "optional": {
                "模型接口": (
                    "STORY_MODEL_CONFIG",
                    {"forceInput": True, "tooltip": "连接“闲兔｜故事模型与 LoRA”节点。"},
                ),
            },
        }

    RETURN_TYPES = (
        "STRING",
        "STRING",
        "STRING",
        "STRING",
        "STRING",
        "STRING",
        "STRING",
    )
    RETURN_NAMES = (
        "positive",
        "negative",
        "当前分镜",
        "批量分镜",
        "完整分镜",
        "资产分镜",
        "视频分镜",
    )
    FUNCTION = "compile_storyboard"
    CATEGORY = "闲兔/故事分镜"
    DESCRIPTION = (
        "管理故事分镜、镜头提示词和批量生成顺序；"
        "本节点不加载模型，输出可连接到任意图片或视频工作流。"
    )

    @classmethod
    def _parse(cls, storyboard_json):
        raw = str(storyboard_json or "").strip()
        if not raw:
            raise ValueError("分镜数据为空。")
        if len(raw.encode("utf-8")) > MAX_STORYBOARD_BYTES:
            raise ValueError("分镜数据超过 2 MiB 限制。")
        try:
            data = json.loads(raw)
        except (TypeError, json.JSONDecodeError) as error:
            raise ValueError("分镜数据不是有效 JSON。") from error
        if not isinstance(data, dict):
            raise ValueError("分镜数据必须是对象。")
        project = data.get("project")
        shots = data.get("shots")
        if not isinstance(project, dict):
            raise ValueError("分镜数据缺少 project 对象。")
        if not isinstance(shots, list) or not shots:
            raise ValueError("分镜至少需要一个镜头。")
        if len(shots) > MAX_SHOTS:
            raise ValueError(f"分镜数量不能超过 {MAX_SHOTS} 个。")
        normalized = []
        used_ids = set()
        for index, shot in enumerate(shots, start=1):
            if not isinstance(shot, dict):
                raise ValueError(f"第 {index} 个分镜不是对象。")
            shot_id = _text(shot.get("id")) or f"shot-{index}"
            if shot_id in used_ids:
                raise ValueError(f"分镜 ID 重复：{shot_id}")
            used_ids.add(shot_id)
            item = dict(shot)
            item["id"] = shot_id
            item["selected"] = bool(shot.get("selected", False))
            assets = shot.get("assets", [])
            if not isinstance(assets, list):
                raise ValueError(f"第 {index} 个分镜的参考素材不是数组。")
            if len(assets) > 16:
                raise ValueError(f"第 {index} 个分镜最多支持 16 张参考图。")
            item["assets"] = assets
            normalized.append(item)
        return {
            "version": int(data.get("version") or 3),
            "project": dict(project),
            "characters": data.get("characters") if isinstance(data.get("characters"), list) else [],
            "scenes": data.get("scenes") if isinstance(data.get("scenes"), list) else [],
            "props": data.get("props") if isinstance(data.get("props"), list) else [],
            "story_beats": data.get("story_beats") if isinstance(data.get("story_beats"), list) else [],
            "validation": data.get("validation") if isinstance(data.get("validation"), dict) else {},
            "active_asset_task_id": _text(data.get("active_asset_task_id")),
            "shots": normalized,
        }

    @staticmethod
    def _asset_task(data, asset_id):
        groups = (
            ("character", data.get("characters", []), "角色"),
            ("scene", data.get("scenes", []), "场景"),
            ("prop", data.get("props", []), "道具"),
        )
        for kind, assets, label in groups:
            for asset in assets:
                if not isinstance(asset, dict) or _text(asset.get("id")) != asset_id:
                    continue
                prompt = _text(asset.get("image_prompt") or asset.get("prompt"))
                if not prompt:
                    fields = {
                        "character": ("role", "appearance", "wardrobe"),
                        "scene": ("time", "weather_environment", "spatial_structure", "fixed_visuals"),
                        "prop": ("category", "appearance"),
                    }[kind]
                    prompt = _join_prompt(
                        f"{label}资产设定图：{_text(asset.get('name')) or asset_id}",
                        "，".join(_text(asset.get(field)) for field in fields if _text(asset.get(field))),
                    )
                task = {
                    "task_id": f"asset:{asset_id}",
                    "slot": "asset_image",
                    "label": f"{label}资产 · {_text(asset.get('name')) or asset_id}",
                    "prompt": prompt,
                    "asset_refs": [],
                    "prompt_engine": _text(asset.get("image_prompt_engine")) or "Qwen Image 2.1",
                    "generation_mode": "文生图",
                    "negative": _text(asset.get("negative_prompt")),
                }
                return asset, task, kind
        return None, None, ""

    @staticmethod
    def _image_tasks(shot):
        shot_id = _text(shot.get("id")) or "shot"
        mode = _text(shot.get("video_mode") or shot.get("video_generation_mode")) or "图生视频"
        common_refs = list(dict.fromkeys(
            list(shot.get("protagonist_refs") or [])
            + list(shot.get("supporting_refs") or [])
            + list(shot.get("prop_refs") or [])
            + ([_text(shot.get("scene_ref"))] if _text(shot.get("scene_ref")) else [])
        ))
        tasks = []
        if mode == "首尾帧":
            tasks.extend((
                {
                    "task_id": f"{shot_id}:first_frame",
                    "slot": "first_frame",
                    "label": "首帧",
                    "prompt": _text(shot.get("first_frame_prompt")) or _text(shot.get("positive")),
                    "asset_refs": shot.get("first_frame_asset_refs") or common_refs,
                    "prompt_engine": _text(shot.get("image_prompt_engine")) or "Qwen Image 2.1",
                    "generation_mode": _text(shot.get("image_generation_mode")) or "图片编辑",
                    "negative": _text(shot.get("negative")) or _text(shot.get("negative_prompt")),
                },
                {
                    "task_id": f"{shot_id}:last_frame",
                    "slot": "last_frame",
                    "label": "尾帧",
                    "prompt": _text(shot.get("last_frame_prompt")) or _text(shot.get("positive")),
                    "asset_refs": shot.get("last_frame_asset_refs") or common_refs,
                    "prompt_engine": _text(shot.get("image_prompt_engine")) or "Qwen Image 2.1",
                    "generation_mode": _text(shot.get("image_generation_mode")) or "图片编辑",
                    "negative": _text(shot.get("negative")) or _text(shot.get("negative_prompt")),
                },
            ))
        elif mode == "多参考图":
            refs = shot.get("multi_reference_asset_refs") or common_refs
            for index, asset_ref in enumerate(refs, start=1):
                tasks.append({
                    "task_id": f"{shot_id}:reference:{index}",
                    "slot": f"reference_{index}",
                    "label": f"参考图 {index}",
                    "prompt": _text(shot.get("image_prompt")) or _text(shot.get("positive")),
                    "asset_refs": [asset_ref],
                    "prompt_engine": _text(shot.get("image_prompt_engine")) or "Qwen Image 2.1",
                    "generation_mode": "图片编辑",
                    "negative": _text(shot.get("negative")) or _text(shot.get("negative_prompt")),
                })
        else:
            tasks.append({
                "task_id": f"{shot_id}:start_frame",
                "slot": "start_frame",
                "label": "起始图",
                "prompt": _text(shot.get("image_prompt")) or _text(shot.get("positive")),
                "asset_refs": common_refs,
                "prompt_engine": _text(shot.get("image_prompt_engine")) or "Qwen Image 2.1",
                "generation_mode": (_text(shot.get("image_generation_mode")) or ("图片编辑" if common_refs else "文生图")),
                "negative": _text(shot.get("negative")) or _text(shot.get("negative_prompt")),
            })
        return tasks

    @staticmethod
    def _resolve_task_assets(data, task, shot):
        records = []
        seen = set()
        assets_by_id = {
            _text(item.get("id")): item
            for group in (data.get("characters", []), data.get("scenes", []), data.get("props", []))
            for item in group
            if isinstance(item, dict) and _text(item.get("id"))
        }

        def add(value):
            if isinstance(value, list):
                for child in value:
                    add(child)
            elif isinstance(value, dict):
                if isinstance(value.get("images"), list):
                    add(value["images"])
                if isinstance(value.get("image"), dict):
                    add(value["image"])
                is_image_record = bool(value.get("filename")) or (
                    bool(value.get("name"))
                    and ("subfolder" in value or _text(value.get("type")) in {"input", "output", "temp"})
                )
                name = _text(value.get("name") or value.get("filename")) if is_image_record else ""
                if name:
                    key = (name, _text(value.get("subfolder")), _text(value.get("type") or "input"))
                    if key not in seen:
                        seen.add(key)
                        records.append({
                            "name": name,
                            "subfolder": _text(value.get("subfolder")),
                            "type": _text(value.get("type")) or "input",
                        })
                elif not value.get("images") and not value.get("image"):
                    for child in value.values():
                        add(child)

        for asset_id in (task or {}).get("asset_refs", []):
            add(assets_by_id.get(_text(asset_id)))
        add(shot.get("assets", []))
        add(shot.get("image_results", {}))
        return records[:16]

    @staticmethod
    def _effective_shot(project, shot, index):
        result = dict(shot)
        result["index"] = index + 1
        result["effective_positive"] = _join_prompt(
            project.get("global_positive"),
            project.get("visual_style"),
            shot.get("positive"),
        )
        result["effective_negative"] = _join_prompt(
            project.get("global_negative"),
            shot.get("negative"),
        )
        return result

    def compile_storyboard(
        self,
        storyboard_json,
        active_shot_id,
        selection_mode,
        模型接口=None,
    ):
        del 模型接口
        data = self._parse(storyboard_json)
        shots = data["shots"]
        active_index = next(
            (index for index, shot in enumerate(shots) if shot["id"] == active_shot_id),
            0,
        )
        current = self._effective_shot(data["project"], shots[active_index], active_index)
        current["project"] = data["project"]
        current["characters_assets"] = data["characters"]
        current["scene_assets"] = data["scenes"]
        current["prop_assets"] = data["props"]
        current["image_tasks"] = self._image_tasks(current)
        requested_task_id = _text(current.get("active_image_task_id"))
        active_task = next(
            (task for task in current["image_tasks"] if task["task_id"] == requested_task_id),
            current["image_tasks"][0] if current["image_tasks"] else None,
        )
        current["active_image_task"] = active_task
        current["assets"] = self._resolve_task_assets(data, active_task, current)
        if active_task and active_task.get("prompt"):
            current["effective_positive"] = _join_prompt(
                data["project"].get("global_positive"),
                data["project"].get("visual_style"),
                active_task.get("prompt"),
            )
        if selection_mode == "勾选分镜":
            selected_indexes = [
                index for index, shot in enumerate(shots) if shot.get("selected")
            ]
            if not selected_indexes:
                selected_indexes = [active_index]
        elif selection_mode == "从当前开始":
            selected_indexes = list(range(active_index, len(shots)))
        else:
            selected_indexes = [active_index]
        selected = [
            self._effective_shot(data["project"], shots[index], index)
            for index in selected_indexes
        ]
        batch = {
            "version": 3,
            "project": data["project"],
            "characters": data["characters"],
            "scenes": data["scenes"],
            "props": data["props"],
            "validation": data["validation"],
            "selection_mode": selection_mode,
            "shots": selected,
        }
        active_asset_id = _text(data.get("active_asset_task_id"))
        active_asset, asset_task, asset_kind = self._asset_task(data, active_asset_id)
        if active_asset and asset_task:
            asset_shot = {
                "id": f"asset:{active_asset_id}",
                "title": asset_task["label"],
                "project": data["project"],
                "route": "image",
                "task_type": "asset_image",
                "asset_id": active_asset_id,
                "asset_kind": asset_kind,
                "asset_record": active_asset,
                "active_image_task": asset_task,
                "effective_positive": _join_prompt(
                    data["project"].get("global_positive"),
                    data["project"].get("visual_style"),
                    asset_task["prompt"],
                ),
                "effective_negative": _join_prompt(
                    data["project"].get("global_negative"),
                    asset_task["negative"],
                ),
                "assets": [],
            }
        else:
            asset_shot = dict(current)
            asset_shot["route"] = "image"
            asset_shot["task_type"] = "shot_image"
        video_shot = dict(current)
        video_shot["route"] = "video"
        video_shot["task_type"] = "video_storyboard"
        video_shot["video_prompt"] = _join_prompt(
            current.get("action"),
            current.get("camera_movement"),
            current.get("dialogue"),
            current.get("positive"),
        )
        return (
            asset_shot["effective_positive"],
            asset_shot["effective_negative"],
            json.dumps(current, ensure_ascii=False, separators=(",", ":")),
            json.dumps(batch, ensure_ascii=False, separators=(",", ":")),
            json.dumps(data, ensure_ascii=False, separators=(",", ":")),
            json.dumps(asset_shot, ensure_ascii=False, separators=(",", ":")),
            json.dumps(video_shot, ensure_ascii=False, separators=(",", ":")),
        )

    @classmethod
    def VALIDATE_INPUTS(cls, storyboard_json, selection_mode, **_kwargs):
        if selection_mode not in SELECTION_MODES:
            return "未知的分镜输出范围。"
        try:
            cls._parse(storyboard_json)
        except ValueError as error:
            return str(error)
        return True

    @classmethod
    def IS_CHANGED(cls, storyboard_json, active_shot_id, selection_mode, **_kwargs):
        digest = hashlib.sha256()
        digest.update(str(storyboard_json).encode("utf-8"))
        digest.update(str(active_shot_id).encode("utf-8"))
        digest.update(str(selection_mode).encode("utf-8"))
        return digest.hexdigest()


NODE_CLASS_MAPPINGS = {"XiantuStoryboardDirector": XiantuStoryboardDirector}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiantuStoryboardDirector": "闲兔｜故事分镜导演台",
}
