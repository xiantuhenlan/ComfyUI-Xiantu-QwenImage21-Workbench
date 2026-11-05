"""Independent, type-agnostic transport. No sampling or conditioning logic."""

from comfy_execution.graph import ExecutionBlocker


class _AnySocketType(str):
    # Preserve wildcard compatibility with older ComfyUI link validation.
    def __ne__(self, other):
        return False


_ANY = _AnySocketType("*")


class XiantuUniversalRelay:
    _INPUT_NAMES = tuple(f"input_{index}" for index in range(1, 129))

    @classmethod
    def INPUT_TYPES(cls):
        return {"optional": {
            name: (_ANY, {"lazy": True}) for name in cls._INPUT_NAMES
        }}

    RETURN_TYPES = (_ANY,)
    RETURN_NAMES = ("输出 1",)
    # Receive and return ComfyUI's entire batch list to avoid repetition,
    # truncation or nesting changes during automatic per-item mapping.
    INPUT_IS_LIST = True
    OUTPUT_IS_LIST = (True,)
    FUNCTION = "relay"
    CATEGORY = "闲兔/工作流工具"
    DESCRIPTION = "所有入口共用输出1：按入口编号依次传出全部数据，不选路、不修改数据对象。下游普通节点按列表逐项处理；下游须能接收各项的原始类型。"

    def check_lazy_status(self, **kwargs):
        return [name for name in self._INPUT_NAMES if name in kwargs and (
            kwargs[name] is None or (
                len(kwargs[name]) == 1 and kwargs[name][0] is None
            )
        )]

    def relay(self, **kwargs):
        values = []
        for name in self._INPUT_NAMES:
            if name in kwargs and kwargs[name] is not None:
                values.extend(kwargs[name])
        if not kwargs:
            return ([ExecutionBlocker(None)],)
        return (values,)


NODE_CLASS_MAPPINGS = {"XiantuUniversalRelay": XiantuUniversalRelay}
NODE_DISPLAY_NAME_MAPPINGS = {"XiantuUniversalRelay": "闲兔中转器"}
