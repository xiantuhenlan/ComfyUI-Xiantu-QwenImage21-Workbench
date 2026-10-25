# MOSS-Image 官方提示词参考

整理日期：2026-10-25

本文件用于“闲兔 图片素材资产工作台”的“官方提示词说明”入口。界面中的说明为官方资料的中文归纳，不替代官方原文。

## 官方来源

- 官方项目：https://github.com/OpenMOSS/MOSS-Image
- 官方中文用户指南：https://github.com/OpenMOSS/MOSS-Image/blob/main/USERGUIDE_ZH.md
- 官方 Prompt Enhancer：https://github.com/OpenMOSS/MOSS-Image/tree/main/skills/moss-image-prompt-enhancer
- 官方许可：Apache-2.0

## 工作台对应规则

- 商品白底主图、商品场景展示、材质结构特写、包装品牌视觉、服装穿搭、人物商业摄影、插画动漫：使用官方 Caption（自然语言）说明。
- 详情页卖点、广告海报KV、文字信息图：使用官方 Layout 说明。
- 通用：使用官方 Caption（自然语言）说明。

## Caption 要点

- 普通场景、摄影和插画优先使用连贯自然语言。
- 描述主体与动作、外观、环境、镜头与构图、媒介、光线、材质、配色和氛围。
- 保留数量、关系、排除内容及需要显示的准确原文。
- 官方默认推荐英文描述，同时支持中文等多语言。
- 文字需要精确换行时直接换行或使用 `\n`。
- 官方推荐负向词：`nsfw, worst quality, bad anatomy, watermark, jpeg artifact`。

## Layout 要点

- `summary.caption` 描述整体场景与风格，`items` 列出需要控制的元素。
- 元素使用 `label`、`caption`、`bbox`；可见文字必须写入 `text`。
- 编译后的 MOSS 提示词采用 `bbox_format: "yxyx"` 和 `bbox_coord_space: "abs_centralized"`。
- 坐标以画布中心为原点，x 向右、y 向下；布局尺寸必须和生成尺寸一致。
- MOSS-Image 的宽高应为 16 的正整数倍。
- Layout 方框只控制位置，不代表在图片中绘制边框。
- 自然语言和结构化 Layout 可以混合使用。

## 注意

官方 Prompt Enhancer 的可编辑草稿使用左上角原点的 `xyxy` 绝对像素坐标，随后由官方编译脚本转换为最终可粘贴的中心坐标 `yxyx`。工作台展示的是最终提示词规则，不把草稿坐标规则混入正向提示词。
