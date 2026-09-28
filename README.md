# ComfyUI-Xiantu-QwenImage21-Workbench

闲兔 Qwen Image 2.1 工作台是一组面向 ComfyUI 的素材、参考图和提示词管理节点。它不替换 Qwen Image 2.1 模型与采样工作流，主要负责在节点内整理提示词、参考图片、图片任务和 LoRA 配置，并输出可继续连接到现有工作流的结果。

## 功能

- 文生图与图片编辑双入口。
- 最多 16 张参考图，提示词中的 `<image1>`、`<image2>` 等引用与上传顺序对应。
- 人物编辑、角色资产、商品设计、画面处理等预设功能。
- 换装、换人、换背景、姿势迁移、发型妆容、多人物合成。
- 角色设定图、三视图、四视图、表情九宫格、动作姿势表、服装方案。
- 商品场景、多角度、模特展示、广告主图。
- 删除内容、透明背景、添加物体、修改文字、风格转换、二次元转写实。
- 多张图片独立保存功能、参考图和提示词，支持当前图片生成、勾选批量生成以及从当前图片继续生成。
- 独立的闲兔姿势提取节点，结果保存到 `ComfyUI/output/xiantu_pose_extractions`。
- 独立的闲兔 LoRA 管理器，支持多个 LoRA 的顺序、模型强度和用途备注。

## 节点

安装后可在 `闲兔/Qwen Image 2.1` 分类中找到：

- `闲兔Qwen Image 2.1 工作台`
- `闲兔姿势提取`
- `闲兔 LoRA 管理器`

工作台输入 `clip`，可选输入 `vae`，输出 `positive`、`negative` 和 `latent`。输出可继续连接到现有 Qwen Image 2.1 采样和解码节点。

## 安装

在 ComfyUI 的 `custom_nodes` 目录执行：

```bash
git clone https://github.com/xiantuhenlan/ComfyUI-Xiantu-QwenImage21-Workbench.git
```

然后重启 ComfyUI，并在浏览器中强制刷新前端页面。

也可以下载仓库 ZIP，解压到：

```text
ComfyUI/custom_nodes/ComfyUI-Xiantu-QwenImage21-Workbench
```

## 姿势提取可选依赖

仅使用工作台和 LoRA 管理器时，不需要额外安装姿势提取依赖。

使用姿势提取功能时，需要安装 `comfyui_controlnet_aux`，并准备：

- `yolox_l.onnx`
- `dw-ll_ucoco_384_bs5.torchscript.pt`

模型由 `comfyui_controlnet_aux` / DWPose 负责读取。本仓库不包含模型文件。

## 使用说明

1. 选择“文生图”或“图片编辑”。
2. 选择具体功能及其子功能。
3. 按参考图槽位上传图片，缩略图顺序就是 `<imageN>` 的编号。
4. 应用提示词参考后，可继续手动修改正向和负向提示词。
5. 多图片任务可勾选需要生成的图片；没有勾选时从当前图片开始依次提交。
6. 将工作台的输出连接到原有 Qwen Image 2.1 采样流程。

## 模型与素材

本仓库不分发 Qwen Image 2.1 模型、VAE、文本编码器、LoRA、DWPose 模型、用户上传图片或生成结果。请根据各模型原始许可证自行下载和使用。

## 更新

本项目采用增量更新：每次版本只提交实际发生变化的文件，不以整包覆盖用户目录。版本说明记录在 [CHANGELOG.md](CHANGELOG.md)，完整更新规则见 [UPDATE_RULES.md](UPDATE_RULES.md)。

已通过 Git 安装的用户可在插件目录执行：

```bash
git pull --ff-only
```

更新后重启 ComfyUI，并强制刷新浏览器页面。

## 许可证

代码使用 [MIT License](LICENSE) 开源。第三方模型、素材和依赖遵循各自许可证。

