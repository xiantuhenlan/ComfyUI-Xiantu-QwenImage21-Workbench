import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE = "XiantuVideoEditorWorkbench";
const WORKBENCH_LOGO_URL = new URL("./assets/xiantu-rabbit-logo.png", import.meta.url).href;

{
    const styleUrl = new URL("./xiantu_video_editor.css?v=20261018-02", import.meta.url).href;
    const link = document.querySelector("link[data-xiantu-video-editor-style]") || document.createElement("link");
    link.rel = "stylesheet";
    link.href = styleUrl;
    link.dataset.xiantuVideoEditorStyle = "1";
    if (!link.isConnected) document.head.appendChild(link);
    let fallbackStarted = false;
    const installInlineFallback = async () => {
        if (fallbackStarted || document.querySelector("style[data-xiantu-video-editor-inline-style]")) return;
        fallbackStarted = true;
        try {
            const response = await fetch(styleUrl, { cache: "no-store" });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const style = document.createElement("style");
            style.dataset.xiantuVideoEditorInlineStyle = "1";
            style.textContent = await response.text();
            document.head.appendChild(style);
        } catch (error) {
            fallbackStarted = false;
            console.error("闲兔视频编辑工作台样式加载失败", error);
        }
    };
    link.addEventListener("error", installInlineFallback, { once: true });
    installInlineFallback();
}
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
}[char]));
const makeId = () => globalThis.crypto?.randomUUID?.() || `xve_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const freshSeed = () => {
    const words = new Uint32Array(2);
    globalThis.crypto?.getRandomValues?.(words);
    if (!words[0] && !words[1]) {
        words[0] = Math.floor(Math.random() * 0x100000000);
        words[1] = Math.floor(Math.random() * 0x100000000);
    }
    return words[0] * 0x200000 + (words[1] & 0x1fffff);
};
const refreshWorkflowSeed = () => {
    const seed = freshSeed();
    const seedNames = new Set(["seed", "noise_seed", "随机种子", "噪声种子"]);
    for (const graphNode of app.graph?._nodes || []) {
        for (const widget of graphNode.widgets || []) {
            if (!seedNames.has(String(widget?.name || "").toLowerCase())) continue;
            widget.value = seed;
        }
    }
    app.graph?.setDirtyCanvas?.(true, true);
    return seed;
};
const injectWorkflowSeed = (prompt, seed) => {
    const seedNames = new Set(["seed", "noise_seed", "随机种子", "噪声种子"]);
    for (const promptNode of Object.values(prompt?.output || {})) {
        for (const [name, value] of Object.entries(promptNode?.inputs || {})) {
            if (!seedNames.has(String(name).toLowerCase()) || Array.isArray(value)) continue;
            if (typeof value === "number" || /^\d+$/.test(String(value))) promptNode.inputs[name] = seed;
        }
    }
    return prompt;
};
const finalizedVideoNames = new Map();
const finalizedVideoUrl = (source) => {
    try {
        const url = new URL(String(source || ""), location.href);
        const filename = url.searchParams.get("filename") || "";
        const mapped = finalizedVideoNames.get(filename);
        if (!mapped && !/-audio\.(?:mp4|webm|mov|mkv|avi|m4v)$/i.test(filename)) return "";
        url.searchParams.set("filename", mapped || filename
            .replace(/_\d{5}-audio(?=\.(?:mp4|webm|mov|mkv|avi|m4v)$)/i, "")
            .replace(/-audio(?=\.(?:mp4|webm|mov|mkv|avi|m4v)$)/i, ""));
        url.searchParams.set("t", String(Date.now()));
        return url.href;
    } catch { return ""; }
};
const repairFinalizedVideoElements = (oldFilename = "", newFilename = "") => {
    if (oldFilename && newFilename) finalizedVideoNames.set(String(oldFilename), String(newFilename));
    const repair = () => {
        for (const graphNode of app.graph?._nodes || []) {
            for (const widget of graphNode.widgets || []) {
                const params = widget?.value?.params;
                if (!params || String(params.filename || "") !== String(oldFilename || "")) continue;
                params.filename = newFilename;
                if (typeof params.fullpath === "string") params.fullpath = params.fullpath.replace(String(oldFilename), String(newFilename));
                if (widget.parentEl) widget.parentEl.hidden = false;
                widget.updateSource?.();
            }
        }
        document.querySelectorAll("video").forEach((element) => {
            const current = element.currentSrc || element.src || "";
            let replacement = finalizedVideoUrl(current);
            if (!replacement && oldFilename && newFilename && current.includes(encodeURIComponent(oldFilename))) {
                replacement = current.replace(encodeURIComponent(oldFilename), encodeURIComponent(newFilename));
            }
            if (!replacement || replacement === current || element.dataset.xiantuFinalizedSource === replacement) return;
            element.dataset.xiantuFinalizedSource = replacement;
            const wasPaused = element.paused;
            const resumeAt = Math.max(0, Number(element.currentTime || 0));
            if (element.parentElement) element.parentElement.hidden = false;
            element.addEventListener("loadedmetadata", () => {
                if (element.parentElement) element.parentElement.hidden = false;
                if (resumeAt > 0) element.currentTime = Math.min(resumeAt, Math.max(0, Number(element.duration || resumeAt) - 0.03));
                if (!wasPaused) element.play().catch(() => {});
            }, { once: true });
            element.src = replacement;
            element.load();
        });
        if (oldFilename && newFilename) {
            const roots = [document.body];
            for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
                const currentRoot = roots[rootIndex];
                currentRoot.querySelectorAll?.("*").forEach((element) => {
                    if (element.shadowRoot) roots.push(element.shadowRoot);
                });
                const walker = document.createTreeWalker(currentRoot, NodeFilter.SHOW_TEXT);
                let textNode = walker.nextNode();
                while (textNode) {
                    if (String(textNode.nodeValue || "").includes(oldFilename)) {
                        textNode.nodeValue = String(textNode.nodeValue).replaceAll(oldFilename, newFilename);
                    }
                    textNode = walker.nextNode();
                }
            }
        }
    };
    repair();
    // VHS adds its native preview widget asynchronously after the execution
    // event. Keep repairing for a few seconds so a physical filename cleanup
    // can never leave ComfyUI's own preview pointing at the removed -audio file.
    [100, 300, 700, 1500, 3000, 5000].forEach((delay) => window.setTimeout(repair, delay));
};
if (!globalThis.__xiantuFinalizedVideoFallbackInstalled) {
    globalThis.__xiantuFinalizedVideoFallbackInstalled = true;
    document.addEventListener("error", (event) => {
        const element = event.target;
        if (!(element instanceof HTMLVideoElement)) return;
        const replacement = finalizedVideoUrl(element.currentSrc || element.src);
        if (!replacement || element.dataset.xiantuFinalizedSource === replacement) return;
        element.dataset.xiantuFinalizedSource = replacement;
        element.addEventListener("loadedmetadata", () => { if (element.parentElement) element.parentElement.hidden = false; }, { once: true });
        element.src = replacement;
        element.load();
    }, true);
}
const SIMPLE_CAMERA_PRESETS = [
    { id: "fixed", icon: "▣", title: "正面固定", hint: "正面拍摄人物表演", text: "摄影机在人物正面保持稳定固定，主体面向镜头完成表演" },
    { id: "back-fixed", icon: "▤", title: "背面固定", hint: "从人物背后拍摄", text: "摄影机固定在人物背后，清楚展示人物背影及其面对的环境" },
    { id: "left-profile", icon: "◐", title: "左侧面固定", hint: "拍摄人物左侧轮廓", text: "摄影机固定在人物左侧，以侧面角度展示人物轮廓和动作" },
    { id: "right-profile", icon: "◑", title: "右侧面固定", hint: "拍摄人物右侧轮廓", text: "摄影机固定在人物右侧，以侧面角度展示人物轮廓和动作" },
    { id: "push", icon: "＋", title: "缓慢推近", hint: "突出情绪和细节", text: "摄影机平稳缓慢向主体推近，由中景自然过渡到近景" },
    { id: "pull", icon: "－", title: "缓慢拉远", hint: "交代人物与环境", text: "摄影机平稳缓慢远离主体，由近景自然过渡到中远景并展示环境" },
    { id: "left", icon: "←", title: "向左横移", hint: "展示空间关系", text: "摄影机保持朝向主体并向左平稳横向移动，产生自然视差" },
    { id: "right", icon: "→", title: "向右横移", hint: "展示空间关系", text: "摄影机保持朝向主体并向右平稳横向移动，产生自然视差" },
    { id: "rise", icon: "↑", title: "升起镜头", hint: "揭示更大场景", text: "摄影机从较低机位平稳升起，始终保持主体清晰并逐渐揭示周围环境" },
    { id: "fall", icon: "↓", title: "下降镜头", hint: "落到人物视角", text: "摄影机从较高机位平稳下降至人物高度，最终稳定聚焦主体" },
    { id: "handheld", icon: "≈", title: "轻微手持", hint: "增加现场感", text: "摄影机带有克制而自然的轻微手持起伏，不剧烈抖动，主体始终清晰" },
    { id: "diagonal-in", icon: "↘", title: "斜向推进", hint: "推进同时产生视差", text: "摄影机从主体侧前方沿斜线平稳推进，在接近主体的同时形成明显空间视差" },
    { id: "diagonal-out", icon: "↖", title: "斜向拉远", hint: "拉远并揭示环境", text: "摄影机从主体近侧沿斜线平稳后退，逐渐展示人物周围环境和空间层次" },
    { id: "orbit-left", icon: "↶", title: "向左环绕", hint: "左侧弧线绕拍", text: "摄影机以主体为中心向左进行平滑半弧环绕，始终锁定主体" },
    { id: "orbit-right", icon: "↷", title: "向右环绕", hint: "右侧弧线绕拍", text: "摄影机以主体为中心向右进行平滑半弧环绕，始终锁定主体" },
    { id: "orbit-half", icon: "◒", title: "半圈环绕", hint: "从侧后转到正面", text: "摄影机围绕主体运动约半圈，从侧后方自然转到主体正面" },
    { id: "orbit-full", icon: "◎", title: "完整环绕", hint: "完整展示人物造型", text: "摄影机以稳定速度围绕主体完整运动一圈，主体始终位于画面中心" },
    { id: "follow-back", icon: "⇥", title: "背后跟随", hint: "跟随人物向前移动", text: "摄影机位于人物背后，以稳定距离和相同速度向前跟随" },
    { id: "follow-side", icon: "⇄", title: "侧面跟随", hint: "平行跟拍行走动作", text: "摄影机位于人物侧面并与人物平行移动，保持稳定侧面构图" },
    { id: "follow-front", icon: "⇤", title: "正面跟随", hint: "倒退拍摄人物正面", text: "摄影机位于人物前方倒退跟随，人物正面和面部始终清晰" },
    { id: "crane-over", icon: "⌁", title: "越顶镜头", hint: "从低位越过人物头顶", text: "摄影机从人物前方低机位升起并越过头顶，最后展示人物身后的空间" },
    { id: "foreground-pass", icon: "◫", title: "穿越前景", hint: "利用遮挡揭示主体", text: "摄影机横向穿过近处前景遮挡物，随后自然揭示清晰主体" },
    { id: "dolly-zoom", icon: "◇", title: "希区柯克变焦", hint: "人物不变、背景伸缩", text: "摄影机推近同时反向调整焦距，主体大小基本不变而背景透视明显伸缩" },
    { id: "rush-in", icon: "»", title: "快速推进", hint: "迅速进入人物特写", text: "摄影机快速但平滑地冲向主体，由远景迅速进入近景或特写并稳定停住" },
    { id: "rush-out", icon: "«", title: "快速拉远", hint: "迅速揭示完整场景", text: "摄影机从主体近景快速平滑拉远，迅速揭示完整场景并稳定停住" },
    { id: "spiral-in", icon: "◉", title: "螺旋推进", hint: "环绕同时靠近人物", text: "摄影机一边围绕主体运动一边逐渐推近，形成平滑螺旋式推进" },
    { id: "spiral-out", icon: "⊙", title: "螺旋拉远", hint: "环绕同时展示环境", text: "摄影机一边围绕主体运动一边逐渐拉远，逐步揭示周围环境" },
    { id: "face-orbit", icon: "◔", title: "绕脸半圈", hint: "适合人物情绪特写", text: "摄影机在人物面部近景范围内进行克制的半弧环绕，五官保持稳定清晰" },
    { id: "duo-slide", icon: "●↔●", title: "双人之间横移", hint: "切换双人视觉重点", text: "摄影机在两名人物之间平稳横向移动，视觉重点由一人自然过渡到另一人" },
];
const SIMPLE_BLOCKING_PRESETS = [
    { id: "solo-front", people: 1, icon: "●", title: "单人正面", hint: "人物居中面向镜头", text: "一名人物位于画面中心，身体正面朝向镜头" },
    { id: "solo-side", people: 1, icon: "◐", title: "单人侧身", hint: "适合回头或侧脸", text: "一名人物位于画面中心偏一侧，身体侧向镜头并保留面部可见" },
    { id: "solo-walk", people: 1, icon: "➜", title: "单人行进", hint: "留出运动方向空间", text: "一名人物位于画面三分线，朝画面留白方向行进" },
    { id: "solo-left", people: 1, icon: "● ·", title: "左侧三分位", hint: "右侧保留环境或文字", text: "一名人物位于画面左侧三分线，右侧保留充足环境空间" },
    { id: "solo-right", people: 1, icon: "· ●", title: "右侧三分位", hint: "左侧保留环境或文字", text: "一名人物位于画面右侧三分线，左侧保留充足环境空间" },
    { id: "solo-back", people: 1, icon: "◉", title: "背对镜头", hint: "人物看向远方", text: "一名人物位于画面中心并背对镜头，视线朝向远处环境" },
    { id: "solo-kneel", people: 1, icon: "◒", title: "低位姿态", hint: "适合蹲下或跪姿", text: "一名人物位于画面中心下方，采用蹲下或跪姿并保持身体结构清楚" },
    { id: "duo-side", people: 2, icon: "● ●", title: "双人并排", hint: "适合共同看向前方", text: "两名人物并排站立，彼此间距自然，主体层级清楚" },
    { id: "duo-talk", people: 2, icon: "●↔●", title: "双人对话", hint: "面对面交流", text: "两名人物分居画面左右并相互面对，保持自然对话距离和视线关系" },
    { id: "duo-depth", people: 2, icon: "●  ·", title: "一前一后", hint: "强调主次关系", text: "主角位于前景，另一人物位于后景偏侧，形成清晰前后层次" },
    { id: "duo-back", people: 2, icon: "◀▶", title: "背靠背", hint: "适合冲突或搭档", text: "两名人物背靠背站立，分别朝相反方向，保持轮廓清楚" },
    { id: "duo-stagger", people: 2, icon: "● ·", title: "前后错位", hint: "突出主角和配角", text: "主角位于前景三分线，另一人物位于后景另一侧，形成明确主次" },
    { id: "duo-shoulder", people: 2, icon: "●●", title: "肩并肩", hint: "适合搭档和合影", text: "两名人物肩并肩靠近站立，面向同一方向且不遮挡面部" },
    { id: "duo-embrace", people: 2, icon: "(●●)", title: "靠近互动", hint: "适合拥抱或搀扶", text: "两名人物靠近并形成自然肢体互动，四肢和面部保持清晰" },
    { id: "duo-corners", people: 2, icon: "●   ●", title: "对角分布", hint: "展示距离与空间", text: "两名人物分布在画面对角位置，通过前后景形成明显空间距离" },
    { id: "trio-v", people: 3, icon: "●∧●", title: "一前两后", hint: "突出中心人物", text: "主角位于前景中心，另外两人位于后方左右，形成稳定三角构图" },
    { id: "trio-line", people: 3, icon: "●●●", title: "三人并列", hint: "平等展示角色", text: "三名人物横向错落排列，避免相互遮挡，所有人物面部清晰" },
    { id: "trio-surround", people: 3, icon: "●◎●", title: "左右包围", hint: "制造压迫和冲突", text: "中心人物位于画面中部，另外两人从左右形成包围，保持空间层次" },
    { id: "trio-front-two", people: 3, icon: "●● ·", title: "两前一后", hint: "双主角在前景", text: "两名主要人物位于前景左右，第三人位于后景中间，避免相互遮挡" },
    { id: "trio-depth", people: 3, icon: "● · ·", title: "三层纵深", hint: "前中后景分层", text: "三名人物分别位于前景、中景和后景，形成清楚的纵深层次" },
    { id: "trio-arc", people: 3, icon: "⌒", title: "半圆站位", hint: "适合群体交谈", text: "三名人物围成开放半圆并朝向交流中心，所有面部保持可见" },
    { id: "trio-leader", people: 3, icon: "·●·", title: "中心领队", hint: "突出中心领导者", text: "中心人物略靠前，另外两人位于后方左右并朝向中心人物" },
];
const SIMPLE_ACTIONS = ["自然站立", "坐下交谈", "缓慢行走", "快速奔跑", "回头看", "挥手示意", "蹲下", "跪姿", "指向远方", "战斗准备"];
const SHEET_COLUMNS = [
    "序号", "分镜编号", "分镜名", "秒数", "是否继承上一帧", "生成类型（全参考生视频）", "提示词", "图片参数（MAX）",
    ...Array.from({ length: 9 }, (_, index) => `参考图绝对地址${index + 1}`),
    ...Array.from({ length: 3 }, (_, index) => `参考视频${index + 1}`),
    ...Array.from({ length: 3 }, (_, index) => `参考音频${index + 1}`),
    "宽高比", "分辨率", "保存文件名",
];
const MODE_LABELS = { text: "文生视频", image: "图生视频", frames: "首尾帧生视频", reference: "全参考生视频" };
const LABEL_MODES = Object.fromEntries(Object.entries(MODE_LABELS).map(([key, value]) => [value, key]));
const csvCell = (value) => {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const parseCsv = (text) => {
    const source = String(text || "").replace(/^\uFEFF/, "");
    const rows = [];
    let row = [], cell = "", quoted = false;
    for (let index = 0; index < source.length; index += 1) {
        const char = source[index];
        if (quoted) {
            if (char === '"' && source[index + 1] === '"') { cell += '"'; index += 1; }
            else if (char === '"') quoted = false;
            else cell += char;
        } else if (char === '"') quoted = true;
        else if (char === ",") { row.push(cell); cell = ""; }
        else if (char === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
        else cell += char;
    }
    if (cell || row.length) { row.push(cell.replace(/\r$/, "")); rows.push(row); }
    return rows.filter((item) => item.some((value) => String(value).trim()));
};
const downloadCsv = (filename, rows) => {
    const blob = new Blob(["\uFEFF", rows.map((row) => row.map(csvCell).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = filename; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
};
const isAbsolutePath = (value) => /^[a-zA-Z]:[\\/]/.test(String(value || "").trim()) || /^\\\\[^\\]+\\[^\\]+/.test(String(value || "").trim()) || /^\/(?!\/)/.test(String(value || "").trim());
const persistedAssetUrl = (asset) => {
    const filename = String(asset?.serverName || "");
    if (!filename) return "";
    return api.apiURL(`/view?${new URLSearchParams({ filename, subfolder: String(asset?.subfolder || ""), type: String(asset?.sourceType || "input") }).toString()}`);
};

function createWorkbench(node) {
    const runtime = node._xveGenerationRuntime ||= { busy: false, buttonText: "▶ 开始生成", progress: null, listeners: new Set(), hardware: null };
    if (!(runtime.listeners instanceof Set)) runtime.listeners = new Set();
    runtime.startedAt = Number.isFinite(runtime.startedAt) ? runtime.startedAt : null;
    runtime.elapsedMs = Number.isFinite(runtime.elapsedMs) ? runtime.elapsedMs : Math.max(0, Number(node.properties?.xiantuLastGenerationElapsedMs) || 0);
    const root = document.createElement("div");
    root.className = "xve-overlay";
    root.tabIndex = -1;
    root.innerHTML = `
      <section class="xve-app" role="dialog" aria-label="闲兔视频编辑工作台">
        <header class="xve-topbar">
          <strong class="xve-brand"><img src="${WORKBENCH_LOGO_URL}" alt=""><span>闲兔视频导演台</span></strong>
          <nav class="xve-model-nav" aria-label="视频模型"><button type="button" class="active" data-model-profile="minimax-h3"><i></i>MiniMax H3</button></nav>
          <div class="xve-hardware" data-hardware hidden><div class="xve-hardware-stats"><span data-hw-cpu>CPU --</span><span data-hw-memory>内存 --</span><span data-hw-vram>显存 --</span><span data-hw-temp>温度 --</span></div><span class="xve-generation-elapsed" data-generation-elapsed>生成耗时 00:00</span></div>
          <div class="xve-top-progress" data-top-progress hidden>
            <div><b><span data-progress-title>等待生成</span><em data-progress-action></em></b><span data-progress-batch>分镜 0/0</span></div>
            <progress data-progress-bar max="100" value="0"></progress>
          </div>
          <div class="xve-error-notice" data-error-notice hidden role="alert">
            <div><strong data-error-title>生成失败</strong><span data-error-message></span></div>
            <button type="button" data-error-close title="关闭错误提示" aria-label="关闭错误提示">×</button>
          </div>
          <button type="button" class="xve-settings-button" data-settings-toggle title="生成设置" aria-label="生成设置">⚙</button>
          <button type="button" data-close-workbench title="关闭工作台" aria-label="关闭工作台">×</button>
          <div class="xve-generation-settings" data-generation-settings hidden>
            <strong>批量生成设置</strong>
            <label><input type="checkbox" data-cleanup-cache> 卸载缓存</label>
            <label><input type="checkbox" data-cleanup-vram> 卸载显存</label>
            <label><input type="checkbox" data-cleanup-models> 卸载模型</label>
            <label>每 <input type="number" min="1" max="99" step="1" data-cleanup-every> 个分镜卸载一次</label>
            <label><input type="checkbox" data-monitor-hardware> 监控硬件</label>
            <small>计数在每次开始或停止批量任务时重置</small>
          </div>
        </header>
        <main class="xve-main">
          <aside class="xve-library xve-panel">
            <div class="xve-library-top">
              <div class="xve-resolution-settings">
                <label><span>宽高比</span><select data-video-aspect><option value="1:1">1:1（方形）</option><option value="2:3">2:3（竖幅照片）</option><option value="3:2">3:2（照片）</option><option value="3:4">3:4（竖幅标准）</option><option value="4:3">4:3（标准）</option><option value="9:16">9:16（竖幅宽屏）</option><option value="16:9">16:9（宽屏）</option><option value="21:9">21:9（超宽屏）</option></select></label>
                <label><span>分辨率</span><select data-video-megapixels></select></label>
                <div><span>生成帧数</span><output data-video-frame-count></output></div>
              </div>
              <input data-file-input type="file" accept="video/*,audio/*,image/*" multiple hidden>
              <div class="xve-global-assets" data-global-assets hidden></div>
            </div>
            <div class="xve-library-tabs"><button type="button" class="active" data-asset-type="image">参考图</button><button type="button" data-asset-type="video">参考视频</button><button type="button" data-asset-type="audio">参考音频</button></div>
            <div class="xve-assets" data-assets></div>
            <div class="xve-library-foot"><button type="button" data-library-open>▣ 资产库</button><select data-reference-size title="多参考图编码尺寸"><option value="match">标准</option><option value="max">MAX</option></select></div>
          </aside>

          <section class="xve-director xve-panel">
            <div class="xve-director-head">
              <div><strong>闲兔导演台 V4</strong><span>MiniMax H3 · V4 · 分镜输出</span></div>
              <p><i></i> 素材与导演参数</p>
            </div>
            <section class="xve-shot-section">
              <h3>分镜管理</h3>
              <div class="xve-shot-tabs" data-shot-tabs></div>
              <div class="xve-shot-toolbar">
                <button type="button" class="xve-expand" data-expand-shots>展开分镜 (<b data-shot-total>1</b>) <span>⌄</span></button>
                <button type="button" class="xve-select-all" data-select-all>全选</button>
                <div class="xve-shot-actions">
                  <button type="button" data-prev-shot title="上一个分镜">←</button>
                  <button type="button" data-next-shot title="下一个分镜">→</button>
                  <button type="button" data-clear-shots>清空分镜</button>
                  <button type="button" data-delete-shot>删除</button>
                  <button type="button" data-add-shot><b>＋</b> 分镜</button>
                </div>
              </div>
            </section>
            <section class="xve-generation-section">
              <h3>生成设置</h3>
              <div class="xve-batch-main">
                <div class="xve-batch-actions">
                  <button type="button" data-download-sheet>⇩ 下载表格</button>
                  <button type="button" data-upload-sheet>↥ 上传表格</button>
                  <button type="button" class="xve-repair-button face" data-face-repair>人脸修复</button>
                  <div class="xve-generate-tools">
                    <label class="xve-filename-prefix"><span>保存文件名</span><input type="text" maxlength="80" placeholder="留空按分镜名；例：天华 或 /西游记/天华" data-filename-prefix></label>
                    <label class="xve-check xve-continuity-toggle"><input type="checkbox" data-cascade checked><span></span>承接上一视频尾帧</label>
                    <label class="xve-continuity-field" data-continuity-setting>上下文帧数<select data-continuity-frames><option value="5">5帧</option><option value="22" selected>22帧</option><option value="39">39帧</option><option value="56">56帧</option></select></label>
                    <label class="xve-continuity-field xve-redraw-field" data-continuity-setting data-redraw-field>重绘强度<input type="number" min="0" max="0.95" step="0.05" value="0.10" data-continuity-redraw></label>
                    <label class="xve-seconds">秒数 <input type="number" min="1" step="1" value="5" data-seconds></label>
                    <button type="button" class="xve-generate small" data-generate>▶ 开始生成</button>
                  </div>
                </div>
                <input type="file" accept=".csv,.xls,.xlsx,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" data-sheet-file hidden>
              </div>
            </section>
            <section class="xve-mode-section">
              <h3>生成模式</h3>
              <div class="xve-mode-tabs" data-mode-tabs>
                <button type="button" data-mode="text">文生视频</button>
                <button type="button" data-mode="image">图生视频</button>
                <button type="button" data-mode="frames">首尾帧生视频</button>
                <button type="button" class="active" data-mode="reference">全参考生视频</button>
              </div>
            </section>
            <div class="xve-prompt-panel">
              <label for="xve-prompt">单个分镜提示词</label>
              <div id="xve-prompt" data-prompt class="xve-prompt-editor" contenteditable="true" role="textbox" aria-multiline="true" data-placeholder="描述当前分镜的主体、动作、运镜、光线和声音；&#10;点击左侧素材选择参考内容，无需在此重复上传"></div>
              <div class="xve-mention-menu" data-mention-menu hidden></div>
            </div>
          </section>

          <div class="xve-right-column">
            <section class="xve-preview xve-panel">
              <div class="xve-stage" data-stage>
                <div class="xve-stage-empty" data-stage-empty>
                  <svg viewBox="0 0 48 48" aria-hidden="true"><rect x="7" y="7" width="34" height="31" rx="3"></rect><circle cx="31" cy="17" r="4"></circle><path d="M10 34l10-10 7 7 5-5 7 7"></path></svg>
                  <p>将使用左侧素材生成视频<br>生成完成后在下方列表查看</p>
                </div>
                <video data-video playsinline controls preload="auto" hidden></video>
                <video data-video-standby playsinline preload="auto" hidden></video>
                <img data-image alt="生成结果预览" hidden>
              </div>
            </section>
            <section class="xve-results xve-panel">
              <div class="xve-results-head"><strong>生成后视频列表 <span data-result-count>（0）</span></strong><div class="xve-results-actions"><button type="button" data-result-folder>▣ 保存目录</button><button type="button" data-result-merge>▦ 合并输出</button><button type="button" class="refresh" data-result-refresh>⟳ 刷新</button></div></div>
              <nav class="xve-result-tabs"><button type="button" data-result-tab="before">放大前</button><button type="button" class="active" data-result-tab="after">放大后</button><button type="button" data-result-tab="merged">合并成片</button></nav>
              <div class="xve-result-list" data-result-list></div>
              <div class="xve-results-foot"><span data-result-total>共 0 个视频</span><div><label><input type="checkbox" data-result-all> 全部选择</label><button type="button" data-result-delete-selected>批量删除</button></div></div>
            </section>
          </div>
          <section class="xve-timeline xve-panel">
            <header><strong>视频轨道</strong><div class="xve-timeline-tools"><span>时间缩放</span><button type="button" data-timeline-zoom-out>−</button><input type="range" min="20" max="100" step="2" value="38" data-timeline-zoom><button type="button" data-timeline-zoom-in>＋</button><b data-timeline-zoom-value>100%</b></div><span>拖动分镜调整顺序 · 点击轨道定位播放头</span></header>
            <div class="xve-timeline-body">
              <div class="xve-track-labels"><span>时间</span><b>视频轨道</b></div>
              <div class="xve-track-viewport" data-timeline-viewport>
                <div class="xve-time-ruler" data-time-ruler></div>
                <div class="xve-track xve-video-track" data-video-track></div>
                <i class="xve-playhead" data-playhead></i>
              </div>
            </div>
          </section>
        </main>
        <div class="xve-asset-backdrop" data-library-dialog hidden>
          <section class="xve-asset-dialog" role="dialog" aria-modal="true" aria-label="资产库">
            <header><div><b>资产库</b><span data-library-count>共 0 张图片</span></div><button type="button" data-library-close aria-label="关闭">×</button></header>
            <div class="xve-asset-actions"><button type="button" class="primary" data-library-upload>导入公共资产</button><button type="button" data-library-select-all>全部选择</button><button type="button" data-library-select-none>全部取消</button><button type="button" class="danger" data-library-delete>删除选择</button></div>
            <nav class="xve-asset-categories"><button type="button" class="active" data-library-category="all">全部资产</button><button type="button" data-library-category="character">角色资产</button><button type="button" data-library-category="scene">场景资产</button><button type="button" data-library-category="prop">道具资产</button><button type="button" data-library-category="other">其他资产</button><button type="button" data-library-category="camera">运镜资产</button><button type="button" data-library-category="blocking">站位资产</button></nav>
            <div class="xve-asset-library-grid" data-library-grid></div>
            <div class="xve-asset-library-empty" data-library-empty>点击“批量上传图片”或直接拖入图片添加资产</div>
            <footer><button type="button" data-library-close>取消</button><button type="button" class="primary" data-library-apply>应用选中到当前分镜</button></footer>
            <input type="file" accept="image/png,image/jpeg,image/webp" multiple hidden data-library-files>
          </section>
        </div>
        <div class="xve-repair-backdrop" data-repair-dialog hidden>
          <section class="xve-repair-dialog" role="dialog" aria-modal="true" aria-label="视频修复设置">
            <header><div><b data-repair-title>人脸修复</b><span data-repair-subtitle>主采样解码后修复，保存视频前执行</span></div><button type="button" data-repair-close aria-label="关闭">×</button></header>
            <main>
              <section data-face-repair-panel>
                <label class="xve-repair-enable"><input type="checkbox" data-face-enabled><span>启用远景人脸修复</span></label>
                <div class="xve-repair-note"><b>逐帧高分辨率多人生成修复</b><span>开启功能会降低生成的速度，介意的不要开。</span></div>
                <div class="xve-repair-grid">
                  <label><span>修复对象</span><select data-face-target><option>全部人脸</option><option>主要人物</option></select></label>
                  <label><span>修复强度</span><select data-face-strength><option value="0.45">轻微</option><option value="0.65">标准</option><option value="0.85">强烈</option></select></label>
                  <label><span>检测灵敏度</span><select data-face-confidence><option value="0.35">保守</option><option value="0.25">标准</option><option value="0.15">远景优先</option><option value="0.08">超远景多人</option></select></label>
                  <label class="xve-repair-check"><input type="checkbox" data-face-person-fallback><span>同时用人物框补齐漏检小脸</span></label>
                </div>
                <div class="xve-model-path"><b>需要的模型</b><div class="xve-model-row"><code>GFPGANv1.4.pth</code><small>放到 ComfyUI/models/facerestore/（生成式人脸恢复）</small><i data-face-model-status="faceRestore">检测中</i></div><div class="xve-model-row"><code>face_yolov8m.pt</code><small>放到 ComfyUI/models/ultralytics/bbox/</small><i data-face-model-status="faceDetector">检测中</i></div><div class="xve-model-row"><code>person_yolov8m-seg.pt</code><small>放到 ComfyUI/models/ultralytics/segm/（关闭人物兜底时可不装）</small><i data-face-model-status="personDetector">检测中</i></div></div>
              </section>
            </main>
            <footer><button type="button" data-repair-close>取消</button><button type="button" class="primary" data-repair-save>保存设置</button></footer>
          </section>
        </div>
        <div class="xve-text-dialog-backdrop" data-text-dialog hidden>
          <section class="xve-text-dialog" role="dialog" aria-modal="true">
            <header><b data-text-dialog-title>编辑</b><button type="button" data-text-dialog-cancel aria-label="关闭">×</button></header>
            <div><label data-text-dialog-label>名称</label><input type="text" data-text-dialog-input autocomplete="off"></div>
            <footer><button type="button" data-text-dialog-cancel>取消</button><button type="button" class="primary" data-text-dialog-confirm>确定</button></footer>
          </section>
        </div>
      </section>`;

    const q = (selector) => root.querySelector(selector);
    const showDirectorError = (message = "", nodeId = "") => {
        const notice = q("[data-error-notice]");
        const text = String(message || "").trim();
        notice.hidden = !text;
        q("[data-error-title]").textContent = nodeId ? `节点 ${nodeId} 执行失败` : "生成失败";
        q("[data-error-message]").textContent = text;
        notice.title = text;
    };
    q("[data-error-close]").onclick = () => showDirectorError();
    const editorStateWidget = (node.widgets || []).find((widget) => widget.name === "editor_state");
    const input = q("[data-file-input]");
    const assetsElement = q("[data-assets]");
    const video = q("[data-video]");
    const standbyVideo = q("[data-video-standby]");
    const image = q("[data-image]");
    const empty = q("[data-stage-empty]");
    const textDialog = q("[data-text-dialog]");
    let resolveTextDialog = null;
    const closeTextDialog = (value = null) => {
        textDialog.hidden = true;
        const resolve = resolveTextDialog;
        resolveTextDialog = null;
        resolve?.(value);
    };
    const openTextDialog = ({ title, label, value = "", maxLength = 80 }) => new Promise((resolve) => {
        if (resolveTextDialog) closeTextDialog(null);
        resolveTextDialog = resolve;
        q("[data-text-dialog-title]").textContent = title;
        q("[data-text-dialog-label]").textContent = label;
        const field = q("[data-text-dialog-input]");
        field.maxLength = maxLength;
        field.value = value;
        textDialog.hidden = false;
        requestAnimationFrame(() => { field.focus(); field.select(); });
    });
    root.querySelectorAll("[data-text-dialog-cancel]").forEach((button) => { button.onclick = () => closeTextDialog(null); });
    q("[data-text-dialog-confirm]").onclick = () => closeTextDialog(q("[data-text-dialog-input]").value);
    textDialog.onclick = (event) => { if (event.target === textDialog) closeTextDialog(null); };
    textDialog.onkeydown = (event) => {
        event.stopPropagation();
        if (event.key === "Escape") closeTextDialog(null);
        if (event.key === "Enter") closeTextDialog(q("[data-text-dialog-input]").value);
    };
    const filenamePrefixStorageKey = `xiantu.video-editor.filename-prefix:${location.hash || location.pathname}:${node.id}`;
    const editorStateStorageKey = `xiantu.video-editor.state:${location.hash || location.pathname}:${node.id}`;
    const persistedFilenamePrefix = (() => {
        try { return localStorage.getItem(filenamePrefixStorageKey); }
        catch { return null; }
    })();
    const initialState = (() => {
        const widgetValue = String(editorStateWidget?.value || "").trim();
        const propertyValue = node.properties?.xiantuVideoEditorState;
        const candidates = [];
        const addCandidate = (value) => {
            try {
                const parsed = typeof value === "string" ? JSON.parse(value) : structuredClone(value);
                if (parsed && typeof parsed === "object") candidates.push(parsed);
            } catch {}
        };
        if (widgetValue && widgetValue !== "{}") addCandidate(widgetValue);
        if (propertyValue && (typeof propertyValue === "object" || String(propertyValue).trim())) addCandidate(propertyValue);
        try { addCandidate(localStorage.getItem(editorStateStorageKey)); } catch {}
        return candidates.sort((left, right) => Number(right?.updated_at || 0) - Number(left?.updated_at || 0))[0] || {};
    })();
    const savedAssetRecords = Array.isArray(initialState.assets) ? initialState.assets : [];
    const results = Array.isArray(initialState.results) ? initialState.results.map((result) => ({ ...result })) : [];
    let resultView = ["before", "after", "merged"].includes(initialState.resultView) ? initialState.resultView : "after";
    const resultKind = (result) => {
        const path = `/${result?.subfolder || ""}/${result?.filename || ""}/`.replaceAll("\\", "/");
        if (result?.merged || path.includes("/合并成品/") || path.includes("/合并成片/")) return "merged";
        if (path.includes("/放大前/") || /^H3_Director_Final/i.test(String(result?.filename || ""))) return "before";
        return "after";
    };
    const referenceSizeExplicitAtLoad = initialState.referenceSizeExplicit === true;
    let shots = Array.isArray(initialState.shots) && initialState.shots.length
        ? initialState.shots.map((shot, index) => ({ ...shot, id: String(shot.id || makeId()), title: String(shot.title || `分镜 ${index + 1}`), selected: shot.selected !== false, prompt: String(shot.prompt || ""), mode: String(shot.mode || "reference"), seconds: Number(shot.seconds || 5), inheritPrevious: index > 0 && (shot.inheritPrevious ?? initialState.continuityEnabled ?? true), referenceSize: referenceSizeExplicitAtLoad && (shot.referenceSize === "max" || (shot.referenceSize == null && initialState.referenceSize === "max")) ? "max" : "match" }))
        : [{ id: makeId(), title: "分镜 1", selected: true, prompt: "", mode: "reference", seconds: 5, inheritPrevious: false, referenceSize: "match" }];
    let activeShotId = String(initialState.activeShotId || shots[0].id);
    if (!shots.some((shot) => shot.id === activeShotId)) activeShotId = shots[0].id;
    const assetList = savedAssetRecords.map((asset) => ({
        ...asset,
        id: String(asset.id || makeId()),
        shotId: String(asset.shotId || activeShotId),
        sourceAssetId: String(asset.sourceAssetId || ""),
        sourceCategory: String(asset.sourceCategory || ""),
        sourceContentHash: String(asset.sourceContentHash || ""),
        sourceRelativePath: String(asset.sourceRelativePath || ""),
        sourcePath: String(asset.sourcePath || ""),
        serverName: String(asset.serverName || ""),
        subfolder: String(asset.subfolder || ""),
        sourceType: String(asset.sourceType || "input"),
        alias: String(asset.alias || ""),
        note: String(asset.note || ""),
        global: Boolean(asset.global),
        url: persistedAssetUrl(asset),
    }));
    let filenamePrefix = String(persistedFilenamePrefix !== null ? persistedFilenamePrefix : (initialState.filenamePrefix || ""));
    let referenceSizeExplicit = referenceSizeExplicitAtLoad;
    let referenceSize = referenceSizeExplicit && initialState.referenceSize === "max" ? "max" : "match";
    let modelProfile = ["minimax-h3"].includes(String(initialState.modelProfile)) ? String(initialState.modelProfile) : "minimax-h3";
    const resolutionRatios = { "1:1": 1, "2:3": 2 / 3, "3:2": 3 / 2, "3:4": 3 / 4, "4:3": 4 / 3, "9:16": 9 / 16, "16:9": 16 / 9, "21:9": 21 / 9 };
    const resolutionState = {
        aspect: resolutionRatios[initialState.resolution?.aspect] ? initialState.resolution.aspect : "16:9",
        megapixels: Math.max(0.1, Math.min(3, Number(initialState.resolution?.megapixels || 1))),
        multiple: 32,
        fps: 24,
    };
    let timelineScale = Math.max(20, Math.min(100, Number(initialState.timelineScale || 38)));
    const continuityFrameChoices = [22, 39, 56];
    const snapContinuityFrames = (value) => continuityFrameChoices.reduce((best, item) => Math.abs(item - Number(value || 22)) < Math.abs(best - Number(value || 22)) ? item : best, 22);
    let continuityEnabled = initialState.continuityEnabled ?? initialState.continuity?.enabled ?? true;
    let continuityOverlapFrames = snapContinuityFrames(initialState.continuityOverlapFrames ?? initialState.continuity?.frames ?? 22);
    const continuityMode = "continue";
    let continuityRedraw = Math.max(0, Math.min(0.95, Number(initialState.continuityRedraw ?? initialState.continuity?.redraw ?? 0.10)));
    const cleanupSettings = {
        cache: Boolean(initialState.cleanupSettings?.cache),
        vram: Boolean(initialState.cleanupSettings?.vram),
        models: Boolean(initialState.cleanupSettings?.models),
        every: Math.max(1, Math.min(99, Number(initialState.cleanupSettings?.every || 1))),
        monitorHardware: Boolean(initialState.cleanupSettings?.monitorHardware),
    };
    const faceRepairSettings = {
        enabled: Boolean(initialState.faceRepair?.enabled),
        target: initialState.faceRepair?.target === "主要人物" ? "主要人物" : "全部人脸",
        strength: Number(initialState.faceRepair?.strength || 0.65),
        confidence: Number(initialState.faceRepair?.confidence || 0.25),
        personFallback: initialState.faceRepair?.personFallback !== false,
        cropFactor: 2.25,
        minimumFrames: 2,
        detectionSize: 1280,
        maximumFaces: 300,
    };
    let generationProgress = (() => {
        const saved = runtime.progress || node.properties?.xiantuVideoProgress || initialState.generationProgress;
        return runtime.busy && saved && typeof saved === "object"
            ? { title: String(saved.title || "等待生成"), actionDetail: String(saved.actionDetail || ""), batchDetail: String(saved.batchDetail || saved.detail || "分镜 0/0"), percent: saved.percent === null ? null : Math.max(0, Math.min(100, Number(saved.percent) || 0)), phase: String(saved.phase || "prepare"), phasePercent: saved.phasePercent === null ? null : Math.max(0, Math.min(100, Number(saved.phasePercent) || 0)) }
            : { title: "等待生成", actionDetail: "", batchDetail: "分镜 0/0", percent: 0, phase: "prepare", phasePercent: 0 };
    })();
    runtime.progressTrace = Array.isArray(runtime.progressTrace) ? runtime.progressTrace : [];
    runtime.externalBusy = false;
    let hardwareTimer = null;
    let generationElapsedTimer = null;
    let previewResult = null;
    let selectedAssetIds = new Set();
    let activeAssetType = "image";
    let shotsExpanded = false;
    let libraryAssets = [];
    let libraryCategory = "all";
    let libraryDbPromise;

    const resolutionFor = (megapixels = resolutionState.megapixels, aspect = resolutionState.aspect) => {
        const pixels = Math.max(0.1, Number(megapixels) || 1) * 1024 * 1024;
        const ratio = resolutionRatios[aspect] || resolutionRatios["16:9"];
        const width = Math.max(32, Math.round(Math.sqrt(pixels * ratio) / 32) * 32);
        const height = Math.max(32, Math.round(Math.sqrt(pixels / ratio) / 32) * 32);
        return { width, height };
    };
    const targetOutputFrames = (seconds = activeShot()?.seconds || 5) => (
        Math.max(1, Math.round(Math.max(0, Number(seconds) || 0) * resolutionState.fps))
    );
    const generationFrames = (seconds = activeShot()?.seconds || 5) => {
        const base = Math.max(5, Math.round(Math.max(0, Number(seconds) || 0) * resolutionState.fps));
        return base + (5 - (base % 17) + 17) % 17;
    };
    const renderResolutionSettings = () => {
        const aspect = q("[data-video-aspect]");
        const megapixels = q("[data-video-megapixels]");
        if (!aspect || !megapixels) return;
        aspect.value = resolutionState.aspect;
        if (!megapixels.options.length) {
            for (let index = 1; index <= 30; index += 1) {
                const value = (index / 10).toFixed(1);
                const option = document.createElement("option");
                option.value = value;
                megapixels.appendChild(option);
            }
        }
        [...megapixels.options].forEach((option) => {
            const value = Number(option.value).toFixed(1);
            const { width, height } = resolutionFor(value);
            option.textContent = `${value} MP · ${width} × ${height}`;
        });
        megapixels.value = Number(resolutionState.megapixels).toFixed(1);
        const { width, height } = resolutionFor();
        const seconds = Number(activeShot()?.seconds || 5);
        const secondsLabel = Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);
        q("[data-video-frame-count]").textContent = `${targetOutputFrames(seconds)} 帧 · ${secondsLabel}秒 · ${resolutionState.fps} FPS`;
        q("[data-video-frame-count]").title = `${width} × ${height}，帧数按 5 + 17n 对齐`;
    };

    // IndexedDB is retained only as an explicit one-time migration source.
    // The live library always comes from the launcher's shared folder.
    const openLegacyLibraryDb = () => libraryDbPromise ||= new Promise((resolve, reject) => {
        const request = indexedDB.open("xiantu_video_editor_assets", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("assets", { keyPath: "id" });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    const libraryStoreRequest = async (mode, operation) => {
        const db = await openLegacyLibraryDb();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction("assets", mode);
            const store = transaction.objectStore("assets");
            const request = operation(store);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    };
    const commonAssetRequest = async (path, options = {}) => {
        const response = await api.fetchApi(path, options);
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `公共资产库操作失败（HTTP ${response.status}）`);
        return payload;
    };
    const commonAssetUrl = (asset) => api.apiURL(`/xiantu/video-editor/common-assets/content?${new URLSearchParams({ id: String(asset.id), v: String(asset.updatedAt || "") }).toString()}`);
    const loadLibraryAssets = async () => {
        const selected = new Set(libraryAssets.filter((asset) => asset.selected).map((asset) => String(asset.id)));
        const snapshot = await commonAssetRequest("/xiantu/video-editor/common-assets");
        libraryAssets = (snapshot.assets || []).map((asset) => ({ ...asset, selected: selected.has(String(asset.id)), url: commonAssetUrl(asset) }));
        return snapshot;
    };

    const activeShot = () => shots.find((shot) => shot.id === activeShotId) || shots[0];
    const effectiveAssetsForShot = (shot = activeShot()) => assetList.filter((asset) => {
        if (!shot) return false;
        if (asset.global) return shot.mode === "reference";
        return asset.shotId === shot.id;
    });
    const sourceLibraryAsset = (asset) => libraryAssets.find((item) => String(item.id) === String(asset.sourceAssetId || ""));
    const assetNote = (asset) => String(sourceLibraryAsset(asset)?.note ?? asset.note ?? "").trim();
    const mentionItems = () => {
        const counters = { image: 0, video: 0, audio: 0 };
        return effectiveAssetsForShot().map((asset) => {
            const kind = asset.type.startsWith("video/") ? "video" : asset.type.startsWith("audio/") ? "audio" : "image";
            counters[kind] += 1;
            const number = counters[kind];
            const defaultLabel = kind === "video" ? `视频${number}` : kind === "audio" ? `音频${number}` : `图片${number}`;
            const label = String(asset.alias || sourceLibraryAsset(asset)?.name || "").trim() || defaultLabel;
            const tag = kind === "video" ? `<Video ${number}>` : kind === "audio" ? `<Audio ${number}>` : `<Picture ${number}>`;
            return { asset, kind, label, defaultLabel, tag, number };
        });
    };
    const mentionForAsset = (asset) => mentionItems().find((item) => item.asset === asset);
    const displayAssetName = (asset) => {
        if (activeShot()?.mode !== "reference") return asset.name;
        return mentionForAsset(asset)?.label || asset.name;
    };
    const promptText = (editor = q("[data-prompt]")) => {
        const read = (node) => {
            if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || "";
            if (node.nodeType !== Node.ELEMENT_NODE) return "";
            if (node.matches?.(".xve-prompt-token")) return node.dataset.tag || "";
            if (node.tagName === "BR") return "\n";
            const text = [...node.childNodes].map(read).join("");
            return node !== editor && /^(DIV|P)$/.test(node.tagName) ? `${text}\n` : text;
        };
        return [...editor.childNodes].map(read).join("").replace(/\u00a0/g, " ").replace(/\n+$/, "");
    };
    const createPromptToken = (item) => {
        const token = document.createElement("span");
        token.className = `xve-prompt-token xve-ref-color-${(item.number - 1) % 9 + 1}`;
        token.contentEditable = "false";
        token.dataset.tag = item.tag;
        token.title = item.tag;
        const note = assetNote(item.asset);
        const label = note ? `${item.label} - ${note}` : item.label;
        token.innerHTML = `${item.kind === "image" ? `<img src="${item.asset.url}" alt="">` : `<i>${item.kind === "video" ? "▶" : "♫"}</i>`}<b>${escapeHtml(label)}</b>`;
        return token;
    };
    const renderPromptContent = (rawValue) => {
        const editor = q("[data-prompt]");
        const itemsByKey = new Map(mentionItems().map((item) => [`${item.kind}:${item.number}`, item]));
        const raw = String(rawValue || "");
        const pattern = /<\s*(Picture|Video|Audio)\s*(\d+)\s*>/gi;
        let cursor = 0;
        editor.replaceChildren();
        for (const match of raw.matchAll(pattern)) {
            if (match.index > cursor) editor.append(document.createTextNode(raw.slice(cursor, match.index)));
            const kind = match[1].toLowerCase() === "picture" ? "image" : match[1].toLowerCase();
            const item = itemsByKey.get(`${kind}:${Number(match[2])}`);
            editor.append(item ? createPromptToken(item) : document.createTextNode(match[0]));
            cursor = match.index + match[0].length;
        }
        if (cursor < raw.length) editor.append(document.createTextNode(raw.slice(cursor)));
    };
    const renameAsset = async (asset) => {
        const mention = mentionForAsset(asset);
        const current = String(asset.alias || mention?.defaultLabel || asset.name || "");
        const value = await openTextDialog({ title: "修改图片名称", label: "显示名称", value: current, maxLength: 40 });
        if (value === null) return;
        asset.alias = String(value).trim().slice(0, 40);
        renderAssets();
        save();
    };
    const formatDuration = (seconds) => {
        const value = Math.max(0, Number(seconds) || 0);
        const minutes = Math.floor(value / 60);
        const secs = Math.floor(value % 60);
        return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    };
    const save = () => {
        const nextState = {
            version: 2,
            activeShotId,
            modelProfile,
            filenamePrefix,
            referenceSize,
            referenceSizeExplicit,
            resolution: { ...resolutionState, ...resolutionFor() },
            timelineScale,
            continuityEnabled,
            continuityOverlapFrames,
            continuityMode,
            continuityRedraw,
            cleanupSettings: { ...cleanupSettings },
            faceRepair: structuredClone(faceRepairSettings),
            generationProgress: { ...generationProgress },
            shots,
            assets: assetList.map(({ id, sourceAssetId, sourceCategory, sourceContentHash, sourceRelativePath, sourcePath, serverName, subfolder, sourceType, shotId, name, alias, note, type, duration, width, height, global }) => ({ id, sourceAssetId: String(sourceAssetId || ""), sourceCategory: String(sourceCategory || ""), sourceContentHash: String(sourceContentHash || ""), sourceRelativePath: String(sourceRelativePath || ""), sourcePath: String(sourcePath || ""), serverName: String(serverName || ""), subfolder: String(subfolder || ""), sourceType: String(sourceType || "input"), shotId, name, alias: String(alias || ""), note: String(note || ""), type, duration, width, height, global: Boolean(global) })),
            selectedAssetIds: [...selectedAssetIds],
            results,
            resultView,
            updated_at: Date.now(),
        };
        const serialized = JSON.stringify(nextState);
        const changed = String(editorStateWidget?.value || "") !== serialized;
        if (editorStateWidget) editorStateWidget.value = serialized;
        node.properties ??= {};
        node.properties.xiantuVideoEditorState = structuredClone(nextState);
        try { localStorage.setItem(filenamePrefixStorageKey, filenamePrefix); } catch {}
        try { localStorage.setItem(editorStateStorageKey, serialized); } catch {}
        if (changed) node.graph?.change?.();
        node.graph?.setDirtyCanvas?.(true, true);
        node.setDirtyCanvas?.(true, true);
    };
    const updatePrompt = () => {
        const shot = activeShot();
        if (!shot) return;
        shot.prompt = promptText();
        shot.seconds = Math.max(1, Number(q("[data-seconds]").value) || 5);
        renderResolutionSettings();
        renderTimeline();
        save();
    };
    const loadShot = () => {
        const shot = activeShot();
        if (!shot) return;
        q("[data-seconds]").value = String(shot.seconds || 5);
        root.querySelectorAll("[data-mode]").forEach((button) => button.classList.toggle("active", button.dataset.mode === shot.mode));
        continuityEnabled = Boolean(shot.inheritPrevious);
        referenceSize = shot.referenceSize === "max" ? "max" : "match";
        syncModeUI();
        syncContinuityUI();
        renderPromptContent(shot.prompt);
        renderResolutionSettings();
    };
    const syncContinuityUI = () => {
        const firstShot = shots.findIndex((shot) => shot.id === activeShotId) <= 0;
        if (firstShot) { continuityEnabled = false; if (activeShot()) activeShot().inheritPrevious = false; }
        q("[data-cascade]").checked = Boolean(continuityEnabled);
        q("[data-cascade]").disabled = firstShot;
        q("[data-continuity-frames]").value = String(continuityOverlapFrames);
        q("[data-continuity-redraw]").value = continuityRedraw.toFixed(2);
        q("[data-continuity-frames]").disabled = !continuityEnabled;
        q("[data-continuity-redraw]").disabled = !continuityEnabled;
        root.querySelectorAll("[data-continuity-setting]").forEach((field) => { field.hidden = firstShot || !continuityEnabled; });
    };
    const renderShots = () => {
        const tabs = q("[data-shot-tabs]");
        const previousScrollLeft = tabs.scrollLeft;
        tabs.replaceChildren();
        shots.forEach((shot, index) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "xve-shot-tab";
            button.classList.toggle("active", shot.id === activeShotId);
            button.title = shot.title || `分镜 ${index + 1}`;
            button.innerHTML = `<span class="xve-shot-check ${shot.selected ? "checked" : ""}">✓</span><b>分镜 ${String(index + 1).padStart(2, "0")}</b>${shot.id === activeShotId ? '<i>×</i>' : ""}`;
            button.onclick = (event) => {
                if (event.target.closest(".xve-shot-check")) {
                    shot.selected = !shot.selected;
                    renderShots(); save(); return;
                }
                if (event.target.closest("i")) {
                    if (shots.length === 1) return;
                    const position = shots.indexOf(shot);
                    shots.splice(position, 1);
                    activeShotId = shots[Math.min(position, shots.length - 1)].id;
                    renderShots(); loadShot(); save(); return;
                }
                updatePrompt(); activeShotId = shot.id; renderShots(); loadShot(); save();
            };
            tabs.appendChild(button);
        });
        tabs.scrollLeft = previousScrollLeft;
        q("[data-shot-total]").textContent = String(shots.length);
    };
    const moveShot = (offset) => {
        updatePrompt();
        const index = shots.findIndex((shot) => shot.id === activeShotId);
        const next = Math.max(0, Math.min(shots.length - 1, index + offset));
        activeShotId = shots[next].id; renderShots(); loadShot(); save();
    };
    const renderGlobalAssets = () => {
        const host = q("[data-global-assets]");
        host.replaceChildren();
        host.classList.add("placeholder");
        host.setAttribute("aria-label", "全局参考功能占位");
    };
    const renderAssets = () => {
        assetsElement.replaceChildren();
        const mode = activeShot()?.mode || "reference";
        const typePrefix = `${activeAssetType}/`;
        const autoFirstFrame = mode === "frames" && Boolean(activeShot()?.inheritPrevious);
        const modeLimit = mode === "image" ? 1 : mode === "frames" ? (autoFirstFrame ? 1 : 2) : Infinity;
        const allVisibleAssets = assetList.filter((asset) => {
            const belongsToShot = asset.shotId === activeShotId;
            const fixedForEveryShot = mode === "reference" && asset.global;
            return Boolean(asset.url) && (belongsToShot || fixedForEveryShot) && asset.type.startsWith(typePrefix);
        });
        const visibleAssets = autoFirstFrame ? allVisibleAssets.slice(-1) : allVisibleAssets.slice(0, modeLimit);
        const labels = { image: ["参考图", "图片", "image/*"], video: ["参考视频", "视频", "video/*"], audio: ["参考音频", "音频", "audio/*"] };
        let [title, noun, accept] = labels[activeAssetType];
        if (mode === "image") title = "输入图片";
        if (mode === "frames") title = autoFirstFrame ? "尾帧" : "首尾帧";
        input.accept = accept;
        const meta = document.createElement("div");
        meta.className = "xve-reference-meta";
        meta.textContent = mode === "frames" ? (autoFirstFrame ? `首帧自动承接上一分镜 · 当前尾帧 ${visibleAssets.length}/1` : `当前分镜${title} ${visibleAssets.length}/2`) : `当前分镜${title} ${visibleAssets.length}${Number.isFinite(modeLimit) ? `/${modeLimit}` : " 个"}`;
        assetsElement.appendChild(meta);
        visibleAssets.forEach((asset, assetIndex) => {
            const card = document.createElement("article");
            card.className = "xve-asset";
            card.classList.toggle("selected", selectedAssetIds.has(asset.id));
            card.classList.toggle("global", Boolean(asset.global));
            card.draggable = true;
            const visual = asset.type.startsWith("image/")
                ? `<img src="${asset.url}" alt="">`
                : asset.type.startsWith("video/")
                    ? `<video src="${asset.url}" muted preload="metadata"></video>`
                    : `<div class="xve-audio-art">♫</div>`;
            const mention = mode === "reference" ? mentionForAsset(asset) : null;
            const detail = mention?.tag || (asset.type.startsWith("image/") && asset.width ? `${asset.width} × ${asset.height}` : formatDuration(asset.duration));
            const tagClass = mention ? ` class="xve-ref-tag xve-ref-color-${(mention.number - 1) % 9 + 1}"` : "";
            card.innerHTML = `${visual}<div><b title="${escapeHtml(asset.name)}">${escapeHtml(displayAssetName(asset))}</b><small${tagClass}>${escapeHtml(detail || (asset.type.startsWith("audio/") ? "音频" : "素材"))}</small></div><button type="button" title="更多">⋮</button>`;
            const note = assetNote(asset);
            if (note) {
                const badge = document.createElement("em");
                badge.className = "xve-asset-note";
                badge.title = note;
                badge.textContent = note;
                card.appendChild(badge);
            }
            if (mode === "frames") {
                const badge = document.createElement("em");
                badge.className = "xve-frame-badge";
                badge.textContent = autoFirstFrame ? "尾帧" : (assetIndex === 0 ? "首帧" : "尾帧");
                card.appendChild(badge);
            }
            card.onclick = (event) => {
                if (event.target.closest("button")) return;
                if (selectedAssetIds.has(asset.id)) selectedAssetIds.delete(asset.id); else selectedAssetIds.add(asset.id);
                renderAssets(); save();
            };
            card.ondragstart = (event) => event.dataTransfer.setData("text/x-xiantu-video-asset", asset.id);
            card.querySelector("button").onclick = (event) => {
                event.stopPropagation();
                root.querySelectorAll(".xve-asset-menu").forEach((menu) => menu.remove());
                const menu = document.createElement("div");
                menu.className = "xve-asset-menu";
                menu.innerHTML = `<button type="button" data-rename-asset>改名</button><button type="button" data-make-global>${asset.global ? "取消全局" : "设为全局"}</button><button type="button" class="danger" data-delete-asset>删除</button>`;
                menu.querySelector("[data-rename-asset]").onclick = (menuEvent) => { menuEvent.stopPropagation(); renameAsset(asset); };
                menu.querySelector("[data-make-global]").onclick = (menuEvent) => { menuEvent.stopPropagation(); asset.global = !asset.global; renderAssets(); save(); };
                menu.querySelector("[data-delete-asset]").onclick = (menuEvent) => {
                    menuEvent.stopPropagation();
                    const index = assetList.indexOf(asset);
                    URL.revokeObjectURL(asset.url);
                    assetList.splice(index, 1); selectedAssetIds.delete(asset.id); renderAssets(); save();
                };
                card.appendChild(menu);
            };
            assetsElement.appendChild(card);
        });
        const needsUploadSlot = mode === "image" ? visibleAssets.length < 1 : mode === "frames" ? visibleAssets.length < modeLimit : !visibleAssets.length;
        if (needsUploadSlot) {
            const hint = document.createElement("button");
            hint.type = "button";
            hint.className = "xve-reference-empty";
            const uploadName = mode === "frames" ? (autoFirstFrame ? "尾帧" : (visibleAssets.length ? "尾帧" : "首帧")) : noun;
            hint.innerHTML = `<b>＋ 点击上传${uploadName}</b><span>也可以把${uploadName}直接拖到这里</span>`;
            hint.onclick = () => input.click();
            assetsElement.appendChild(hint);
        }
        renderGlobalAssets();
        renderTimeline();
    };
    const syncModeUI = () => {
        const mode = activeShot()?.mode || "reference";
        root.classList.toggle("xve-mode-text", mode === "text");
        const imageOnly = mode === "image" || mode === "frames";
        root.classList.toggle("xve-mode-image-only", imageOnly);
        root.classList.toggle("xve-mode-frames", mode === "frames");
        root.classList.toggle("xve-mode-single-image", mode === "image");
        q("[data-reference-size]").value = referenceSize;
        q("[data-reference-size]").disabled = mode !== "reference";
        q('[data-asset-type="image"]').textContent = mode === "frames" ? "首尾帧" : mode === "image" ? "输入图片" : "参考图";
        root.querySelectorAll("[data-asset-type]").forEach((button) => {
            button.hidden = imageOnly && button.dataset.assetType !== "image";
        });
        if (imageOnly) {
            activeAssetType = "image";
            root.querySelectorAll("[data-asset-type]").forEach((button) => button.classList.toggle("active", button.dataset.assetType === "image"));
        }
        input.multiple = mode !== "image" && !(mode === "frames" && Boolean(activeShot()?.inheritPrevious));
        renderAssets();
    };
    const hideMentionMenu = () => { q("[data-mention-menu]").hidden = true; };
    let promptMentionRange = null;
    const insertMention = (tag) => {
        const editor = q("[data-prompt]");
        const item = mentionItems().find((candidate) => candidate.tag === tag);
        if (!item) return;
        const selection = window.getSelection();
        const range = promptMentionRange?.cloneRange() || document.createRange();
        if (!promptMentionRange) {
            range.selectNodeContents(editor);
            range.collapse(false);
        }
        if (range.startContainer.nodeType === Node.TEXT_NODE && range.startOffset > 0 && range.startContainer.nodeValue?.[range.startOffset - 1] === "@") {
            range.setStart(range.startContainer, range.startOffset - 1);
        }
        range.deleteContents();
        const token = createPromptToken(item);
        const spacer = document.createTextNode("\u00a0");
        range.insertNode(spacer);
        range.insertNode(token);
        range.setStartAfter(spacer);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        promptMentionRange = null;
        editor.focus();
        hideMentionMenu();
        updatePrompt();
    };
    const showMentionMenu = () => {
        const menu = q("[data-mention-menu]");
        const items = mentionItems();
        if (!items.length) { hideMentionMenu(); return; }
        menu.replaceChildren();
        items.forEach((item) => {
            const button = document.createElement("button");
            button.type = "button";
            const preview = item.kind === "image" ? `<img src="${item.asset.url}" alt="">` : `<i>${item.kind === "video" ? "▶" : "♫"}</i>`;
            const note = assetNote(item.asset);
            const mentionLabel = note ? `${item.label} - ${note}` : item.label;
            button.innerHTML = `${preview}<span><b>${escapeHtml(mentionLabel)}</b><small>${escapeHtml(item.tag)}</small></span>`;
            button.onclick = (event) => { event.stopPropagation(); insertMention(item.tag); };
            menu.appendChild(button);
        });
        menu.hidden = false;
    };
    const uploadMedia = async (file) => {
        const form = new FormData();
        form.append("media", file, file.name || "media");
        const response = await api.fetchApi("/xiantu/video-editor/upload-media", { method: "POST", body: form });
        let result = {};
        try { result = await response.json(); } catch {}
        if (!response.ok || !result.name) throw new Error(result.error || `保存素材失败（HTTP ${response.status}）`);
        return result;
    };
    const importFiles = async (files) => {
        const previousExternalBusy = runtime.externalBusy;
        runtime.externalBusy = true;
        const mode = activeShot()?.mode || "reference";
        const validFiles = [...files].filter((file) => file.type.startsWith(`${activeAssetType}/`));
        try {
            setGenerationProgress({ title: "读取上传文件", actionDetail: `发现 ${validFiles.length} 个${activeAssetType === "image" ? "图片" : activeAssetType === "video" ? "视频" : "音频"}`, batchDetail: `素材 0/${validFiles.length}`, percent: 0, phase: "prepare", phasePercent: 0 });
            await new Promise((resolve) => requestAnimationFrame(resolve));
            if (mode === "image" && validFiles.length) {
                for (let index = assetList.length - 1; index >= 0; index -= 1) {
                    const asset = assetList[index];
                    if (asset.shotId !== activeShotId || !asset.type.startsWith("image/")) continue;
                    URL.revokeObjectURL(asset.url); selectedAssetIds.delete(asset.id); assetList.splice(index, 1);
                }
            }
            const currentCount = assetList.filter((asset) => asset.shotId === activeShotId && asset.type.startsWith(`${activeAssetType}/`)).length;
            const frameLimit = mode === "frames" && Boolean(activeShot()?.inheritPrevious) ? 1 : 2;
            const remaining = mode === "image" ? 1 : mode === "frames" ? Math.max(0, frameLimit - currentCount) : validFiles.length;
            const pendingFiles = validFiles.slice(0, remaining);
            for (let fileIndex = 0; fileIndex < pendingFiles.length; fileIndex += 1) {
                const file = pendingFiles[fileIndex];
                const basePercent = fileIndex / Math.max(1, pendingFiles.length) * 100;
                setGenerationProgress({ title: "上传素材", actionDetail: file.name, batchDetail: `素材 ${fileIndex + 1}/${pendingFiles.length}`, percent: basePercent, phase: "save", phasePercent: 10 });
                const stored = await uploadMedia(file);
                setGenerationProgress({ title: "保存素材到输入目录", actionDetail: stored.name, batchDetail: `素材 ${fileIndex + 1}/${pendingFiles.length}`, percent: (fileIndex + .65) / Math.max(1, pendingFiles.length) * 100, phase: "save", phasePercent: 65 });
                const asset = { id: makeId(), shotId: activeShotId, name: file.name, sourcePath: String(file.path || ""), serverName: stored.name, subfolder: stored.subfolder || "", sourceType: stored.type || "input", type: stored.mimeType || file.type, url: persistedAssetUrl({ serverName: stored.name, subfolder: stored.subfolder, sourceType: stored.type }), duration: 0, width: 0, height: 0 };
                assetList.push(asset);
                setGenerationProgress({ title: "读取素材信息", actionDetail: file.type || "文件", batchDetail: `素材 ${fileIndex + 1}/${pendingFiles.length}`, percent: (fileIndex + .85) / Math.max(1, pendingFiles.length) * 100, phase: "load", phasePercent: 85 });
                if (file.type.startsWith("image/")) {
                    const probe = new Image();
                    probe.onload = () => { asset.width = probe.naturalWidth; asset.height = probe.naturalHeight; renderAssets(); save(); };
                    probe.src = asset.url;
                } else {
                    const probe = document.createElement(file.type.startsWith("audio/") ? "audio" : "video");
                    probe.preload = "metadata"; probe.src = asset.url;
                    probe.onloadedmetadata = () => { asset.duration = Number.isFinite(probe.duration) ? probe.duration : 0; renderAssets(); save(); };
                }
                setGenerationProgress({ title: "素材写入完成", actionDetail: file.name, batchDetail: `素材 ${fileIndex + 1}/${pendingFiles.length}`, percent: (fileIndex + 1) / Math.max(1, pendingFiles.length) * 100, phase: "done", phasePercent: 100 });
                await new Promise((resolve) => requestAnimationFrame(resolve));
            }
            renderAssets();
            renderPromptContent(promptText());
            save();
        } finally {
            runtime.externalBusy = previousExternalBusy;
            runtime.listeners.forEach((listener) => listener(runtime.progress || generationProgress));
        }
    };
    const importLocalMedia = async (path) => {
        const response = await api.fetchApi("/xiantu/video-editor/import-local-media", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: String(path || "").trim() }),
        });
        let result = {};
        try { result = await response.json(); } catch {}
        if (!response.ok || !result.name) throw new Error(result.error || `本地素材导入失败（HTTP ${response.status}）`);
        const view = await api.fetchApi(`/view?${new URLSearchParams({ filename: result.name, subfolder: result.subfolder || "", type: result.type || "input" })}`);
        if (!view.ok) throw new Error(`读取已导入素材失败（HTTP ${view.status}）`);
        const blob = await view.blob();
        return { ...result, blob, mimeType: String(result.mimeType || blob.type || "application/octet-stream") };
    };
    const hydrateLegacyAssets = async () => {
        let changed = false;
        for (const asset of assetList) {
            if (asset.url || !isAbsolutePath(asset.sourcePath)) continue;
            try {
                const imported = await importLocalMedia(asset.sourcePath);
                asset.serverName = imported.name;
                asset.subfolder = imported.subfolder || "";
                asset.sourceType = imported.type || "input";
                asset.type = imported.mimeType || asset.type;
                asset.url = persistedAssetUrl(asset);
                changed = true;
            } catch (error) {
                console.warn("旧参考素材恢复失败", asset.sourcePath, error);
            }
        }
        if (changed) { renderAssets(); save(); }
    };
    const sheetButtonStatus = (button, message, failed = false) => {
        const original = button.dataset.originalText || button.textContent;
        button.dataset.originalText = original;
        button.textContent = message;
        button.style.color = failed ? "#ff8da4" : "#65f3d0";
        clearTimeout(button._xveStatusTimer);
        button._xveStatusTimer = setTimeout(() => { button.textContent = original; button.style.color = ""; }, failed ? 5000 : 2500);
    };
    const downloadSheet = () => {
        updatePrompt();
        const { width, height } = resolutionFor();
        const resolutionLabel = `${Number(resolutionState.megapixels).toFixed(1)} MP · ${width} × ${height}`;
        const rows = [SHEET_COLUMNS, ...shots.map((shot, index) => {
            const assets = effectiveAssetsForShot(shot);
            const paths = (prefix, count) => {
                const values = assets.filter((asset) => asset.type.startsWith(`${prefix}/`)).slice(0, count).map((asset) => String(asset.sourcePath || ""));
                while (values.length < count) values.push("");
                return values;
            };
            return [
                index + 1,
                shot.sheetNumber || String(index + 1).padStart(2, "0"),
                shot.title || `分镜 ${index + 1}`,
                Number(shot.seconds || 5),
                index > 0 && shot.inheritPrevious ? "是" : "否",
                MODE_LABELS[shot.mode] || MODE_LABELS.reference,
                shot.prompt || "",
                shot.referenceSize === "max" ? "MAX" : "标准",
                ...paths("image", 9), ...paths("video", 3), ...paths("audio", 3),
                resolutionState.aspect,
                resolutionLabel,
                filenamePrefix,
            ];
        })];
        downloadCsv(`闲兔视频导演台_${new Date().toISOString().slice(0, 10)}.csv`, rows);
        sheetButtonStatus(q("[data-download-sheet]"), `已下载 ${shots.length} 条`);
    };
    const readSheetRows = async (file) => {
        const form = new FormData();
        form.append("sheet", file, file.name || "storyboard.xlsx");
        const response = await api.fetchApi("/xiantu/video-editor/parse-sheet", { method: "POST", body: form });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `读取表格失败（HTTP ${response.status}）`);
        if (!Array.isArray(payload.rows)) throw new Error("表格解析结果无效");
        return payload.rows;
    };
    const importSheet = async (file) => {
        const button = q("[data-upload-sheet]");
        if (!file) return;
        try {
            const rows = await readSheetRows(file);
            if (rows.length < 2) throw new Error("表格没有分镜数据");
            const headers = rows[0].map((value) => String(value).trim());
            const normalizeHeader = (value) => String(value || "").replace(/^\uFEFF/, "").replace(/\s+/g, "").replace(/[()]/g, (char) => char === "(" ? "（" : "）");
            const normalizedHeaders = headers.map(normalizeHeader);
            const column = (...names) => names.map(normalizeHeader).map((name) => normalizedHeaders.indexOf(name)).find((index) => index >= 0) ?? -1;
            const required = [
                [["分镜编号", "序号", "编号", "镜头编号"], "分镜编号（或序号）"],
                [["分镜名", "分镜名称", "镜头名"], "分镜名"],
                [["秒数", "时长", "时长（秒）"], "秒数"],
                [["是否继承上一帧", "是否继承", "继承上一帧"], "是否继承上一帧"],
                [["生成类型（全参考生视频）", "生成类型"], "生成类型"],
                [["提示词", "分镜提示词"], "提示词"],
                [["图片参数（MAX）", "图片参数"], "图片参数"],
                [["宽高比", "画面比例"], "宽高比"],
                [["分辨率", "生成分辨率"], "分辨率"],
                [["保存文件名", "文件名"], "保存文件名"],
            ];
            for (const [aliases, label] of required) if (column(...aliases) < 0) throw new Error(`缺少列：${label}`);
            const valueAt = (row, ...names) => column(...names) < 0 ? "" : String(row[column(...names)] ?? "").trim();
            const dataRows = rows.slice(1).filter((row) => row.some((value) => String(value).trim()));
            if (!dataRows.length) throw new Error("表格没有可导入的分镜行");
            const first = dataRows[0];
            const aspect = valueAt(first, "宽高比").split(/[（ (]/)[0];
            if (resolutionRatios[aspect]) resolutionState.aspect = aspect;
            const resolutionText = valueAt(first, "分辨率");
            const mpMatch = resolutionText.match(/([0-9]+(?:\.[0-9]+)?)\s*MP/i);
            const sizeMatch = resolutionText.match(/(\d+)\s*[x×*]\s*(\d+)/i);
            if (mpMatch) resolutionState.megapixels = Math.max(0.1, Math.min(3, Number(mpMatch[1]) || 1));
            else if (sizeMatch) resolutionState.megapixels = Math.max(0.1, Math.min(3, Math.round((Number(sizeMatch[1]) * Number(sizeMatch[2]) / (1024 * 1024)) * 10) / 10));
            filenamePrefix = valueAt(first, "保存文件名");

            const importedShots = [];
            const importedAssets = [];
            const mediaCache = new Map();
            const makeAssetFromPath = async (path, expectedType, shotId, rowNumber, label) => {
                const cleanPath = String(path || "").trim().replace(/^"|"$/g, "");
                if (!cleanPath) return;
                if (!isAbsolutePath(cleanPath)) throw new Error(`第 ${rowNumber} 行“${label}”必须填写绝对路径`);
                const key = cleanPath.toLowerCase();
                if (!mediaCache.has(key)) mediaCache.set(key, await importLocalMedia(cleanPath));
                const imported = mediaCache.get(key);
                if (!imported.mimeType.startsWith(`${expectedType}/`)) throw new Error(`第 ${rowNumber} 行“${label}”文件类型不正确`);
                const asset = { id: makeId(), shotId, name: imported.displayName || imported.name, sourcePath: imported.sourcePath || cleanPath, serverName: imported.name, subfolder: imported.subfolder || "", sourceType: imported.type || "input", type: imported.mimeType, url: persistedAssetUrl({ serverName: imported.name, subfolder: imported.subfolder, sourceType: imported.type }), duration: 0, width: 0, height: 0 };
                importedAssets.push(asset);
                if (asset.type.startsWith("image/")) {
                    const probe = new Image();
                    probe.onload = () => { asset.width = probe.naturalWidth; asset.height = probe.naturalHeight; renderAssets(); save(); };
                    probe.src = asset.url;
                } else {
                    const probe = document.createElement(asset.type.startsWith("audio/") ? "audio" : "video");
                    probe.preload = "metadata"; probe.src = asset.url;
                    probe.onloadedmetadata = () => { asset.duration = Number.isFinite(probe.duration) ? probe.duration : 0; renderAssets(); save(); };
                }
            };
            for (let index = 0; index < dataRows.length; index += 1) {
                const row = dataRows[index];
                const rowNumber = index + 2;
                const sheetNumber = valueAt(row, "分镜编号", "序号", "编号", "镜头编号");
                if (!sheetNumber) throw new Error(`第 ${rowNumber} 行没有分镜编号或序号`);
                const modeLabel = valueAt(row, "生成类型（全参考生视频）", "生成类型") || MODE_LABELS.reference;
                const mode = LABEL_MODES[modeLabel];
                if (!mode) throw new Error(`第 ${rowNumber} 行生成类型“${modeLabel}”无效`);
                const shotId = makeId();
                const seconds = Math.max(1, Number(valueAt(row, "秒数", "时长", "时长（秒）")) || 5);
                const yes = ["是", "true", "1", "yes", "继承"].includes(valueAt(row, "是否继承上一帧", "是否继承", "继承上一帧").toLowerCase());
                const shot = { id: shotId, sheetNumber, title: valueAt(row, "分镜名", "分镜名称", "镜头名") || `分镜 ${sheetNumber}`, selected: true, prompt: valueAt(row, "提示词", "分镜提示词"), mode, seconds, inheritPrevious: index > 0 && yes, referenceSize: valueAt(row, "图片参数（MAX）", "图片参数").toUpperCase() === "MAX" ? "max" : "match" };
                importedShots.push(shot);
                for (let ref = 1; ref <= 9; ref += 1) await makeAssetFromPath(valueAt(row, `参考图绝对地址${ref}`), "image", shotId, rowNumber, `参考图绝对地址${ref}`);
                for (let ref = 1; ref <= 3; ref += 1) await makeAssetFromPath(valueAt(row, `参考视频${ref}`), "video", shotId, rowNumber, `参考视频${ref}`);
                for (let ref = 1; ref <= 3; ref += 1) await makeAssetFromPath(valueAt(row, `参考音频${ref}`), "audio", shotId, rowNumber, `参考音频${ref}`);
            }
            assetList.forEach((asset) => URL.revokeObjectURL(asset.url));
            assetList.splice(0, assetList.length, ...importedAssets);
            selectedAssetIds.clear();
            shots = importedShots;
            activeShotId = shots[0].id;
            continuityEnabled = Boolean(shots[0].inheritPrevious);
            referenceSize = shots[0].referenceSize;
            referenceSizeExplicit = shots.some((shot) => shot.referenceSize === "max");
            q("[data-filename-prefix]").value = filenamePrefix;
            renderShots(); loadShot(); renderTimeline(); save();
            sheetButtonStatus(button, `已导入 ${shots.length} 条`);
        } catch (error) {
            console.error("视频导演台表格导入失败", error);
            sheetButtonStatus(button, String(error?.message || error), true);
        }
    };
    const renderLibrary = () => {
        const grid = q("[data-library-grid]");
        const previousScrollTop = grid.scrollTop;
        const visible = libraryAssets.filter((asset) => libraryCategory === "all" || asset.category === libraryCategory);
        grid.replaceChildren();
        visible.forEach((asset) => {
            const card = document.createElement("label");
            card.className = `xve-library-item${asset.selected ? " selected" : ""}`;
            const note = String(asset.note || "").trim();
            const visual = String(asset.mimeType || "").startsWith("video/")
                ? `<video src="${asset.url}" muted preload="metadata"></video>`
                : String(asset.mimeType || "").startsWith("image/")
                    ? `<img src="${asset.url}" alt="">`
                    : `<div class="xve-library-file">${escapeHtml(String(asset.relativePath || "").split("/").at(-1) || "文件")}</div>`;
            card.innerHTML = `${visual}<b title="${escapeHtml(asset.name)}">${escapeHtml(asset.name)}</b><input type="checkbox" ${asset.selected ? "checked" : ""}><button type="button" class="xve-library-note${note ? " has-note" : ""}" title="${escapeHtml(note || "添加备注")}" data-library-note>${escapeHtml(note || "备注")}</button><div class="xve-library-item-foot"><select title="选择资产分类"><option value="character" ${asset.category === "character" ? "selected" : ""}>角色资产</option><option value="scene" ${asset.category === "scene" ? "selected" : ""}>场景资产</option><option value="prop" ${asset.category === "prop" ? "selected" : ""}>道具资产</option><option value="other" ${asset.category === "other" ? "selected" : ""}>其他资产</option><option value="camera" ${asset.category === "camera" ? "selected" : ""}>运镜资产</option><option value="blocking" ${asset.category === "blocking" ? "selected" : ""}>站位资产</option></select><button type="button" data-library-rename>改名</button></div>`;
            const persistLibraryAsset = async (changes) => {
                await commonAssetRequest("/xiantu/video-editor/common-assets/update", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ id: asset.id, ...changes }),
                });
                await loadLibraryAssets();
            };
            card.querySelector("input").onchange = (event) => { asset.selected = event.target.checked; card.classList.toggle("selected", asset.selected); };
            card.querySelector("select").onchange = async (event) => {
                try { await persistLibraryAsset({ category: event.target.value }); renderLibrary(); }
                catch (error) { alert(String(error?.message || error)); renderLibrary(); }
            };
            card.querySelector("[data-library-rename]").onclick = async (event) => {
                event.preventDefault(); event.stopPropagation();
                const value = await openTextDialog({ title: "修改资产名称", label: "资产名称", value: asset.name || "", maxLength: 80 });
                if (value === null || !String(value).trim()) return;
                try { await persistLibraryAsset({ name: String(value).trim().slice(0, 80) }); renderLibrary(); renderAssets(); }
                catch (error) { alert(String(error?.message || error)); }
            };
            card.querySelector("[data-library-note]").onclick = async (event) => {
                event.preventDefault(); event.stopPropagation();
                const value = await openTextDialog({ title: "编辑资产备注", label: "备注（留空即删除）", value: String(asset.note || ""), maxLength: 2000 });
                if (value === null) return;
                try { await persistLibraryAsset({ note: String(value).trim().slice(0, 2000) }); renderLibrary(); renderAssets(); }
                catch (error) { alert(String(error?.message || error)); }
            };
            grid.appendChild(card);
        });
        grid.scrollTop = previousScrollTop;
        q("[data-library-empty]").hidden = Boolean(visible.length);
        q("[data-library-count]").textContent = `共 ${libraryAssets.length} 个资产`;
        root.querySelectorAll("[data-library-category]").forEach((button) => button.classList.toggle("active", button.dataset.libraryCategory === libraryCategory));
    };
    const addLibraryFiles = async (files, categoryOverride = "") => {
        const images = [...files].filter((file) => file.type.startsWith("image/") || /\.(jpe?g|png|webp)$/i.test(file.name));
        const category = categoryOverride || (libraryCategory === "all" ? "other" : libraryCategory);
        for (const file of images) {
            const form = new FormData();
            form.append("category", category);
            form.append("library_scope", categoryOverride || libraryCategory);
            form.append("name", file.name.replace(/\.[^.]+$/, ""));
            form.append("note", "");
            form.append("media", file, file.name || "asset.png");
            await commonAssetRequest("/xiantu/video-editor/common-assets/import", { method: "POST", body: form });
        }
        await loadLibraryAssets();
        renderLibrary();
    };
    const migrateLegacyLibraryAssets = async (button) => {
        const records = await libraryStoreRequest("readonly", (store) => store.getAll());
        if (!records.length) { button.textContent = "没有旧资产"; return; }
        if (!window.confirm(`检测到 ${records.length} 个旧资产。确认复制到公共“闲兔资产库”？旧 IndexedDB 不会删除。`)) return;
        let migrated = 0;
        for (const record of records) {
            const blob = record.blob instanceof Blob ? record.blob : null;
            if (!blob) continue;
            const file = blob instanceof File ? blob : new File([blob], record.name || `旧资产-${migrated + 1}.png`, { type: blob.type || "image/png" });
            const form = new FormData();
            form.append("category", ["character", "scene", "prop", "other", "camera", "blocking"].includes(record.category) ? record.category : "other");
            form.append("name", String(record.name || file.name.replace(/\.[^.]+$/, "")));
            form.append("note", String(record.note || ""));
            form.append("media", file, file.name || "legacy-asset.png");
            await commonAssetRequest("/xiantu/video-editor/common-assets/import", { method: "POST", body: form });
            migrated += 1;
            button.textContent = `迁移中 ${migrated}/${records.length}`;
        }
        await loadLibraryAssets();
        renderLibrary();
        button.textContent = `已迁移 ${migrated} 个`;
    };
    const applyLibrarySelection = async () => {
        let chosen = libraryAssets.filter((asset) => asset.selected);
        if (!chosen.length) return;
        const mode = activeShot()?.mode || "reference";
        if (mode === "image") {
            for (let index = assetList.length - 1; index >= 0; index -= 1) {
                const asset = assetList[index];
                if (asset.shotId !== activeShotId || !asset.type.startsWith("image/")) continue;
                URL.revokeObjectURL(asset.url); selectedAssetIds.delete(asset.id); assetList.splice(index, 1);
            }
            chosen = chosen.slice(0, 1);
        } else if (mode === "frames") {
            const count = assetList.filter((asset) => asset.shotId === activeShotId && asset.type.startsWith("image/")).length;
            chosen = chosen.slice(0, Math.max(0, 2 - count));
        }
        const appliedPayload = await commonAssetRequest("/xiantu/video-editor/common-assets/apply", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids: chosen.map((asset) => asset.id) }),
        });
        for (const uploaded of appliedPayload.assets || []) {
            const asset = { id: makeId(), sourceAssetId: uploaded.id, sourceCategory: uploaded.category, sourceContentHash: uploaded.contentHash, sourceRelativePath: uploaded.sourceRelativePath, sourcePath: "", serverName: uploaded.filename, subfolder: uploaded.subfolder || "", sourceType: uploaded.type || "input", shotId: activeShotId, name: uploaded.name, alias: "", note: String(uploaded.note || ""), type: uploaded.mimeType || "image/png", url: persistedAssetUrl({ serverName: uploaded.filename, subfolder: uploaded.subfolder, sourceType: uploaded.type }), duration: 0, width: 0, height: 0 };
            assetList.push(asset);
            if (asset.type.startsWith("image/")) {
                const probe = new Image();
                probe.onload = () => { asset.width = probe.naturalWidth; asset.height = probe.naturalHeight; renderAssets(); save(); };
                probe.src = asset.url;
            }
        }
        activeAssetType = "image";
        libraryAssets.forEach((asset) => { asset.selected = false; });
        q("[data-library-dialog]").hidden = true;
        syncModeUI();
        save();
    };
    const timelineDurationForShot = (shot) => {
        const result = results.find((item) => String(item.shotId) === String(shot?.id) && resultKind(item) === "after")
            || results.find((item) => String(item.shotId) === String(shot?.id) && resultKind(item) === "before");
        const measured = Number(result?.actualDuration || 0);
        if (Number.isFinite(measured) && measured > 0) return measured;
        return Math.max(1 / resolutionState.fps, Number(shot?.seconds || 5));
    };
    const renderTimeline = () => {
        const ruler = q("[data-time-ruler]");
        const videoTrack = q("[data-video-track]");
        const playhead = q("[data-playhead]");
        const scale = timelineScale;
        const videoDurations = shots.map((shot) => Math.max(1 / resolutionState.fps, timelineDurationForShot(shot)));
        const totalDuration = Math.max(40, videoDurations.reduce((sum, value) => sum + value, 0));
        const width = Math.ceil(totalDuration * scale);
        for (const element of [ruler, videoTrack]) element.style.width = `${width}px`;
        ruler.innerHTML = Array.from({ length: Math.floor(totalDuration / 2) + 1 }, (_, index) => `<span style="left:${index * 2 * scale}px"><i></i>${index * 2}s</span>`).join("");
        let cursor = 0;
        videoTrack.innerHTML = shots.length ? shots.map((shot, index) => {
            const duration = videoDurations[index];
            const left = Math.max(0, cursor * scale - (index > 0 ? 1 : 0));
            cursor += duration;
            const generated = results.some((result) => String(result.shotId) === String(shot.id));
            return `<button type="button" class="${shot.id === activeShotId ? "active" : ""} ${generated ? "generated" : ""}" draggable="true" data-timeline-clip="${index}" style="left:${left}px;width:${Math.max(1, duration * scale + (index > 0 ? 1 : 0))}px"><b>分镜 ${String(index + 1).padStart(2, "0")}</b><small>${duration.toFixed(1)}s</small><i></i><i></i></button>`;
        }).join("") : `<em>暂无视频片段</em>`;
        root.querySelectorAll("[data-timeline-clip]").forEach((clip) => {
            clip.onclick = (event) => {
                updatePrompt();
                const shot = shots[Number(clip.dataset.timelineClip)];
                const rect = clip.getBoundingClientRect();
                const duration = timelineDurationForShot(shot);
                const localSeconds = Math.max(0, Math.min(duration, (event.clientX - rect.left) / Math.max(1, rect.width) * duration));
                activeShotId = shot.id;
                renderShots(); loadShot(); save();
                let resultIndex = results.findIndex((result) => String(result.shotId) === String(shot.id) && resultKind(result) === "after");
                if (resultIndex < 0) resultIndex = results.findIndex((result) => String(result.shotId) === String(shot.id) && resultKind(result) === "before");
                q("[data-playhead]").style.left = `${(resultStartTime({ shotId: shot.id }) + localSeconds) * timelineScale}px`;
                if (resultIndex >= 0) playResult(resultIndex, localSeconds);
            };
            clip.ondragstart = (event) => event.dataTransfer.setData("text/x-xiantu-result-index", clip.dataset.timelineClip);
            clip.ondragover = (event) => event.preventDefault();
            clip.ondrop = (event) => {
                event.preventDefault();
                const from = Number(event.dataTransfer.getData("text/x-xiantu-result-index"));
                const to = Number(clip.dataset.timelineClip);
                if (!Number.isInteger(from) || from === to || !shots[from]) return;
                const [moved] = shots.splice(from, 1); shots.splice(to, 0, moved); renderShots(); loadShot(); renderTimeline(); save();
            };
        });
        const viewport = q("[data-timeline-viewport]");
        let scrubbingTimeline = false;
        const movePlayhead = (event) => {
            const rect = viewport.getBoundingClientRect();
            const left = Math.max(0, Math.min(width, event.clientX - rect.left + viewport.scrollLeft));
            playhead.style.left = `${left}px`;
            return left;
        };
        viewport.onpointerdown = (event) => {
            if (event.button !== 0 || event.target.closest("[data-timeline-clip]")) return;
            scrubbingTimeline = true;
            viewport.setPointerCapture?.(event.pointerId);
            movePlayhead(event);
            event.preventDefault();
        };
        viewport.onpointermove = (event) => {
            if (!scrubbingTimeline) return;
            movePlayhead(event);
        };
        viewport.onpointerup = viewport.onpointercancel = (event) => {
            if (!scrubbingTimeline) return;
            const left = movePlayhead(event);
            scrubbingTimeline = false;
            if (viewport.hasPointerCapture?.(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
            playTimelineAt(left / scale);
        };
        q("[data-timeline-zoom]").value = String(timelineScale);
        q("[data-timeline-zoom-value]").textContent = `${Math.round(timelineScale / 38 * 100)}%`;
    };
    const resultStartTime = (result) => {
        let cursor = 0;
        for (const shot of shots) {
            if (String(shot.id) === String(result?.shotId)) return cursor;
            cursor += timelineDurationForShot(shot);
        }
        return 0;
    };
    const syncPlayheadToVideo = () => {
        if (!previewResult || video.hidden) return;
        const seconds = resultStartTime(previewResult) + Math.max(0, Number(video.currentTime || 0));
        q("[data-playhead]").style.left = `${seconds * timelineScale}px`;
        const viewport = q("[data-timeline-viewport]");
        const position = seconds * timelineScale;
        if (position < viewport.scrollLeft || position > viewport.scrollLeft + viewport.clientWidth - 24) viewport.scrollLeft = Math.max(0, position - viewport.clientWidth * 0.35);
    };
    let playbackQueue = [];
    let playbackQueueIndex = -1;
    const absoluteResultUrl = (result) => result?.url ? new URL(result.url, location.href).href : "";
    const preloadNextResult = () => {
        const next = playbackQueue[playbackQueueIndex + 1];
        const wanted = absoluteResultUrl(next);
        if (!wanted) {
            standbyVideo.removeAttribute("src");
            standbyVideo.dataset.resultUrl = "";
            return;
        }
        if (standbyVideo.dataset.resultUrl === wanted) return;
        standbyVideo.pause();
        standbyVideo.hidden = true;
        standbyVideo.controls = false;
        standbyVideo.src = next.url;
        standbyVideo.dataset.resultUrl = wanted;
        standbyVideo.load();
    };
    const holdCurrentVideoFrame = () => {
        if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) return false;
        try {
            const canvas = document.createElement("canvas");
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            canvas.getContext("2d", { alpha: false })?.drawImage(video, 0, 0, canvas.width, canvas.height);
            image.src = canvas.toDataURL("image/jpeg", 0.94);
            image.hidden = false;
            video.hidden = true;
            return true;
        } catch { return false; }
    };
    const loadAndPlayResult = async (result, startTime = 0) => {
        if (!result?.url) return;
        previewResult = result;
        const wanted = new URL(result.url, location.href).href;
        const changingSource = video.src !== wanted;
        const holdingFrame = changingSource && holdCurrentVideoFrame();
        empty.hidden = true;
        if (!holdingFrame) { image.hidden = true; video.hidden = false; }
        const revealVideo = () => { video.hidden = false; image.hidden = true; };
        const seekAndPlay = async () => {
            video.currentTime = Math.max(0, Math.min(Number(startTime) || 0, Math.max(0, Number(video.duration || startTime || 0) - 0.03)));
            if (Number.isFinite(video.duration) && video.duration > 0 && Math.abs(Number(result.actualDuration || 0) - video.duration) > 0.01) {
                result.actualDuration = video.duration;
                renderTimeline();
                save();
            }
            syncPlayheadToVideo();
            video.addEventListener("playing", revealVideo, { once: true });
            try {
                await video.play();
                preloadNextResult();
            } catch { revealVideo(); }
        };
        if (changingSource) {
            video.src = result.url;
            video.load();
            video.addEventListener("loadedmetadata", seekAndPlay, { once: true });
        } else await seekAndPlay();
    };
    const playResult = async (index, startTime = 0) => {
        const result = results[Number(index)];
        if (!result?.url) return;
        if (previewResult === result && !video.paused && Number(startTime) === 0) { video.pause(); return; }
        const selected = results
            .filter((item) => item.url && resultKind(item) === resultView)
            .sort((a, b) => resultStartTime(a) - resultStartTime(b));
        playbackQueue = selected.includes(result) ? selected : [result];
        playbackQueueIndex = Math.max(0, playbackQueue.indexOf(result));
        await loadAndPlayResult(result, startTime);
        void finalizeVideoNameWithRetry(result).then((finalized) => {
            if (!applyFinalizedRecord(result, finalized)) return;
            renderResults();
            save();
        }).catch((error) => {
            // Naming cleanup is best-effort. The original VHS muxed file is a
            // valid playable video and must never be hidden just because its
            // cosmetic filename could not be finalized yet.
            console.warn("最终视频文件名暂未整理，继续播放原始视频", error);
            result.finalizeWarning = String(error?.message || "最终视频文件名暂未整理");
        });
    };
    const syncPlaybackButtons = () => {
        root.querySelectorAll("[data-result-preview]").forEach((button) => {
            const active = results[Number(button.dataset.resultPreview)] === previewResult && !video.paused && !video.ended;
            if (!button.classList.contains("xve-result-name")) button.textContent = active ? "Ⅱ" : "▶";
            button.title = active ? "暂停" : "播放";
        });
    };
    const advancePlaybackQueue = async () => {
        if (playbackQueueIndex < 0 || playbackQueueIndex + 1 >= playbackQueue.length) return;
        playbackQueueIndex += 1;
        const next = playbackQueue[playbackQueueIndex];
        // Keep playback on the user-started media element. The standby element
        // only warms the browser cache; switching playback to a second element
        // can be rejected by autoplay policy and stop the sequence outright.
        await loadAndPlayResult(next, 0);
    };
    video.ontimeupdate = syncPlayheadToVideo;
    video.onseeked = syncPlayheadToVideo;
    video.onplay = syncPlaybackButtons;
    video.onpause = syncPlaybackButtons;
    video.onended = advancePlaybackQueue;
    const playTimelineAt = (timelineSeconds) => {
        let cursor = 0;
        for (const shot of shots) {
            const duration = timelineDurationForShot(shot);
            if (timelineSeconds <= cursor + duration) {
                activeShotId = shot.id;
                renderShots(); loadShot(); save();
                let resultIndex = results.findIndex((result) => String(result.shotId) === String(shot.id) && resultKind(result) === "after");
                if (resultIndex < 0) resultIndex = results.findIndex((result) => String(result.shotId) === String(shot.id) && resultKind(result) === "before");
                if (resultIndex >= 0) playResult(resultIndex, Math.max(0, timelineSeconds - cursor));
                return;
            }
            cursor += duration;
        }
    };
    const openOutputFolder = async () => {
        const response = await api.fetchApi("/xiantu/video-editor/open-output", { method: "POST" });
        if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || "打开输出目录失败");
    };
    const renderResults = () => {
        const list = q("[data-result-list]");
        list.replaceChildren();
        const visible = results.map((result, index) => ({ result, index })).filter(({ result }) => resultKind(result) === resultView);
        visible.forEach(({ result, index }) => {
            const row = document.createElement("article");
            row.className = "xve-result-row";
            const mergeButton = resultView === "after" ? `<button type="button" data-result-merge-one="${index}" title="加入合并">✣</button>` : "";
            row.innerHTML = `<input type="checkbox" data-result-check="${index}" ${result.selected ? "checked" : ""}><button type="button" class="xve-result-name" data-result-preview="${index}" title="${escapeHtml(result.filename || "播放")}">${escapeHtml(result.filename || result.name || `分镜 ${index + 1}`)}</button><div class="xve-result-actions"><button type="button" data-result-preview="${index}" title="播放">▶</button><button type="button" data-result-open="${index}" title="打开目录">▣</button><button type="button" data-result-rename="${index}" title="重命名文件">✎</button>${mergeButton}<button type="button" data-result-delete="${index}" title="从列表删除">×</button></div>`;
            list.appendChild(row);
        });
        if (!visible.length) {
            const emptyList = document.createElement("div");
            emptyList.className = "xve-result-empty";
            emptyList.textContent = resultView === "merged" ? "暂无合并成片" : `暂无${resultView === "before" ? "放大前" : "放大后"}视频`;
            list.appendChild(emptyList);
        }
        q("[data-result-count]").textContent = `（${visible.length}）`;
        q("[data-result-total]").textContent = `共 ${visible.length} 个视频`;
        root.querySelectorAll("[data-result-tab]").forEach((tab) => tab.classList.toggle("active", tab.dataset.resultTab === resultView));
        root.querySelectorAll("[data-result-preview]").forEach((button) => button.onclick = () => playResult(Number(button.dataset.resultPreview)));
        root.querySelectorAll("[data-result-open]").forEach((button) => button.onclick = () => openOutputFolder().catch((error) => { button.title = String(error.message || error); }));
        root.querySelectorAll("[data-result-rename]").forEach((button) => button.onclick = async () => {
            const index = Number(button.dataset.resultRename);
            const current = results[index];
            const currentFilename = String(current?.filename || "");
            const currentBase = currentFilename.replace(/\.(?:mp4|webm|mov|mkv|avi|m4v)$/i, "");
            const value = await openTextDialog({ title: "重命名视频文件", label: "新文件名（无需扩展名）", value: currentBase, maxLength: 80 });
            if (value === null || !results[index]) return;
            const response = await api.fetchApi("/xiantu/video-editor/rename-video", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ filename: current.filename, subfolder: current.subfolder || "", type: current.type || "output", new_name: String(value).trim() }),
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) { button.title = payload.error || "重命名失败"; return; }
            const oldFilename = current.filename;
            current.filename = payload.filename;
            current.subfolder = payload.subfolder || current.subfolder;
            current.type = payload.type || current.type;
            current.name = payload.filename;
            current.url = api.apiURL(`/view?${new URLSearchParams({ filename: current.filename, subfolder: current.subfolder || "", type: current.type || "output" }).toString()}`);
            const shot = shots.find((item) => String(item.id) === String(current.shotId));
            if (shot?.lastOutput?.filename === oldFilename) shot.lastOutput = { ...shot.lastOutput, filename: current.filename, subfolder: current.subfolder, type: current.type };
            renderResults(); save();
        });
        root.querySelectorAll("[data-result-merge-one]").forEach((button) => button.onclick = () => {
            const index = Number(button.dataset.resultMergeOne);
            if (!results[index]) return;
            results[index].selected = true; renderResults(); save();
        });
        root.querySelectorAll("[data-result-delete]").forEach((button) => button.onclick = () => {
            results.splice(Number(button.dataset.resultDelete), 1); renderResults(); save();
        });
        root.querySelectorAll("[data-result-check]").forEach((checkbox) => checkbox.onchange = () => { results[Number(checkbox.dataset.resultCheck)].selected = checkbox.checked; renderResults(); save(); });
        q("[data-result-all]").checked = Boolean(visible.length) && visible.every(({ result }) => result.selected);
        syncPlaybackButtons();
        renderTimeline();
    };
    q("[data-filename-prefix]").value = filenamePrefix;
    q("[data-filename-prefix]").oninput = (event) => { filenamePrefix = event.target.value.slice(0, 80); save(); };
    const reportAssetImportError = (error) => {
        console.error("视频导演台素材导入失败", error);
        const meta = q(".xve-reference-meta");
        if (meta) { meta.textContent = `导入失败：${String(error?.message || error)}`; meta.title = String(error?.message || error); }
    };
    input.onchange = async () => { try { await importFiles(input.files || []); } catch (error) { reportAssetImportError(error); } finally { input.value = ""; } };
    const draggingFiles = (event) => [...(event.dataTransfer?.types || [])].includes("Files");
    assetsElement.ondragover = (event) => { if (!draggingFiles(event)) return; event.preventDefault(); assetsElement.classList.add("dragover"); };
    assetsElement.ondragleave = (event) => { if (!assetsElement.contains(event.relatedTarget)) assetsElement.classList.remove("dragover"); };
    assetsElement.ondrop = async (event) => { if (!draggingFiles(event)) return; event.preventDefault(); assetsElement.classList.remove("dragover"); try { await importFiles(event.dataTransfer.files || []); } catch (error) { reportAssetImportError(error); } };
    root.querySelectorAll("[data-asset-type]").forEach((button) => button.onclick = () => {
        activeAssetType = button.dataset.assetType;
        root.querySelectorAll("[data-asset-type]").forEach((item) => item.classList.toggle("active", item === button));
        renderAssets();
    });
    const libraryDialog = q("[data-library-dialog]");
    const libraryFileInput = q("[data-library-files]");
    q("[data-library-open]").onclick = async () => {
        libraryDialog.hidden = false;
        try {
            await loadLibraryAssets();
            q("[data-library-empty]").textContent = "点击“导入公共资产”或直接拖入图片添加资产";
        } catch (error) {
            console.warn("视频编辑工作台公共资产库读取失败", error);
            libraryAssets = [];
            q("[data-library-empty]").textContent = String(error?.message || error);
        }
        renderLibrary();
    };
    root.querySelectorAll("[data-library-close]").forEach((button) => button.onclick = () => { libraryDialog.hidden = true; });
    q("[data-library-upload]").onclick = () => libraryFileInput.click();
    libraryFileInput.onchange = async () => {
        await addLibraryFiles(libraryFileInput.files || []);
        libraryFileInput.value = "";
    };
    root.querySelectorAll("[data-library-category]").forEach((button) => button.onclick = () => { libraryCategory = button.dataset.libraryCategory; q("[data-library-grid]").scrollTop = 0; renderLibrary(); });
    q("[data-library-select-all]").onclick = () => { libraryAssets.filter((asset) => libraryCategory === "all" || asset.category === libraryCategory).forEach((asset) => { asset.selected = true; }); renderLibrary(); };
    q("[data-library-select-none]").onclick = () => { libraryAssets.forEach((asset) => { asset.selected = false; }); renderLibrary(); };
    q("[data-library-delete]").onclick = async () => {
        const selected = libraryAssets.filter((asset) => asset.selected);
        if (!selected.length || !window.confirm(`确认从公共资产库删除 ${selected.length} 个资产？已经应用到分镜的 input 副本不会删除。`)) return;
        try {
            await commonAssetRequest("/xiantu/video-editor/common-assets/delete", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ids: selected.map((asset) => asset.id) }),
            });
            await loadLibraryAssets(); renderLibrary();
        } catch (error) { alert(String(error?.message || error)); }
    };
    q("[data-library-apply]").onclick = applyLibrarySelection;
    const libraryGrid = q("[data-library-grid]");
    libraryGrid.ondragover = (event) => { if (draggingFiles(event)) event.preventDefault(); };
    libraryGrid.ondrop = async (event) => { if (!draggingFiles(event)) return; event.preventDefault(); await addLibraryFiles(event.dataTransfer.files || []); };

    q("[data-add-shot]").onclick = () => {
        updatePrompt();
        const shot = { id: makeId(), title: `分镜 ${shots.length + 1}`, selected: true, prompt: "", mode: activeShot()?.mode || "reference", seconds: activeShot()?.seconds || 5, inheritPrevious: true, referenceSize: activeShot()?.referenceSize || referenceSize };
        shots.push(shot); activeShotId = shot.id; renderShots(); loadShot(); save();
    };
    q("[data-delete-shot]").onclick = () => {
        if (shots.length === 1) return;
        const index = shots.findIndex((shot) => shot.id === activeShotId);
        for (let assetIndex = assetList.length - 1; assetIndex >= 0; assetIndex -= 1) {
            if (assetList[assetIndex].shotId !== activeShotId) continue;
            URL.revokeObjectURL(assetList[assetIndex].url); selectedAssetIds.delete(assetList[assetIndex].id); assetList.splice(assetIndex, 1);
        }
        shots.splice(index, 1); activeShotId = shots[Math.min(index, shots.length - 1)].id; renderShots(); loadShot(); save();
    };
    q("[data-clear-shots]").onclick = () => {
        assetList.forEach((asset) => URL.revokeObjectURL(asset.url)); assetList.splice(0); selectedAssetIds.clear();
        referenceSize = "match";
        referenceSizeExplicit = false;
        shots = [{ id: makeId(), title: "分镜 1", selected: true, prompt: "", mode: "reference", seconds: 5, inheritPrevious: false, referenceSize: "match" }];
        activeShotId = shots[0].id; renderShots(); loadShot(); save();
    };
    q("[data-prev-shot]").onclick = () => moveShot(-1);
    q("[data-next-shot]").onclick = () => moveShot(1);
    q("[data-expand-shots]").onclick = () => {
        shotsExpanded = !shotsExpanded;
        q(".xve-director").classList.toggle("shots-expanded", shotsExpanded);
        q("[data-expand-shots]").innerHTML = `${shotsExpanded ? "收起分镜" : "展开分镜"} (<b data-shot-total>${shots.length}</b>) <span>${shotsExpanded ? "⌃" : "⌄"}</span>`;
    };
    q("[data-select-all]").onclick = () => { const allSelected = shots.every((shot) => shot.selected); shots.forEach((shot) => { shot.selected = !allSelected; }); renderShots(); save(); };
    const sheetFileInput = q("[data-sheet-file]");
    q("[data-download-sheet]").onclick = downloadSheet;
    q("[data-upload-sheet]").onclick = () => sheetFileInput.click();
    const repairDialog = q("[data-repair-dialog]");
    const numberInRange = (value, minimum, maximum, fallback) => {
        const number = Number(value);
        return Math.max(minimum, Math.min(maximum, Number.isFinite(number) ? number : fallback));
    };
    const syncRepairButtons = () => {
        q("[data-face-repair]").classList.toggle("enabled", faceRepairSettings.enabled);
        q("[data-face-repair]").title = faceRepairSettings.enabled ? "已启用：点击修改设置" : "点击设置远景人脸修复";
    };
    const refreshFaceRepairModelStatus = async () => {
        const indicators = [...root.querySelectorAll("[data-face-model-status]")];
        indicators.forEach((indicator) => { indicator.className = "checking"; indicator.textContent = "检测中"; });
        try {
            const response = await api.fetchApi("/xiantu/video-editor/face-repair-models");
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(payload.error || "模型状态读取失败");
            indicators.forEach((indicator) => {
                const installed = Boolean(payload[indicator.dataset.faceModelStatus]?.installed);
                indicator.className = installed ? "installed" : "missing";
                indicator.textContent = installed ? "✓ 已安装" : "✕ 缺失";
            });
        } catch (error) {
            indicators.forEach((indicator) => { indicator.className = "missing"; indicator.textContent = "检测失败"; indicator.title = String(error?.message || error); });
        }
    };
    const openRepairDialog = () => {
        q("[data-repair-title]").textContent = "人脸修复";
        q("[data-repair-subtitle]").textContent = "主采样解码后修复远景人脸，保存前执行";
        q("[data-face-enabled]").checked = faceRepairSettings.enabled;
        q("[data-face-target]").value = faceRepairSettings.target;
        q("[data-face-strength]").value = String(faceRepairSettings.strength);
        q("[data-face-confidence]").value = String(faceRepairSettings.confidence);
        q("[data-face-person-fallback]").checked = faceRepairSettings.personFallback;
        repairDialog.hidden = false;
        refreshFaceRepairModelStatus();
    };
    const closeRepairDialog = () => { repairDialog.hidden = true; };
    q("[data-face-repair]").onclick = openRepairDialog;
    repairDialog.querySelectorAll("[data-repair-close]").forEach((button) => { button.onclick = closeRepairDialog; });
    repairDialog.onclick = (event) => { if (event.target === repairDialog) closeRepairDialog(); };
    q("[data-repair-save]").onclick = () => {
        faceRepairSettings.enabled = q("[data-face-enabled]").checked;
        faceRepairSettings.target = q("[data-face-target]").value === "主要人物" ? "主要人物" : "全部人脸";
        faceRepairSettings.strength = numberInRange(q("[data-face-strength]").value, 0, 1, 0.65);
        faceRepairSettings.confidence = numberInRange(q("[data-face-confidence]").value, 0.05, 0.95, 0.25);
        faceRepairSettings.personFallback = q("[data-face-person-fallback]").checked;
        syncRepairButtons(); save(); closeRepairDialog();
    };
    syncRepairButtons();
    sheetFileInput.onchange = async () => {
        const file = sheetFileInput.files?.[0];
        sheetFileInput.value = "";
        await importSheet(file);
    };
    const promptEditor = q("[data-prompt]");
    promptEditor.onpaste = (event) => {
        event.preventDefault();
        const pastedText = event.clipboardData?.getData("text/plain") || "";
        const selection = window.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        if (range && promptEditor.contains(range.startContainer)) {
            range.deleteContents();
            const textNode = document.createTextNode(pastedText);
            range.insertNode(textNode);
            range.setStartAfter(textNode);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
        } else {
            promptEditor.append(document.createTextNode(pastedText));
        }
        const raw = promptText(promptEditor);
        renderPromptContent(raw);
        updatePrompt();
        const endRange = document.createRange();
        endRange.selectNodeContents(promptEditor);
        endRange.collapse(false);
        selection?.removeAllRanges();
        selection?.addRange(endRange);
    };
    promptEditor.oninput = (event) => {
        updatePrompt();
        const editor = event.currentTarget;
        const selection = window.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        const insideEditor = range && editor.contains(range.startContainer);
        if (insideEditor && event.data === "@") {
            promptMentionRange = range.cloneRange();
            showMentionMenu();
        } else {
            promptMentionRange = null;
            hideMentionMenu();
        }
    };
    q("[data-cascade]").onchange = (event) => {
        continuityEnabled = event.target.checked;
        const shot = activeShot();
        if (shot) shot.inheritPrevious = continuityEnabled;
        if (continuityEnabled && shot?.mode === "frames") {
            const frameAssets = assetList.filter((asset) => asset.shotId === shot.id && asset.type.startsWith("image/"));
            for (const asset of frameAssets.slice(0, -1)) {
                const index = assetList.indexOf(asset);
                if (index >= 0) assetList.splice(index, 1);
                selectedAssetIds.delete(asset.id);
            }
        }
        syncContinuityUI(); syncModeUI(); save();
    };
    q("[data-continuity-frames]").onchange = (event) => { continuityOverlapFrames = snapContinuityFrames(event.target.value); syncContinuityUI(); save(); };
    q("[data-continuity-redraw]").onchange = (event) => { continuityRedraw = Math.max(0, Math.min(0.95, Number(event.target.value) || 0)); syncContinuityUI(); save(); };
    q("[data-seconds]").onchange = updatePrompt;
    q("[data-video-aspect]").onchange = (event) => {
        resolutionState.aspect = resolutionRatios[event.target.value] ? event.target.value : "16:9";
        renderResolutionSettings();
        save();
    };
    q("[data-video-megapixels]").onchange = (event) => {
        resolutionState.megapixels = Math.max(0.1, Math.min(3, Number(event.target.value) || 1));
        renderResolutionSettings();
        save();
    };
    q("[data-reference-size]").onchange = (event) => { referenceSize = event.target.value === "max" ? "max" : "match"; referenceSizeExplicit = true; if (activeShot()) activeShot().referenceSize = referenceSize; save(); };
    root.querySelectorAll("[data-model-profile]").forEach((button) => {
        button.classList.toggle("active", button.dataset.modelProfile === modelProfile);
        button.onclick = () => {
            modelProfile = button.dataset.modelProfile;
            root.querySelectorAll("[data-model-profile]").forEach((item) => item.classList.toggle("active", item === button));
            save();
        };
    });
    root.querySelectorAll("[data-mode]").forEach((button) => button.onclick = () => {
        activeShot().mode = button.dataset.mode;
        root.querySelectorAll("[data-mode]").forEach((item) => item.classList.toggle("active", item === button));
        syncModeUI();
        save();
    });
    const inferProgressPhase = (title, explicit) => {
        if (explicit) return explicit;
        const value = String(title || "");
        if (/完成/.test(value)) return "done";
        if (/保存|合并/.test(value)) return "save";
        if (/解码/.test(value)) return "decode";
        if (/采样/.test(value)) return "sample";
        if (/编码|条件|参考素材/.test(value)) return "encode";
        if (/加载|卸载/.test(value)) return "load";
        return "prepare";
    };
    const renderGenerationProgress = (progress) => {
        const { title, actionDetail, batchDetail, percent, phase, phasePercent } = progress;
        q("[data-progress-title]").textContent = title;
        q("[data-progress-action]").textContent = actionDetail ? ` ${actionDetail}` : "";
        q("[data-progress-batch]").textContent = batchDetail;
        const bar = q("[data-progress-bar]");
        q("[data-top-progress]").hidden = !(runtime.busy || runtime.externalBusy);
        const overallPercent = Math.max(0, Math.min(100, Number(percent) || 0));
        bar.value = overallPercent;
        bar.setAttribute("aria-valuenow", String(Math.round(overallPercent)));
        bar.setAttribute("aria-valuetext", `${title}${actionDetail ? ` ${actionDetail}` : ""}，总进度 ${Math.round(overallPercent)}%`);
        const generateButton = q("[data-generate]");
        if (generateButton) {
            generateButton.disabled = Boolean(runtime.cancelRequested);
            generateButton.textContent = runtime.busy ? (runtime.cancelRequested ? "正在停止…" : "■ 停止生成") : (runtime.buttonText || "▶ 开始生成");
        }
    };
    runtime.listeners.add(renderGenerationProgress);
    const setGenerationProgress = ({ title = "等待生成", actionDetail = "", batchDetail = "分镜 0/0", percent = 0, phase = "", phasePercent = null, traceKey = "", traceLabel = "" } = {}) => {
        generationProgress = { title: String(title), actionDetail: String(actionDetail), batchDetail: String(batchDetail), percent: percent === null ? null : Math.max(0, Math.min(100, Number(percent) || 0)), phase: inferProgressPhase(title, phase), phasePercent: phasePercent === null ? null : Math.max(0, Math.min(100, Number(phasePercent) || 0)) };
        const key = String(traceKey || `${generationProgress.phase}:${generationProgress.title}`);
        const label = String(traceLabel || generationProgress.title);
        const last = runtime.progressTrace.at(-1);
        if (!last || last.key !== key) {
            runtime.progressTrace.push({ key, label });
            if (runtime.progressTrace.length > 30) runtime.progressTrace.splice(0, runtime.progressTrace.length - 30);
        } else if (label) last.label = label;
        runtime.progress = { ...generationProgress };
        node.properties ??= {};
        node.properties.xiantuVideoProgress = { ...generationProgress };
        runtime.listeners.forEach((listener) => listener(generationProgress));
    };
    setGenerationProgress(generationProgress);
    const executionNodeInfo = (nodeId) => {
        const graphNode = app.graph?.getNodeById?.(Number(nodeId));
        const injectedType = runtime.injectedNodeTypes?.get?.(String(nodeId));
        const type = String(injectedType || graphNode?.comfyClass || graphNode?.type || "");
        const label = String(graphNode?.title || type || (nodeId ? `节点 ${nodeId}` : "工作流"));
        const key = `${type} ${label}`.toLowerCase();
        let action = "执行节点";
        if (/xiantuvideofacerepair/.test(key)) action = "人脸修复";
        else if (/ksampler|sampler|采样/.test(key)) action = "采样";
        else if (/vaedecode|vae decode|解码/.test(key)) action = "VAE 解码";
        else if (/vaeencode|vae encode/.test(key)) action = "VAE 编码";
        else if (/upscale|放大|超分/.test(key)) action = "视频放大";
        else if (/save|combine|合并为视频|保存/.test(key)) action = "保存视频";
        else if (/cliptextencode|text encode|提示词编码/.test(key)) action = "编码提示词";
        else if (/dualcliploader|clip loader|文本编码器/.test(key)) action = "加载文本编码器";
        else if (/vaeloader|vae loader/.test(key)) action = "加载VAE";
        else if (/unetloader|diffusionmodel|checkpointloader|model loader|模型加载/.test(key)) action = "加载视频模型";
        else if (/lora/.test(key)) action = "应用LoRA";
        else if (/randomnoise|noise|噪声/.test(key)) action = "生成初始噪声";
        else if (/scheduler|sigmas|调度/.test(key)) action = "计算采样步";
        else if (/guider|guidance|引导/.test(key)) action = "建立采样引导";
        else if (/latent|潜空间/.test(key)) action = "创建视频潜空间";
        else if (/load|loader|加载/.test(key)) action = "加载模型";
        else if (/xiantuvideoeditorworkbench/.test(key)) action = "读取分镜并编码参考素材";
        else if (/minimax|h3/.test(key)) action = "建立 MiniMax H3 条件";
        return { action, label };
    };
    const progressStepDetail = (action, value, max) => {
        const ratio = Math.max(0, Math.min(1, Number(value || 0) / Math.max(1, Number(max || 1))));
        const percent = `${Math.round(ratio * 100)}%`;
        if (action === "人脸修复") {
            const step = ratio < .05 ? "加载检测模型"
                : ratio < .32 ? "检测远景人脸"
                : ratio < .45 ? "人物框兜底定位"
                : ratio < .48 ? "关联人物轨迹"
                : ratio < .55 ? "插值并平滑轨迹"
                : ratio < .98 ? "局部修复与羽化融合"
                : "输出修复画面";
            return `${step} · ${percent}`;
        }
        return `${value}/${max}`;
    };
    const runtimeBatchDetail = () => {
        const batch = runtime.currentBatch;
        return batch ? `分镜 ${batch.index + 1}/${batch.total}` : "分镜 1/1";
    };
    const runtimeOverallPercent = (stagePercent) => {
        const batch = runtime.currentBatch;
        if (!batch) return stagePercent;
        return (batch.index + Math.max(0, Math.min(100, stagePercent)) / 100) / Math.max(1, batch.total) * 100;
    };
    const reportPreparationStep = async (step, total, title, actionDetail = "") => {
        const localPercent = Math.max(0, Math.min(8, Number(step || 0) / Math.max(1, Number(total || 1)) * 8));
        setGenerationProgress({
            title,
            actionDetail,
            batchDetail: runtimeBatchDetail(),
            percent: runtimeOverallPercent(localPercent),
            phase: "prepare",
            phasePercent: Number(step || 0) / Math.max(1, Number(total || 1)) * 100,
            traceKey: `prepare:${runtime.currentBatch?.index || 0}:${step}:${title}`,
        });
        await new Promise((resolve) => requestAnimationFrame(resolve));
    };
    const actionStageRange = (action) => {
        if (action === "采样") return [18, 64];
        if (action === "VAE 解码") return [82, 8];
        if (action === "人脸修复") return [90, 7];
        if (action === "保存视频") return [97, 2];
        if (/加载/.test(action)) return [8, 5];
        if (/编码|条件|参考素材/.test(action)) return [13, 5];
        return [8, 10];
    };
    const reportExecutionNode = (nodeId, value = null, max = null) => {
        const info = executionNodeInfo(nodeId);
        const action = nodeId === "" || nodeId == null ? "采样" : (info.action === "执行节点" ? info.label : info.action);
        const [start, span] = actionStageRange(action);
        const hasProgress = value !== null && max !== null && Number(max) > 0;
        const inner = hasProgress ? Math.max(0, Math.min(1, Number(value) / Number(max))) : 0;
        setGenerationProgress({
            title: action,
            actionDetail: hasProgress ? progressStepDetail(action, value, max) : "",
            batchDetail: runtimeBatchDetail(),
            percent: runtimeOverallPercent(start + inner * span),
            phase: inferProgressPhase(action),
            phasePercent: hasProgress ? inner * 100 : null,
            traceKey: `node:${nodeId}:${action}`,
            traceLabel: action,
        });
    };
    const globalExecutionHandlers = {
        execution_start: () => { if (!runtime.busy) { runtime.externalBusy = true; startGenerationClock(); setGenerationProgress({ title: "准备执行工作流", actionDetail: "", batchDetail: "分镜 1/1", percent: 0, phase: "prepare", phasePercent: 0 }); } },
        executing: (event) => {
            const detail = event?.detail || {};
            const nodeId = detail.node ?? detail.node_id;
            if (nodeId == null) return;
            const eventPrompt = detail.prompt_id ?? detail.promptId;
            if (runtime.busy && eventPrompt != null && runtime.currentBatch?.promptId && String(eventPrompt) !== String(runtime.currentBatch.promptId)) return;
            runtime.externalBusy = true;
            reportExecutionNode(nodeId);
        },
        progress: (event) => {
            runtime.externalBusy = true;
            const raw = event?.detail || {};
            const detail = raw.progress || raw;
            const eventPrompt = detail.prompt_id ?? detail.promptId ?? raw.prompt_id ?? raw.promptId;
            if (runtime.busy && eventPrompt != null && runtime.currentBatch?.promptId && String(eventPrompt) !== String(runtime.currentBatch.promptId)) return;
            const value = Number(detail.value || 0), max = Math.max(1, Number(detail.max || 1));
            reportExecutionNode(detail.node ?? detail.node_id ?? raw.node ?? raw.node_id ?? "", value, max);
        },
        execution_cached: (event) => {
            const detail = event?.detail || {};
            for (const nodeId of Array.isArray(detail.nodes) ? detail.nodes : []) {
                const info = executionNodeInfo(nodeId);
                setGenerationProgress({ title: `读取${info.action}缓存`, actionDetail: "", batchDetail: runtimeBatchDetail(), percent: runtimeOverallPercent(12), phase: "load", phasePercent: null, traceKey: `cached:${nodeId}`, traceLabel: `缓存 ${info.action}` });
            }
        },
        execution_success: async (event) => {
            const detail = event?.detail || {};
            const promptId = String(detail.prompt_id ?? detail.promptId ?? "");
            if (promptId) {
                try {
                    const history = await fetchSettledPromptHistory(promptId, detail, 60);
                    const shot = shots.find((item) => String(item.lastPromptId || "") === promptId) || activeShot();
                    if (shot) await ingestHistoryVideos(history, shot, { showPreview: true });
                } catch (error) {
                    console.warn("生成完成后同步视频列表失败", error);
                }
            }
            if (!runtime.busy) { runtime.externalBusy = false; stopGenerationClock(); setGenerationProgress(); }
        },
        execution_error: (event) => {
            const detail = event?.detail || {};
            const nodeId = detail.node_id ?? detail.node ?? detail.last_node_id ?? "";
            const message = detail.exception_message || detail.error || detail.exception_type || "ComfyUI 节点执行失败";
            showDirectorError(message, nodeId);
            if (!runtime.busy) {
                runtime.externalBusy = false;
                stopGenerationClock();
                setGenerationProgress({ title: `生成失败：${String(message)}`, actionDetail: "", batchDetail: runtimeBatchDetail(), percent: 0, phase: "prepare", phasePercent: 0 });
            }
        },
        execution_interrupted: () => { if (!runtime.busy) { runtime.externalBusy = false; stopGenerationClock(); setGenerationProgress(); } },
    };
    Object.entries(globalExecutionHandlers).forEach(([name, handler]) => api.addEventListener?.(name, handler));
    const refreshHardware = async () => {
        if (!cleanupSettings.monitorHardware) return;
        try {
            const response = await api.fetchApi("/xiantu/video-editor/hardware");
            if (!response.ok) return;
            const value = await response.json();
            runtime.hardware = value;
            node.properties ??= {};
            node.properties.xiantuHardwareSnapshot = value;
            renderHardwareSnapshot(value);
        } catch {}
    };
    const renderHardwareSnapshot = (value = runtime.hardware || node.properties?.xiantuHardwareSnapshot || {}) => {
        q("[data-hw-cpu]").textContent = `CPU ${value.cpu ?? "--"}%`;
        q("[data-hw-memory]").textContent = `内存 ${value.memory ?? "--"}%`;
        q("[data-hw-vram]").textContent = `显存 ${value.vram ?? "--"}%`;
        q("[data-hw-temp]").textContent = `温度 ${value.temperature ?? "--"}℃`;
    };
    const formatGenerationElapsed = (milliseconds) => {
        const seconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const remainder = seconds % 60;
        return hours > 0
            ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
            : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
    };
    const renderGenerationElapsed = () => {
        const elapsed = runtime.startedAt ? Date.now() - runtime.startedAt : runtime.elapsedMs;
        q("[data-generation-elapsed]").textContent = `生成耗时 ${formatGenerationElapsed(elapsed)}`;
    };
    function startGenerationClock() {
        clearInterval(generationElapsedTimer);
        runtime.startedAt = Date.now();
        runtime.elapsedMs = 0;
        renderGenerationElapsed();
        generationElapsedTimer = setInterval(renderGenerationElapsed, 1000);
    }
    function stopGenerationClock() {
        if (runtime.startedAt) runtime.elapsedMs = Math.max(0, Date.now() - runtime.startedAt);
        runtime.startedAt = null;
        clearInterval(generationElapsedTimer);
        generationElapsedTimer = null;
        node.properties ??= {};
        node.properties.xiantuLastGenerationElapsedMs = runtime.elapsedMs;
        renderGenerationElapsed();
    }
    const syncGenerationClock = () => {
        clearInterval(generationElapsedTimer);
        generationElapsedTimer = null;
        renderGenerationElapsed();
        if (runtime.startedAt) generationElapsedTimer = setInterval(renderGenerationElapsed, 1000);
    };
    const syncHardwareMonitor = () => {
        q("[data-hardware]").hidden = !cleanupSettings.monitorHardware;
        clearInterval(hardwareTimer); hardwareTimer = null;
        if (cleanupSettings.monitorHardware) { renderHardwareSnapshot(); refreshHardware(); hardwareTimer = setInterval(refreshHardware, 2000); }
    };
    const settingsPanel = q("[data-generation-settings]");
    q("[data-cleanup-cache]").checked = cleanupSettings.cache;
    q("[data-cleanup-vram]").checked = cleanupSettings.vram;
    q("[data-cleanup-models]").checked = cleanupSettings.models;
    q("[data-cleanup-every]").value = String(cleanupSettings.every);
    q("[data-monitor-hardware]").checked = cleanupSettings.monitorHardware;
    q("[data-settings-toggle]").onclick = (event) => { event.stopPropagation(); settingsPanel.hidden = !settingsPanel.hidden; };
    q("[data-cleanup-cache]").onchange = (event) => { cleanupSettings.cache = event.target.checked; save(); };
    q("[data-cleanup-vram]").onchange = (event) => { cleanupSettings.vram = event.target.checked; save(); };
    q("[data-cleanup-models]").onchange = (event) => { cleanupSettings.models = event.target.checked; save(); };
    q("[data-cleanup-every]").onchange = (event) => { cleanupSettings.every = Math.max(1, Math.min(99, Number(event.target.value) || 1)); event.target.value = String(cleanupSettings.every); save(); };
    q("[data-monitor-hardware]").onchange = (event) => { cleanupSettings.monitorHardware = event.target.checked; syncHardwareMonitor(); save(); };
    syncHardwareMonitor();
    syncGenerationClock();
    const cleanupResources = async (settings = cleanupSettings) => {
        if (!settings.cache && !settings.vram && !settings.models) return;
        try {
            const response = await api.fetchApi("/xiantu/video-editor/cleanup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || payload.warnings?.length) console.warn("视频导演台分镜间资源卸载警告（继续后续分镜）", payload.error || payload.warnings || response.status);
        } catch (error) {
            console.warn("视频导演台分镜间资源卸载请求失败（继续后续分镜）", error);
        }
    };
    const outputVideosFromHistory = (history) => {
        const candidates = [];
        const visit = (value) => {
            if (!value) return;
            if (Array.isArray(value)) { value.forEach(visit); return; }
            if (typeof value !== "object") return;
            const filename = String(value.filename || value.name || "");
            if (/\.(?:mp4|webm|mov|mkv|avi|m4v)$/i.test(filename)) {
                const metadata = value.metadata && typeof value.metadata === "object" ? value.metadata : {};
                candidates.push({
                    filename,
                    subfolder: String(value.subfolder || ""),
                    type: String(value.type || "output"),
                    format: String(value.format || ""),
                    frameRate: Number(metadata.fps ?? value.frame_rate ?? 0),
                    frameCount: Number(metadata.frame_count ?? 0),
                    duration: Number(metadata.duration ?? 0),
                    width: Number(metadata.width ?? 0),
                    height: Number(metadata.height ?? 0),
                });
            }
            Object.values(value).forEach(visit);
        };
        visit(history?.outputs || history);
        const unique = new Map();
        candidates.forEach((item) => unique.set(`${item.type}/${item.subfolder}/${item.filename}`, item));
        return [...unique.values()];
    };
    const expectedVideoOutputCount = (history) => {
        const promptNodes = history?.prompt?.[2];
        if (!promptNodes || typeof promptNodes !== "object") return 0;
        return Object.values(promptNodes).filter((node) => (
            /(?:CreateVideo|VHS_VideoCombine|SaveVideo|VideoCombine)/i.test(String(node?.class_type || ""))
            && node?.inputs?.save_output !== false
        )).length;
    };
    const fetchSettledPromptHistory = async (promptId, fallback = null, attempts = 16) => {
        let best = fallback;
        let bestCount = outputVideosFromHistory(fallback).length;
        let stableCount = 0;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            try {
                const response = await api.fetchApi(`/history/${encodeURIComponent(promptId)}?t=${Date.now()}`);
                if (response.ok) {
                    const payload = await response.json();
                    const record = payload?.[promptId];
                    if (record) best = record;
                    const count = outputVideosFromHistory(record).length;
                    const expected = expectedVideoOutputCount(record);
                    if (count > 0 && count === bestCount) stableCount += 1;
                    else stableCount = 0;
                    bestCount = Math.max(bestCount, count);
                    if (count > 0 && ((expected > 0 && count >= expected) || stableCount >= 4)) return record;
                }
            } catch {}
            if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 180));
        }
        return best;
    };
    const finalizeVideoName = async (record, verify = false) => {
        if (!verify && !/-audio\.(?:mp4|webm|mov|mkv|avi|m4v)$/i.test(String(record?.filename || ""))) return record;
        const response = await api.fetchApi("/xiantu/video-editor/finalize-video-name", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(record),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(payload.error || "最终视频文件名整理失败");
            error.status = response.status;
            throw error;
        }
        return { ...record, filename: payload.filename, subfolder: payload.subfolder || record.subfolder, type: payload.type || record.type };
    };
    const finalizedRecordUrl = (record) => api.apiURL(`/view?${new URLSearchParams({
        filename: record.filename,
        subfolder: record.subfolder || "",
        type: record.type || "output",
        t: String(Date.now()),
    }).toString()}`);
    const outputRecordExists = async (record) => {
        if (!record?.filename) return false;
        try {
            const response = await api.fetchApi(`/view?${new URLSearchParams({
                filename: record.filename,
                subfolder: record.subfolder || "",
                type: record.type || "output",
            }).toString()}`, { headers: { Range: "bytes=0-0" } });
            try { await response.body?.cancel?.(); } catch {}
            return response.ok;
        } catch { return false; }
    };
    const sameOutputLocation = (left, right) => String(left?.filename || "") === String(right?.filename || "")
        && String(left?.subfolder || "").replace(/\\/g, "/") === String(right?.subfolder || "").replace(/\\/g, "/");
    const applyFinalizedRecord = (result, finalized) => {
        if (!result || !finalized?.filename) return false;
        const previous = { filename: result.filename, subfolder: result.subfolder || "", type: result.type || "output" };
        const changed = finalized.filename !== previous.filename
            || String(finalized.subfolder || "") !== previous.subfolder
            || String(finalized.type || "output") !== previous.type;
        if (!changed) return false;
        Object.assign(result, finalized, {
            name: finalized.filename,
            url: finalizedRecordUrl(finalized),
            finalizeWarning: "",
        });
        const shot = shots.find((item) => String(item.id) === String(result.shotId));
        if (sameOutputLocation(shot?.lastOutput, previous)) {
            shot.lastOutput = { ...shot.lastOutput, filename: result.filename, subfolder: result.subfolder, type: result.type };
        }
        repairFinalizedVideoElements(previous.filename, result.filename);
        return true;
    };
    const finalizeVideoNameWithRetry = async (record, attempts = 4) => {
        let lastError = null;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            try { return await finalizeVideoName(record); }
            catch (error) {
                lastError = error;
                if (attempt + 1 >= attempts) break;
                await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
            }
        }
        throw lastError || new Error("最终视频文件名整理失败");
    };
    const finalizeGeneratedVideoName = async (record) => {
        try {
            const finalized = await finalizeVideoNameWithRetry(record);
            if (finalized?.filename && finalized.filename !== record?.filename) {
                repairFinalizedVideoElements(record.filename, finalized.filename);
            }
            return finalized;
        } catch (error) {
            // A Windows encoder may briefly retain the muxed file after the
            // prompt has completed. Naming cleanup must never turn a valid
            // generation into a failed generation.
            console.warn("最终视频暂未完成文件名整理，将在刷新或播放时重试", error);
            return record;
        }
    };
    const ingestHistoryVideos = async (history, shot, { showPreview = false } = {}) => {
        const rawVideos = outputVideosFromHistory(history);
        // Publish valid VHS outputs immediately. Filename cleanup runs in the
        // background and atomically updates the corresponding result later.
        const historyVideos = rawVideos.map((record) => ({ ...record }));
        const rankedOutputs = new Map();
        historyVideos.forEach((output, index) => {
            const kind = resultKind(output);
            if (kind === "merged") return;
            const rawName = String(rawVideos[index]?.filename || "");
            const score = /-audio\.(?:mp4|webm|mov|mkv|avi|m4v)$/i.test(rawName) ? 2 : /_\d{5}\.(?:mp4|webm|mov|mkv|avi|m4v)$/i.test(rawName) ? 0 : 1;
            const current = rankedOutputs.get(kind);
            if (!current || score >= current.score) rankedOutputs.set(kind, { output, score });
        });
        const stageOutputs = new Map([...rankedOutputs].map(([kind, value]) => [kind, value.output]));
        if (!stageOutputs.size) return { historyVideos, stageOutputs };
        const { width, height } = resolutionFor();
        let preferred = null;
        for (const [kind, output] of stageOutputs) {
            const outputUrl = api.apiURL(`/view?${new URLSearchParams({ filename: output.filename, subfolder: output.subfolder || "", type: output.type || "output", t: String(Date.now()) }).toString()}`);
            const metadataDuration = Number(output.duration || 0);
            const metadataWidth = Number(output.width || 0);
            const metadataHeight = Number(output.height || 0);
            const resultIndex = results.findIndex((item) => String(item.shotId) === String(shot.id) && resultKind(item) === kind);
            const previousResult = resultIndex >= 0 ? results[resultIndex] : null;
            const result = {
                shotId: shot.id,
                name: output.filename,
                filename: output.filename,
                subfolder: output.subfolder || "",
                type: output.type || "output",
                url: outputUrl,
                duration: Number(shot.seconds || 0),
                actualDuration: metadataDuration > 0 ? metadataDuration : Number(shot.seconds || 0),
                frameCount: Number(output.frameCount || 0),
                frameRate: Number(output.frameRate || resolutionState.fps),
                resolution: metadataWidth > 0 && metadataHeight > 0 ? `${metadataWidth}×${metadataHeight}` : `${width}×${height}`,
                created: previousResult?.created || new Date().toLocaleString(),
                selected: Boolean(previousResult?.selected),
            };
            if (resultIndex >= 0) results[resultIndex] = result; else results.push(result);
            if (!preferred || kind === "after") preferred = result;
        }
        shot.lastOutput = stageOutputs.get("after") || stageOutputs.get("before") || historyVideos.at(-1) || null;
        if (showPreview && preferred) {
            resultView = resultKind(preferred);
            previewResult = preferred;
            video.pause();
            image.hidden = true;
            empty.hidden = true;
            video.hidden = false;
            video.src = preferred.url;
            video.load();
        }
        renderResults();
        save();
        historyVideos.forEach((record) => {
            void finalizeVideoNameWithRetry(record).then((finalized) => {
                const kind = resultKind(record);
                const current = results.find((item) => String(item.shotId) === String(shot.id)
                    && resultKind(item) === kind
                    && sameOutputLocation(item, record));
                if (!current || !applyFinalizedRecord(current, finalized)) return;
                renderResults();
                save();
            }).catch((error) => {
                console.warn(`分镜“${shot.title || "未命名"}”视频文件名暂未整理，保留原文件播放`, error);
            });
        });
        return { historyVideos, stageOutputs };
    };
    const reconcileStoredResultNames = async () => {
        let changed = false;
        for (let index = results.length - 1; index >= 0; index -= 1) {
            const result = results[index];
            try {
                const finalized = await finalizeVideoName(result, true);
                const oldFilename = result.filename;
                if (finalized.filename !== result.filename || finalized.subfolder !== result.subfolder || finalized.type !== result.type) changed = true;
                Object.assign(result, finalized, { name: finalized.filename });
                if (oldFilename !== finalized.filename) repairFinalizedVideoElements(oldFilename, finalized.filename);
                result.url = api.apiURL(`/view?${new URLSearchParams({ filename: result.filename, subfolder: result.subfolder || "", type: result.type || "output" }).toString()}`);
                const shot = shots.find((item) => String(item.id) === String(result.shotId));
                if (shot?.lastOutput?.filename === oldFilename) shot.lastOutput = { ...shot.lastOutput, filename: result.filename, subfolder: result.subfolder, type: result.type };
            } catch (error) {
                // A transient 404 can happen while VHS is still materializing or
                // renaming the muxed file. Keep the stored result so a refresh or
                // later retry can recover it instead of making it disappear.
                result.finalizeWarning = String(error?.message || "最终视频文件名暂未整理");
            }
        }
        renderResults();
        if (changed) save();
    };
    const refreshGeneratedResults = async () => {
        for (const shot of shots) {
            const promptId = String(shot.lastPromptId || "");
            if (!promptId) continue;
            try {
                const history = await fetchSettledPromptHistory(promptId, null, 24);
                await ingestHistoryVideos(history, shot, { showPreview: String(shot.id) === String(activeShotId) });
            } catch (error) {
                console.warn(`分镜“${shot.title || "未命名"}”结果同步失败`, error);
            }
        }
        await reconcileStoredResultNames();
    };
    const recoverPreviousShotOutput = async (shot) => {
        if (!shot) return null;
        const storedResults = results.filter((item) => String(item.shotId) === String(shot.id) && item?.filename);
        const preferredStored = [
            ...storedResults.filter((item) => resultKind(item) === "after"),
            ...storedResults.filter((item) => resultKind(item) === "before"),
            ...storedResults,
        ];
        let stored = null;
        for (const candidate of preferredStored) {
            if (await outputRecordExists(candidate)) { stored = candidate; break; }
        }
        if (stored) {
            shot.lastOutput = {
                filename: stored.filename,
                subfolder: stored.subfolder || "",
                type: stored.type || "output",
            };
            shot.status = "done";
            save();
            return shot.lastOutput;
        }
        if (shot.lastOutput?.filename) {
            const previous = { ...shot.lastOutput };
            try {
                const finalized = await finalizeVideoName(previous, true);
                const candidate = {
                    ...previous,
                    filename: finalized.filename,
                    subfolder: finalized.subfolder || previous.subfolder || "",
                    type: finalized.type || previous.type || "output",
                };
                if (await outputRecordExists(candidate)) {
                    shot.lastOutput = candidate;
                    shot.status = "done";
                    save();
                    return shot.lastOutput;
                }
            } catch (error) {
                console.warn(`同步上一分镜“${shot.title || "未命名"}”的最终视频名失败`, error);
            }
        }
        const promptId = String(shot.lastPromptId || "");
        if (promptId) {
            try {
                const history = await fetchSettledPromptHistory(promptId, null, 24);
                await ingestHistoryVideos(history, shot, { showPreview: false });
            } catch (error) {
                console.warn(`恢复上一分镜“${shot.title || "未命名"}”的历史输出失败`, error);
            }
        }
        if (shot.lastOutput?.filename && await outputRecordExists(shot.lastOutput)) {
            shot.status = "done";
            save();
            return shot.lastOutput;
        }
        return null;
    };
    const injectContinuationPipeline = (prompt, shot) => {
        const nodes = prompt?.output;
        if (!nodes || typeof nodes !== "object") throw new Error("无法读取当前工作流，不能安装视频时长规范链路");
        const workbench = Object.entries(nodes).find(([, value]) => String(value?.class_type || "") === NODE);
        if (!workbench) throw new Error("工作流中没有找到闲兔视频导演台节点");
        const workbenchId = String(workbench[0]);
        let nextId = Math.max(0, ...Object.keys(nodes).map((key) => Number(key)).filter(Number.isFinite)) + 1;
        const allocateId = () => String(nextId++);
        const dependsOn = (nodeId, targetId, seen = new Set()) => {
            nodeId = String(nodeId); targetId = String(targetId);
            if (nodeId === targetId) return true;
            if (seen.has(nodeId)) return false;
            seen.add(nodeId);
            const inputs = nodes[nodeId]?.inputs || {};
            return Object.values(inputs).some((value) => Array.isArray(value) && value.length === 2 && dependsOn(value[0], targetId, seen));
        };

        const usesContextContinuation = Boolean(shot?.inheritPrevious) && shot?.mode !== "frames";
        if (usesContextContinuation) {
            let samplerCount = 0;
            for (const [samplerId, sampler] of Object.entries(nodes)) {
                const samplerType = String(sampler?.class_type || "");
                if (!dependsOn(samplerId, workbenchId)) continue;
                if (samplerType === "SelfLiftH3Sampler") {
                    // SelfLift rejects the workbench AV noise mask. Remove the
                    // sampler-facing mask, but never blend the source latent
                    // back after sampling: redraw context, then hard-trim it.
                    sampler.inputs ||= {};
                    const latentLink = sampler.inputs.latent_image;
                    if (!Array.isArray(latentLink)) continue;
                    const adapterId = allocateId();
                    nodes[adapterId] = {
                        class_type: "XiantuSelfLiftContinuationLatent",
                        inputs: { latent: latentLink, preserve_video_mask: false },
                    };
                    sampler.inputs.latent_image = [adapterId, 0];
                    samplerCount += 1;
                    continue;
                }
                if (samplerType !== "SamplerCustomAdvanced") continue;
                const guiderLink = sampler.inputs?.guider;
                const sigmaLink = sampler.inputs?.sigmas;
                if (!Array.isArray(guiderLink) || !Array.isArray(sigmaLink)) continue;
                const guider = nodes[String(guiderLink[0])];
                if (!guider?.inputs || !Array.isArray(guider.inputs.model)) continue;
                const patchId = allocateId();
                nodes[patchId] = {
                    class_type: "XiantuVideoContinuationModelPatch",
                    inputs: { model: guider.inputs.model, latent: [workbenchId, 1], sigmas: sigmaLink },
                };
                guider.inputs.model = [patchId, 0];
                samplerCount += 1;
            }
            if (!samplerCount) throw new Error("承接已开启，但没有找到连接到本工作台且支持动态重绘的 H3 采样器");
        }

        let trimCount = 0;
        const trimIds = [];
        const saveTargets = Object.entries({ ...nodes })
            .filter(([targetId, target]) => /(?:CreateVideo|VHS_VideoCombine|SaveVideo|VideoCombine)/i.test(String(target?.class_type || "")) && dependsOn(targetId, workbenchId))
            .sort(([leftId], [rightId]) => dependsOn(rightId, leftId) ? -1 : dependsOn(leftId, rightId) ? 1 : 0);
        for (const [targetId, target] of saveTargets) {
            // The workbench timeline is fixed at 24 FPS. Normalize downstream
            // encoders so a stale 48 FPS setting cannot turn a 10-second,
            // 240-frame result into a 5-second exported file.
            target.inputs ||= {};
            if (Object.prototype.hasOwnProperty.call(target.inputs, "frame_rate")) target.inputs.frame_rate = resolutionState.fps;
            if (Object.prototype.hasOwnProperty.call(target.inputs, "fps")) target.inputs.fps = resolutionState.fps;
            const imageLink = target.inputs?.images;
            if (!Array.isArray(imageLink)) continue;
            // A downstream encoder (for example the post-upscale VHS encoder)
            // may load the already trimmed upstream video. Never trim that same
            // branch a second time, otherwise every continuation loses another
            // contextTrimFrames block (192 - 22 = 170 frames at 24 FPS).
            if (trimIds.some((trimId) => dependsOn(String(imageLink[0]), trimId))) continue;
            const trimId = allocateId();
            const trimInputs = {
                images: imageLink,
                trim_frames: usesContextContinuation ? Number(shot.contextTrimFrames || continuityOverlapFrames) : 0,
                keep_frames: targetOutputFrames(shot.seconds),
            };
            if (Array.isArray(target.inputs.audio)) trimInputs.audio = target.inputs.audio;
            nodes[trimId] = { class_type: "XiantuVideoContinuationTrim", inputs: trimInputs };
            target.inputs.images = [trimId, 0];
            if (trimInputs.audio) target.inputs.audio = [trimId, 1];
            trimIds.push(trimId);
            trimCount += 1;
        }
        if (!trimCount) throw new Error("没有找到连接到本工作台的视频保存节点，无法规范最终视频时长");
        return prompt;
    };
    const injectPostProcessingPipeline = (prompt) => {
        runtime.injectedNodeTypes = new Map();
        if (!faceRepairSettings.enabled) return prompt;
        const nodes = prompt?.output;
        if (!nodes || typeof nodes !== "object") throw new Error("无法读取当前工作流，不能安装视频修复链路");
        const workbench = Object.entries(nodes).find(([, value]) => String(value?.class_type || "") === NODE);
        if (!workbench) throw new Error("工作流中没有找到“闲兔｜视频编辑工作台”节点");
        const workbenchId = String(workbench[0]);
        let nextId = Math.max(0, ...Object.keys(nodes).map((key) => Number(key)).filter(Number.isFinite)) + 1;
        const allocateId = () => String(nextId++);
        const dependsOn = (nodeId, targetId, seen = new Set()) => {
            nodeId = String(nodeId); targetId = String(targetId);
            if (nodeId === targetId) return true;
            if (seen.has(nodeId)) return false;
            seen.add(nodeId);
            const inputs = nodes[nodeId]?.inputs || {};
            return Object.values(inputs).some((value) => Array.isArray(value) && value.length === 2 && dependsOn(value[0], targetId, seen));
        };
        const saveTargetsForOutput = (outputIndex) => Object.entries(nodes).filter(([targetId, target]) => {
            const classType = String(target?.class_type || "");
            if (!/(?:CreateVideo|VHS_VideoCombine|SaveVideo|VideoCombine)/i.test(classType) || !dependsOn(targetId, workbenchId)) return false;
            if (!Array.isArray(target.inputs?.images)) return false;
            return Object.values(target.inputs || {}).some((value) => Array.isArray(value) && String(value[0]) === workbenchId && Number(value[1]) === outputIndex);
        });
        const afterTargets = saveTargetsForOutput(3);
        const beforeTargets = saveTargetsForOutput(2);
        const repairTargets = afterTargets.length ? afterTargets : beforeTargets;
        if (!repairTargets.length) throw new Error("已启用视频修复，但没有找到连接导演台的可用视频保存节点");
        let installed = 0;
        for (const [, target] of repairTargets) {
            let imageLink = target.inputs?.images;
            if (!Array.isArray(imageLink)) continue;
            if (faceRepairSettings.enabled) {
                const faceId = allocateId();
                nodes[faceId] = {
                    class_type: "XiantuVideoFaceRepair",
                    inputs: { images: imageLink, settings: JSON.stringify(faceRepairSettings) },
                };
                runtime.injectedNodeTypes.set(faceId, "XiantuVideoFaceRepair");
                imageLink = [faceId, 0];
            }
            target.inputs.images = imageLink;
            installed += 1;
        }
        if (!installed) throw new Error("视频保存节点没有图像输入，无法执行视频修复");
        return prompt;
    };
    const injectEncoderCompatibility = (prompt, sourceResolution) => {
        const nodes = prompt?.output;
        if (!nodes || typeof nodes !== "object") return prompt;
        let nextId = Math.max(0, ...Object.keys(nodes).map((key) => Number(key)).filter(Number.isFinite)) + 1;
        const findDlssAncestor = (nodeId, seen = new Set()) => {
            nodeId = String(nodeId);
            if (seen.has(nodeId)) return null;
            seen.add(nodeId);
            const current = nodes[nodeId];
            if (!current) return null;
            if (String(current.class_type || "") === "RH_DLSS5Enhance") return current;
            for (const value of Object.values(current.inputs || {})) {
                if (!Array.isArray(value) || value.length !== 2) continue;
                const found = findDlssAncestor(value[0], seen);
                if (found) return found;
            }
            return null;
        };
        const even = (value) => Math.max(2, Math.round(Number(value) || 0) & ~1);
        const scaleForMode = (mode, width, height) => {
            const text = String(mode || "");
            const fixed = text.match(/^(1(?:\.5|\.724)?|2|3)x/);
            if (fixed) return Number(fixed[1]);
            const bucketShort = { "1K": 1080, "2K": 1440, "4K": 2160, "8K": 4320 }[text];
            if (!bucketShort) return 1;
            const short = Math.min(width, height);
            if (short >= bucketShort) return 1;
            return [1.5, 1.724, 2, 3].find((factor) => even(short * factor) >= bucketShort) || 3;
        };
        const sourceWidth = Math.max(2, Number(sourceResolution?.width) || 0);
        const sourceHeight = Math.max(2, Number(sourceResolution?.height) || 0);
        for (const target of Object.values(nodes)) {
            if (String(target?.class_type || "") !== "VHS_VideoCombine") continue;
            if (String(target.inputs?.format || "") !== "video/nvenc_h264-mp4") continue;
            const imageLink = target.inputs?.images;
            if (!Array.isArray(imageLink) || imageLink.length !== 2) continue;
            const dlss = findDlssAncestor(imageLink[0]);
            if (!dlss) continue;
            const factor = scaleForMode(dlss.inputs?.upscaling_mode, sourceWidth, sourceHeight);
            const predictedWidth = even(sourceWidth * factor);
            const predictedHeight = even(sourceHeight * factor);
            const longest = Math.max(predictedWidth, predictedHeight);
            if (longest <= 4096) continue;
            const ratio = 4096 / longest;
            const safeWidth = even(predictedWidth * ratio);
            const safeHeight = even(predictedHeight * ratio);
            const scaleId = String(nextId++);
            nodes[scaleId] = {
                class_type: "ImageScale",
                inputs: {
                    image: imageLink,
                    upscale_method: "lanczos",
                    width: safeWidth,
                    height: safeHeight,
                    crop: "disabled",
                },
            };
            target.inputs.images = [scaleId, 0];
            runtime.injectedNodeTypes?.set(scaleId, "ImageScale");
            console.info(`闲兔导演台：H.264 NVENC 输出由 ${predictedWidth}×${predictedHeight} 自动规范为 ${safeWidth}×${safeHeight}`);
        }
        return prompt;
    };
    const waitForPrompt = (promptId, onProgress) => new Promise((resolve, reject) => {
        let finished = false;
        let timer = null;
        const deadlineAt = Date.now() + 12 * 60 * 60 * 1000;
        const cleanup = () => {
            if (finished) return;
            finished = true;
            clearInterval(timer);
            api.removeEventListener?.("execution_success", onSuccess);
            api.removeEventListener?.("execution_error", onError);
            api.removeEventListener?.("execution_interrupted", onInterrupted);
            api.removeEventListener?.("progress", onNodeProgress);
            api.removeEventListener?.("executing", onExecuting);
            api.removeEventListener?.("executed", onExecuted);
            api.removeEventListener?.("execution_cached", onCached);
        };
        const matches = (event) => String(event?.detail?.prompt_id ?? event?.detail?.promptId ?? "") === String(promptId);
        const onSuccess = async (event) => {
            if (!matches(event)) return;
            const history = await fetchSettledPromptHistory(promptId, event.detail);
            if (finished) return;
            cleanup(); resolve(history);
        };
        const onError = (event) => { if (matches(event)) { const message = event?.detail?.exception_message || event?.detail?.error || "分镜执行失败"; cleanup(); reject(new Error(String(message))); } };
        const onInterrupted = (event) => { if (matches(event)) { cleanup(); reject(new Error("分镜执行被中断")); } };
        const onNodeProgress = (event) => {
            const raw = event?.detail || {};
            const detail = raw.progress || raw;
            const eventPrompt = detail.prompt_id ?? detail.promptId ?? raw.prompt_id ?? raw.promptId;
            if (eventPrompt != null && String(eventPrompt) !== String(promptId)) return;
            if (eventPrompt == null && String(runtime.currentBatch?.promptId || "") !== String(promptId)) return;
            const value = Number(detail.value || 0), max = Math.max(1, Number(detail.max || 1));
            onProgress?.({ phase: "progress", value, max, node: detail.node ?? detail.node_id ?? raw.node ?? raw.node_id ?? "" });
        };
        const onExecuting = (event) => {
            const detail = event?.detail || {};
            const eventPrompt = detail.prompt_id ?? detail.promptId;
            if (eventPrompt != null && String(eventPrompt) !== String(promptId)) return;
            if (eventPrompt == null && String(runtime.currentBatch?.promptId || "") !== String(promptId)) return;
            const nodeId = detail.node ?? detail.node_id;
            if (nodeId != null) onProgress?.({ phase: "node", node: nodeId });
        };
        const onExecuted = (event) => {
            const detail = event?.detail || {};
            const eventPrompt = detail.prompt_id ?? detail.promptId;
            if (eventPrompt != null && String(eventPrompt) !== String(promptId)) return;
            if (eventPrompt == null && String(runtime.currentBatch?.promptId || "") !== String(promptId)) return;
            const nodeId = detail.node ?? detail.node_id;
            if (nodeId != null) onProgress?.({ phase: "executed", node: nodeId });
        };
        const onCached = (event) => {
            const detail = event?.detail || {};
            const eventPrompt = detail.prompt_id ?? detail.promptId;
            if (eventPrompt != null && String(eventPrompt) !== String(promptId)) return;
            if (eventPrompt == null && String(runtime.currentBatch?.promptId || "") !== String(promptId)) return;
            const nodes = Array.isArray(detail.nodes) ? detail.nodes : [];
            nodes.forEach((nodeId) => onProgress?.({ phase: "cached", node: nodeId }));
        };
        api.addEventListener?.("execution_success", onSuccess);
        api.addEventListener?.("execution_error", onError);
        api.addEventListener?.("execution_interrupted", onInterrupted);
        api.addEventListener?.("progress", onNodeProgress);
        api.addEventListener?.("executing", onExecuting);
        api.addEventListener?.("executed", onExecuted);
        api.addEventListener?.("execution_cached", onCached);
        timer = setInterval(async () => {
            if (finished) return;
            if (Date.now() >= deadlineAt) {
                cleanup();
                reject(new Error("等待 ComfyUI 任务超过 12 小时，请检查队列或服务状态"));
                return;
            }
            try {
                const response = await api.fetchApi(`/history/${encodeURIComponent(promptId)}`);
                if (!response.ok) return;
                const history = await response.json();
                const record = history?.[promptId];
                const status = String(record?.status?.status_str || "");
                if (status === "success") {
                    const settled = await fetchSettledPromptHistory(promptId, record);
                    if (finished) return;
                    cleanup(); resolve(settled || record);
                }
                else if (status === "error") { cleanup(); reject(new Error("分镜执行失败，请查看 ComfyUI 任务错误")); }
            } catch {}
        }, 1000);
    });
    const startGenerate = async () => {
        showDirectorError();
        if (runtime.busy) return;
        updatePrompt();
        const originalShotId = activeShotId;
        const selected = shots.filter((shot) => shot.selected);
        const jobs = selected.length ? selected : [activeShot()];
        const button = q("[data-generate]");
        runtime.busy = true;
        runtime.cancelRequested = false;
        runtime.progressTrace = [];
        runtime.currentBatch = { index: 0, total: jobs.length, promptId: "" };
        startGenerationClock();
        runtime.buttonText = "■ 停止生成";
        button.disabled = false;
        button.textContent = "■ 停止生成";
        button.title = "";
        setGenerationProgress({ title: "初始化任务", actionDetail: `共 ${jobs.length} 个分镜`, batchDetail: `分镜 0/${jobs.length}`, percent: 0, phase: "prepare", phasePercent: 0, traceKey: "internal:init" });
        try {
            for (let index = 0; index < jobs.length; index += 1) {
                if (runtime.cancelRequested) throw new Error("用户停止生成");
                const shot = jobs[index];
                runtime.currentBatch = { index, total: jobs.length, promptId: "" };
                // The top-right timer is for the current storyboard item, not
                // the whole batch. Reset as soon as control moves to a new item.
                startGenerationClock();
                const preparationSteps = 18;
                await reportPreparationStep(1, preparationSteps, "读取分镜任务", shot.title || `分镜 ${index + 1}`);
                activeShotId = shot.id;
                await reportPreparationStep(2, preparationSteps, "切换当前分镜", shot.title || `分镜 ${index + 1}`);
                const position = shots.findIndex((item) => item.id === shot.id);
                const previous = position > 0 ? shots[position - 1] : null;
                await reportPreparationStep(3, preparationSteps, "读取分镜顺序", `第 ${position + 1} 个分镜`);
                const generationResolution = resolutionFor();
                await reportPreparationStep(4, preparationSteps, "读取生成参数", `${generationResolution.width}×${generationResolution.height} · ${resolutionState.fps} FPS · ${shot.seconds} 秒`);
                await reportPreparationStep(5, preparationSteps, "读取提示词", `${String(shot.prompt || "").length} 个字符`);
                await reportPreparationStep(6, preparationSteps, "校验承接关系", shot.inheritPrevious ? "检查上一分镜输出" : "本分镜不承接");
                const previousOutput = shot.inheritPrevious ? await recoverPreviousShotOutput(previous) : null;
                if (shot.inheritPrevious && !previousOutput?.filename) {
                    throw new Error(`${shot.title || `分镜 ${position + 1}`} 要承接上一分镜，但上一分镜还没有已保存的成功输出`);
                }
                const usesContextContinuation = Boolean(shot.inheritPrevious) && shot.mode !== "frames";
                shot.contextTrimFrames = usesContextContinuation ? continuityOverlapFrames : 0;
                await reportPreparationStep(7, preparationSteps, "写入承接参数", shot.inheritPrevious ? (usesContextContinuation ? `取 ${shot.contextTrimFrames} 帧重绘并裁剪` : "取上一分镜最后一帧作为首帧") : "不使用承接");
                const generationAssets = effectiveAssetsForShot(shot);
                await reportPreparationStep(8, preparationSteps, "读取参考素材列表", `共 ${generationAssets.length} 个素材`);
                for (let assetIndex = 0; assetIndex < generationAssets.length; assetIndex += 1) {
                    const asset = generationAssets[assetIndex];
                    await reportPreparationStep(8 + (assetIndex + 1) / Math.max(1, generationAssets.length), preparationSteps, `校验素材 ${assetIndex + 1}/${generationAssets.length}`, `${asset.type || "文件"} · ${asset.alias || asset.name || asset.id}`);
                    if (!asset.serverName) throw new Error(`分镜 ${index + 1} 的素材“${asset.alias || asset.name || asset.id}”尚未保存，请重新上传`);
                }
                shot.generationAssetIds = generationAssets.map((asset) => asset.id);
                await reportPreparationStep(9, preparationSteps, "写入参考素材参数", `${shot.generationAssetIds.length} 个素材已写入`);
                shot.status = "queued";
                await reportPreparationStep(10, preparationSteps, "更新分镜状态", "已进入生成队列");
                renderShots(); loadShot(); save();
                runtime.buttonText = "■ 停止生成";
                button.textContent = runtime.buttonText;
                await reportPreparationStep(11, preparationSteps, "保存工作台状态", "分镜、参数和参考素材");
                const shotSeed = refreshWorkflowSeed();
                shot.lastSeed = shotSeed;
                await reportPreparationStep(12, preparationSteps, "读取工作流节点", `收集节点与连接 · 随机种子 ${shotSeed}`);
                const graphPrompt = await app.graphToPrompt();
                injectWorkflowSeed(graphPrompt, shotSeed);
                await reportPreparationStep(13, preparationSteps, "序列化工作流", `${Object.keys(graphPrompt?.output || {}).length} 个执行节点`);
                await reportPreparationStep(14, preparationSteps, "安装承接链路", shot.inheritPrevious ? (usesContextContinuation ? `${shot.contextTrimFrames} 帧上下文重绘和精确裁剪` : "最后一帧首帧承接") : "无需承接，保持原工作流");
                const continuityPrompt = injectContinuationPipeline(graphPrompt, shot);
                await reportPreparationStep(15, preparationSteps, "安装人脸修复链路", faceRepairSettings.enabled ? "远景人脸修复已接入" : "人脸修复未开启");
                const prompt = injectEncoderCompatibility(injectPostProcessingPipeline(continuityPrompt), generationResolution);
                await reportPreparationStep(16, preparationSteps, "写入后处理参数", faceRepairSettings.enabled ? "人脸检测、修复和输出参数" : "保持原始生成结果");
                prompt.workflow ??= {};
                prompt.workflow.extra ??= {};
                prompt.workflow.extra.VHS_KeepIntermediate = false;
                prompt.workflow.extra.VHS_MetadataImage = false;
                await reportPreparationStep(17, preparationSteps, "设置输出规则", "仅保留最终视频，不保存中间文件");
                Object.values(prompt.output || {}).forEach((promptNode) => {
                    if (String(promptNode?.class_type || "") === "VHS_VideoCombine" && promptNode.inputs) {
                        promptNode.inputs.save_metadata = false;
                        promptNode.inputs.save_output = true;
                    }
                });
                await reportPreparationStep(18, preparationSteps, "提交工作流", "正在发送到 ComfyUI");
                const response = await api.queuePrompt(0, prompt);
                if (!response?.prompt_id) throw new Error("ComfyUI 没有返回 prompt_id");
                runtime.currentBatch.promptId = String(response.prompt_id);
                shot.status = "running";
                shot.lastPromptId = String(response.prompt_id);
                save();
                let executionStarted = false;
                const historyPromise = waitForPrompt(response.prompt_id, ({ phase, value = 0, max = 1, node = "" }) => {
                    executionStarted = true;
                    const info = executionNodeInfo(node);
                    runtime.buttonText = "■ 停止生成";
                    button.textContent = runtime.buttonText;
                    if (phase === "cached") {
                        setGenerationProgress({ title: `读取${info.action}缓存`, actionDetail: "", batchDetail: `分镜 ${index + 1}/${jobs.length}`, percent: runtimeOverallPercent(12), phase: "load", phasePercent: null, traceKey: `cached:${node}`, traceLabel: `缓存 ${info.action}` });
                    } else if (phase === "executed") {
                        setGenerationProgress({ title: `${info.action}完成`, actionDetail: "", batchDetail: `分镜 ${index + 1}/${jobs.length}`, percent: runtimeOverallPercent(actionStageRange(info.action)[0] + actionStageRange(info.action)[1]), phase: inferProgressPhase(info.action), phasePercent: 100, traceKey: `executed:${node}`, traceLabel: `${info.action}完成` });
                    } else reportExecutionNode(node, phase === "progress" ? value : null, phase === "progress" ? max : null);
                });
                setGenerationProgress({ title: "提交工作流完成", actionDetail: "ComfyUI 已接收", batchDetail: `分镜 ${index + 1}/${jobs.length}`, percent: runtimeOverallPercent(8), phase: "prepare", phasePercent: 100, traceKey: `internal:${index}:submitted` });
                await new Promise((resolve) => requestAnimationFrame(resolve));
                if (!executionStarted) setGenerationProgress({ title: "等待第一个节点开始", actionDetail: "", batchDetail: `分镜 ${index + 1}/${jobs.length}`, percent: runtimeOverallPercent(8), phase: "load", phasePercent: null, traceKey: `internal:${index}:queued` });
                const history = await historyPromise;
                if (runtime.cancelRequested) throw new Error("用户停止生成");
                shot.lastPromptId = String(response.prompt_id);
                setGenerationProgress({ title: "读取生成结果", actionDetail: "解析本次任务输出", batchDetail: `分镜 ${index + 1}/${jobs.length}`, percent: runtimeOverallPercent(99), phase: "save", phasePercent: 30, traceKey: `internal:${index}:history` });
                setGenerationProgress({ title: "整理最终文件名", actionDetail: "保留最终视频并同步预览", batchDetail: `分镜 ${index + 1}/${jobs.length}`, percent: runtimeOverallPercent(99.4), phase: "save", phasePercent: 60, traceKey: `internal:${index}:filename` });
                const { stageOutputs } = await ingestHistoryVideos(history, shot, { showPreview: true });
                shot.completedAt = Date.now();
                shot.generationElapsedMs = runtime.startedAt ? Math.max(0, Date.now() - runtime.startedAt) : runtime.elapsedMs;
                shot.status = "done";
                if (stageOutputs.size) setGenerationProgress({ title: "更新视频列表", actionDetail: "视频已实时写入列表和预览窗口", batchDetail: `分镜 ${index + 1}/${jobs.length}`, percent: runtimeOverallPercent(99.7), phase: "save", phasePercent: 85, traceKey: `internal:${index}:results` });
                save();
                setGenerationProgress({ title: "完成", actionDetail: shot.title || `分镜 ${position + 1}`, batchDetail: `分镜 ${index + 1}/${jobs.length}`, percent: (index + 1) / jobs.length * 100, phase: "done", phasePercent: 100 });
                if (index < jobs.length - 1 && (index + 1) % cleanupSettings.every === 0) {
                    setGenerationProgress({ title: "卸载", actionDetail: "缓存/显存/模型", batchDetail: `分镜 ${index + 1}/${jobs.length}`, percent: (index + 1) / jobs.length * 100, phase: "load", phasePercent: null });
                    await cleanupResources();
                    setGenerationProgress({ title: "准备", actionDetail: "下一分镜", batchDetail: `分镜 ${index + 2}/${jobs.length}`, percent: (index + 1) / jobs.length * 100, phase: "prepare", phasePercent: null });
                }
            }
            runtime.buttonText = "全部完成";
            button.textContent = runtime.buttonText;
            setGenerationProgress({ title: "完成", actionDetail: "全部分镜", batchDetail: `分镜 ${jobs.length}/${jobs.length}`, percent: 100, phase: "done", phasePercent: 100 });
        } catch (error) {
            console.error("视频导演台顺序生成失败", error);
            const failedShot = activeShot();
            const done = jobs.filter((item) => item.status === "done").length;
            if (runtime.cancelRequested) {
                if (failedShot && failedShot.status !== "done") failedShot.status = "stopped";
                runtime.buttonText = "▶ 继续生成";
                button.textContent = runtime.buttonText;
                button.title = "";
                setGenerationProgress({ title: "已停止，正在卸载", actionDetail: "模型、显存和缓存", batchDetail: `分镜 ${done}/${jobs.length}`, percent: done / Math.max(1, jobs.length) * 100, phase: "load", phasePercent: null });
                await cleanupResources({ cache: true, vram: true, models: true });
                setGenerationProgress({ title: "已停止", actionDetail: "", batchDetail: `分镜 ${done}/${jobs.length}`, percent: done / Math.max(1, jobs.length) * 100, phase: "prepare", phasePercent: 0 });
            } else {
                if (failedShot && failedShot.status !== "done") failedShot.status = "error";
                runtime.buttonText = "生成失败";
                button.textContent = runtime.buttonText;
                button.title = String(error?.message || error);
                showDirectorError(String(error?.message || error));
                setGenerationProgress({ title: `生成失败：${String(error?.message || error)}`, actionDetail: "", batchDetail: `分镜 ${done}/${jobs.length}`, percent: done / Math.max(1, jobs.length) * 100, phase: "prepare", phasePercent: 0 });
            }
        } finally {
            stopGenerationClock();
            activeShotId = shots.some((shot) => shot.id === originalShotId) ? originalShotId : shots[0].id;
            renderShots(); loadShot(); renderResults(); save();
            runtime.busy = false;
            runtime.externalBusy = false;
            runtime.cancelRequested = false;
            runtime.currentBatch = null;
            runtime.listeners.forEach((listener) => listener(runtime.progress || generationProgress));
            setTimeout(() => { runtime.buttonText = "▶ 开始生成"; runtime.listeners.forEach((listener) => listener(runtime.progress || generationProgress)); }, 1800);
        }
    };
    const generateOrCancel = async () => {
        if (!runtime.busy) return startGenerate();
        if (runtime.cancelRequested) return;
        runtime.cancelRequested = true;
        runtime.buttonText = "正在停止…";
        q("[data-generate]").disabled = true;
        q("[data-generate]").textContent = runtime.buttonText;
        setGenerationProgress({ ...(runtime.progress || generationProgress), title: "正在停止", actionDetail: "当前任务" });
        try {
            await api.fetchApi("/interrupt", { method: "POST" });
        } catch (error) {
            console.warn("停止当前 ComfyUI 任务失败，批量队列仍会停止", error);
        }
    };
    q("[data-generate]").onclick = generateOrCancel;
    if (runtime.busy) {
        q("[data-generate]").disabled = Boolean(runtime.cancelRequested);
        q("[data-generate]").textContent = runtime.cancelRequested ? "正在停止…" : "■ 停止生成";
    }
    q("[data-result-refresh]").onclick = () => refreshGeneratedResults();
    root.querySelectorAll("[data-result-tab]").forEach((tab) => tab.onclick = () => { resultView = tab.dataset.resultTab; renderResults(); save(); });
    q("[data-result-folder]").onclick = () => openOutputFolder().catch((error) => { q("[data-result-folder]").title = String(error.message || error); });
    q("[data-result-merge]").onclick = async () => {
        const mergeKind = resultView === "before" ? "before" : resultView === "after" ? "after" : "";
        if (!mergeKind) { q("[data-result-merge]").title = "请先切换到“放大前”或“放大后”列表"; return; }
        const chosen = results.filter((result) => result.selected && resultKind(result) === mergeKind).sort((left, right) => shots.findIndex((shot) => String(shot.id) === String(left.shotId)) - shots.findIndex((shot) => String(shot.id) === String(right.shotId)));
        if (!chosen.length) { q("[data-result-merge]").title = `请先在“${mergeKind === "before" ? "放大前" : "放大后"}”中勾选视频`; return; }
        const button = q("[data-result-merge]");
        button.disabled = true; button.textContent = "合并中";
        try {
            const response = await api.fetchApi("/xiantu/video-editor/merge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videos: chosen.map(({ filename, subfolder, type }) => ({ filename, subfolder, type })) }) });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(payload.error || "合并失败");
            const url = api.apiURL(`/view?${new URLSearchParams({ filename: payload.filename, subfolder: payload.subfolder || "", type: payload.type || "output" }).toString()}`);
            const mergedDuration = chosen.reduce((sum, item) => sum + Number(item.actualDuration || item.duration || 0), 0);
            results.push({ shotId: "", name: payload.filename.replace(/\.mp4$/i, ""), filename: payload.filename, subfolder: payload.subfolder || "", type: payload.type || "output", url, duration: mergedDuration, actualDuration: mergedDuration, resolution: chosen[0]?.resolution || "", created: new Date().toLocaleString(), selected: false, merged: true });
            resultView = "merged";
            renderResults(); save();
        } catch (error) { button.title = String(error?.message || error); }
        finally { button.disabled = false; button.textContent = "▦ 合并输出"; }
    };
    const setTimelineScale = (value) => { timelineScale = Math.max(20, Math.min(100, Number(value) || 38)); renderTimeline(); save(); };
    q("[data-timeline-zoom]").oninput = (event) => setTimelineScale(event.target.value);
    q("[data-timeline-zoom-out]").onclick = () => setTimelineScale(timelineScale - 6);
    q("[data-timeline-zoom-in]").onclick = () => setTimelineScale(timelineScale + 6);
    q("[data-result-all]").onchange = (event) => { results.filter((result) => resultKind(result) === resultView).forEach((result) => { result.selected = event.target.checked; }); renderResults(); save(); };
    q("[data-result-delete-selected]").onclick = () => {
        for (let index = results.length - 1; index >= 0; index -= 1) {
            if (!results[index].selected || resultKind(results[index]) !== resultView) continue;
            if (String(results[index].url || "").startsWith("blob:")) URL.revokeObjectURL(results[index].url);
            results.splice(index, 1);
        }
        renderResults(); save();
    };
    const close = () => {
        video.pause();
        clearInterval(hardwareTimer);
        clearInterval(generationElapsedTimer);
        runtime.listeners.delete(renderGenerationProgress);
        Object.entries(globalExecutionHandlers).forEach(([name, handler]) => api.removeEventListener?.(name, handler));
        assetList.forEach((asset) => URL.revokeObjectURL(asset.url));
        libraryAssets.splice(0);
        root.remove(); node._xveWorkbench = null;
    };
    q("[data-close-workbench]").onclick = close;
    root.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        const openMenus = root.querySelectorAll(".xve-asset-menu,.xve-global-menu");
        if (openMenus.length || !q("[data-mention-menu]").hidden) {
            openMenus.forEach((menu) => menu.remove());
            hideMentionMenu();
            event.stopPropagation();
            return;
        }
        close();
    });
    root.addEventListener("click", (event) => {
        if (!event.target.closest("[data-generation-settings],[data-settings-toggle]")) settingsPanel.hidden = true;
        if (!event.target.closest(".xve-asset-menu,.xve-global-menu,.xve-mention-menu") && !event.target.closest(".xve-asset>button,.xve-global-assets article>button")) {
            root.querySelectorAll(".xve-asset-menu,.xve-global-menu").forEach((menu) => menu.remove());
            hideMentionMenu();
        }
    });

    syncContinuityUI(); renderShots(); loadShot(); renderResults(); save();
    refreshGeneratedResults().catch((error) => console.warn("视频结果实时同步失败", error));
    hydrateLegacyAssets().catch((error) => console.warn("旧参考素材恢复失败", error));
    setTimeout(() => root.focus(), 0);
    return root;
}

app.registerExtension({
    name: "Xiantu.VideoEditorWorkbench",
    async nodeCreated(node) {
        if (String(node.comfyClass || node.type) !== NODE) return;
        node.title = "闲兔 漫剧/短剧工作导演台";
        const hideInternalWidget = (widget) => {
            if (!widget) return;
            widget.type = "converted-widget";
            widget.hidden = true;
            widget.computeSize = () => [0, -4];
            widget.draw = () => {};
            widget.mouse = () => false;
            widget.serialize = true;
            widget.serializeValue = async () => widget.value;
            if (widget.element) widget.element.style.display = "none";
        };
        for (const widget of node.widgets || []) {
            if (["project_id", "editor_state"].includes(widget.name)) {
                hideInternalWidget(widget);
            }
        }
        // Repair already-saved workbench nodes in place: the former single
        // save-name output becomes the pre-upscale path and the post-upscale
        // path is appended without disturbing existing conditioning links.
        const wantedOutputs = [
            ["条件", "CONDITIONING"],
            ["Latent", "LATENT"],
            ["H3放大前文件名", "STRING"],
            ["H3放大后文件名", "STRING"],
        ];
        for (let index = 0; index < wantedOutputs.length; index += 1) {
            const [name, type] = wantedOutputs[index];
            if (!node.outputs?.[index]) node.addOutput?.(name, type);
            const slot = node.outputs?.[index];
            if (slot) {
                slot.name = name;
                slot.type = type;
                slot.localized_name = name;
            }
        }
        const open = () => {
            if (node._xveWorkbench?.isConnected) return;
            document.querySelector(".xve-overlay")?.remove();
            node._xveWorkbench = createWorkbench(node);
            document.body.appendChild(node._xveWorkbench);
        };
        node.addWidget("button", "打开视频编辑工作台", null, open, { serialize: false });
        requestAnimationFrame(() => {
            const computed = node.computeSize?.() || [300, 150];
            node.setSize?.([Math.max(300, Number(computed[0]) || 300), Math.max(150, Number(computed[1]) || 150)]);
            node.graph?.setDirtyCanvas?.(true, true);
        });
    },
});
