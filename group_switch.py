class XiantuGroupSwitch:
    """Frontend-driven controller for switching workflow groups between normal and bypass."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "group_states": (
                    "STRING",
                    {"default": "{}", "multiline": False},
                ),
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("组状态",)
    FUNCTION = "run"
    CATEGORY = "闲兔/工作流工具"
    DESCRIPTION = "自动读取当前工作流分组，并切换组内全部节点为正常或忽略。"

    def run(self, group_states="{}"):
        return (group_states,)


NODE_CLASS_MAPPINGS = {
    "XiantuGroupSwitch": XiantuGroupSwitch,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiantuGroupSwitch": "闲兔｜组开关管理",
}
