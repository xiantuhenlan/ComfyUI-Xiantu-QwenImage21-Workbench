"""ComfyUI entry node for the independent Xiantu video editing workbench."""


class XiantuVideoEditorWorkbench:
    """UI host node. Editing state is owned by its browser-side workbench."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "project_id": ("STRING", {"default": ""}),
                "editor_state": ("STRING", {"default": "{}", "multiline": True}),
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "run"
    CATEGORY = "闲兔/视频编辑"
    OUTPUT_NODE = True

    def run(self, project_id="", editor_state="{}"):
        return ()


NODE_CLASS_MAPPINGS = {
    "XiantuVideoEditorWorkbench": XiantuVideoEditorWorkbench,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiantuVideoEditorWorkbench": "闲兔｜视频编辑工作台",
}
