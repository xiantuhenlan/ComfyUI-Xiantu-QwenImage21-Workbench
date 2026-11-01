class XiantuSigmasConditionalRelay:
    """Pass through the only SIGMAS value supplied by an enabled upstream branch."""

    # Legacy ComfyUI validates links against INPUT_TYPES before executing the
    # node. Advertise a generous pool here; the web extension only shows the
    # first three plus one empty input after the last connected input.
    _MAX_INPUTS = 128
    _INPUT_NAMES = tuple(f"sigmas_{index}" for index in range(1, _MAX_INPUTS + 1))

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                name: (
                    "SIGMAS",
                    {
                        "lazy": True,
                        "tooltip": f"SIGMAS 输入 {index}；未启用的上游可以忽略。",
                    },
                )
                for index, name in enumerate(cls._INPUT_NAMES, start=1)
            }
        }

    RETURN_TYPES = ("SIGMAS",)
    RETURN_NAMES = ("SIGMAS",)
    FUNCTION = "relay"
    CATEGORY = "闲兔/工作流工具"
    DESCRIPTION = "多个 SIGMAS 条件输入中，透传实际启用并产生数据的那一路；不修改 SIGMAS 数据。连接最后一个端口后会自动增加下一个端口。"

    def check_lazy_status(self, **kwargs):
        # ComfyUI only includes connected lazy inputs in kwargs. Request every
        # connected input that has not produced a value yet; bypassed/muted
        # branches are omitted by prompt graph construction.
        return [
            name
            for name in self._INPUT_NAMES
            if name in kwargs and kwargs[name] is None
        ]

    def relay(self, **kwargs):
        active = [
            (name, kwargs[name])
            for name in self._INPUT_NAMES
            if name in kwargs and kwargs[name] is not None
        ]
        if not active:
            raise ValueError("SIGMAS 条件中转没有收到已启用上游的 SIGMAS 数据")
        if len(active) > 1:
            names = "、".join(name for name, _value in active)
            raise ValueError(f"SIGMAS 条件中转同时收到多个启用输入：{names}；请只开启一路")
        # The object is returned directly. No clone, conversion, slicing, or
        # numerical operation is performed, so the SIGMAS values stay intact.
        return (active[0][1],)


NODE_CLASS_MAPPINGS = {
    "XiantuSigmasConditionalRelay": XiantuSigmasConditionalRelay,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiantuSigmasConditionalRelay": "闲兔｜SIGMAS 条件中转",
}
