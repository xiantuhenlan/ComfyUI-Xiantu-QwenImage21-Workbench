# ComfyUI-Xiantu-QwenImage21-Workbench

闲兔 Qwen Image 2.1 工作台是一组面向 ComfyUI 的图片素材、故事分镜、数字人和视频编辑生产节点。插件负责管理提示词、参考素材、音频分镜、任务队列和输出结果，不替换用户现有的 Qwen Image 2.1、MiniMax H3、采样器或视频保存工作流。

## 主要功能

- Qwen Image 2.1 文生图、图片编辑、最多 16 张参考图和 `<imageN>` 图文引用。
- 人物编辑、角色资产、商品设计、画面处理、姿势迁移和多人物合成预设。
- 当前图片生成、勾选批量生成、从当前任务继续生成和结果回填。
- 故事分镜导演台、故事模型与 LoRA、角色/场景/道具资产表和图片/视频分镜中转。
- 数字人音频切分、连续分镜、参考图、持久资产库、批量顺序生成和生成结果管理。
- 数字人近景运镜规则：禁止远景，同一运镜至少间隔五个分镜后才允许重复。
- 放大前、放大后、合并成片分类和按分镜序号从小到大的成片合并。
- 独立的视频编辑工作台，提供素材导入、播放器、参数面板和多轨时间线界面。
- 独立的姿势提取和 LoRA 管理节点。

## 节点

安装后可以找到以下主要节点：

- `闲兔Qwen Image 2.1 工作台`
- `闲兔姿势提取`
- `闲兔 LoRA 管理器`
- `闲兔｜故事分镜导演台`
- `闲兔｜故事模型与 LoRA`
- `闲兔｜分镜中转器`
- `闲兔｜数字人工作台`
- `闲兔｜数字人工作台 V2`
- `闲兔｜数字人图片输出`
- `闲兔｜数字人提示词输出`
- `闲兔｜数字人音乐输出`
- `闲兔｜视频编辑工作台`

数字人工作台 V2 当前注册 `H3模型`。H3 使用独立的 `H3_CLIP / H3_VIDEO_VAE / H3_AUDIO_VAE` 输入，以及条件、Latent、图像、音频、放大前文件名和放大后文件名输出。后续模型可以追加独立端口组，不会覆盖 H3 的参数和状态。

## 安装

在 ComfyUI 的 `custom_nodes` 目录执行：

```bash
git clone https://github.com/xiantuhenlan/ComfyUI-Xiantu-QwenImage21-Workbench.git
```

安装 Python 依赖：

```bash
pip install -r ComfyUI-Xiantu-QwenImage21-Workbench/requirements.txt
```

然后重启 ComfyUI，并在浏览器中强制刷新前端页面。也可以下载仓库 ZIP，解压到 `ComfyUI/custom_nodes/ComfyUI-Xiantu-QwenImage21-Workbench`。

## 自动优化提示词

数字人工作台的“自动优化”会调用用户另外安装的 `ComfyUI_Qwen_H3_Prompt`：

```text
本插件数字人工作台
  → ComfyUI_Qwen_H3_Prompt
  → 该插件自己的 llama-server
  → 用户准备的 GGUF 主模型与 mmproj
```

本插件不重复分发或维护 LLAMA 运行文件和 GGUF 模型。安装并正确配置 `ComfyUI_Qwen_H3_Prompt` 后，重启 ComfyUI 即可使用自动优化；关闭自动优化时不需要该插件。优化设置会自动扫描 `ComfyUI/models/LLM/Qwen3.8` 下的 GGUF 文件，并分别提供语言模型与 `mmproj` 视觉模型下拉选择。

## 姿势提取可选依赖

使用姿势提取功能时，需要安装 `comfyui_controlnet_aux`，并准备：

- `yolox_l.onnx`
- `dw-ll_ucoco_384_bs5.torchscript.pt`

模型由 `comfyui_controlnet_aux` / DWPose 负责读取。

## 数字人结果目录

数字人输出默认按以下目录组织：

```text
ComfyUI/output/数字人/
├─ 放大前/
├─ 放大后/
└─ 合并成品/
```

合并成片只接受“放大后”列表中的选中视频，后端会按分镜编号从小到大排序，并依次保存为 `成品-001.mp4`、`成品-002.mp4`。

## 模型与素材

本仓库不分发 Qwen Image 2.1、MiniMax H3、VAE、文本编码器、LoRA、DWPose、GGUF 模型、用户上传素材、工作流或生成结果。请根据各模型和依赖的原始许可证自行准备。

## 更新

本项目采用增量更新。版本说明记录在 [CHANGELOG.md](CHANGELOG.md)，完整规则见 [UPDATE_RULES.md](UPDATE_RULES.md)。

Git 安装用户可在插件目录执行：

```bash
git pull --ff-only
```

更新后重启 ComfyUI，并强制刷新浏览器页面。

## 许可证

代码使用 [MIT License](LICENSE) 开源。第三方模型、素材和依赖遵循各自许可证。
