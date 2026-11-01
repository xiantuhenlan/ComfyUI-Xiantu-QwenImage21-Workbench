class XiantuSamplerConditionalRelay:
    """Pass through the only SAMPLER value supplied by an enabled upstream branch."""

    # Keep the backend schema generous so workflows saved with dynamically
    # added sockets remain valid on both older and newer ComfyUI versions.
    _MAX_INPUTS = 128
    _INPUT_NAMES = tuple(f"sampler_{index}" for index in range(1, _MAX_INPUTS + 1))

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "optional": {
                name: (
                    "SAMPLER",
                    {
                        "lazy": True,
                        "tooltip": f"采样器输入 {index}；未启用的上游可以忽略。",
                    },
                )
                for index, name in enumerate(cls._INPUT_NAMES, start=1)
            }
        }

    RETURN_TYPES = ("SAMPLER",)
    RETURN_NAMES = ("采样器",)
    FUNCTION = "relay"
    CATEGORY = "闲兔/工作流工具"
    DESCRIPTION = "多个采样器条件输入中，透传实际启用并产生数据的那一路；不修改采样器对象或任何参数。连接最后一个端口后会自动增加下一个端口。"

    def check_lazy_status(self, **kwargs):
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
            raise ValueError("采样器条件中转没有收到已启用上游的采样器数据")
        if len(active) > 1:
            names = "、".join(name for name, _value in active)
            raise ValueError(f"采样器条件中转同时收到多个启用输入：{names}；请只开启一路")
        # Return the exact same object reference: no clone, wrapper,
        # conversion, attribute access, or parameter mutation is performed.
        return (active[0][1],)


NODE_CLASS_MAPPINGS = {
    "XiantuSamplerConditionalRelay": XiantuSamplerConditionalRelay,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "XiantuSamplerConditionalRelay": "闲兔｜采样器条件中转",
}
