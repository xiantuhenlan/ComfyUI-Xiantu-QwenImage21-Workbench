import { app } from "../../scripts/app.js";

const NODE = "XiantuVideoEditorWorkbench";

if (!document.querySelector("link[data-xiantu-video-editor-style]")) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL("./xiantu_video_editor.css?v=20261008-1", import.meta.url).href;
    link.dataset.xiantuVideoEditorStyle = "1";
    document.head.appendChild(link);
}

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
}[char]));

const toolItems = [
    ["media", "素材", "▣"], ["audio", "音频", "♫"], ["text", "文本", "T"],
    ["sticker", "贴纸", "☆"], ["effect", "特效", "✦"], ["transition", "转场", "⋈"],
    ["caption", "字幕", "▤"], ["filter", "滤镜", "◉"], ["adjust", "调节", "☷"],
];

function createWorkbench(node) {
    const root = document.createElement("div");
    root.className = "xve-overlay";
    root.tabIndex = -1;
    root.innerHTML = `
      <section class="xve-app" role="dialog" aria-label="闲兔视频编辑工作台">
        <header class="xve-topbar">
          <div class="xve-brand"><span class="xve-logo">✂</span><strong>闲兔视频编辑工作台</strong></div>
          <button class="xve-project-name" data-project-name>未命名项目⌄</button>
          <span class="xve-save-state" data-save-state>● 已自动保存</span>
          <div class="xve-top-actions">
            <button class="xve-btn ghost">分享</button><button class="xve-btn primary">导出</button>
            <button class="xve-close" data-close title="关闭">×</button>
          </div>
        </header>
        <main class="xve-main">
          <nav class="xve-tools">
            ${toolItems.map(([id, label, symbol], i) => `<button class="xve-tool ${i === 0 ? "active" : ""}" data-tool="${id}"><b>${symbol}</b><span>${label}</span></button>`).join("")}
          </nav>
          <aside class="xve-library">
            <div class="xve-panel-head"><strong data-library-title>媒体素材</strong><button class="xve-mini">•••</button></div>
            <div class="xve-library-actions">
              <button class="xve-btn primary" data-import>＋ 导入素材</button>
              <input data-file-input type="file" accept="video/*,audio/*,image/*" multiple hidden>
            </div>
            <div class="xve-library-tabs"><button class="active">本地</button><button>项目素材</button></div>
            <div class="xve-assets" data-assets>
              <button class="xve-import-card" data-import-card><span>＋</span><b>导入素材</b><small>视频 / 音频 / 图片</small></button>
              <div class="xve-empty-tip" data-empty-tip>导入素材后，可拖到下方时间线</div>
            </div>
          </aside>
          <section class="xve-player-panel">
            <div class="xve-panel-head"><strong>播放器</strong><span data-preview-name>暂无素材</span></div>
            <div class="xve-stage" data-stage>
              <div class="xve-stage-empty" data-stage-empty><span>▶</span><p>从左侧导入或选择素材预览</p></div>
              <video data-video playsinline></video><img data-image alt="预览">
            </div>
            <div class="xve-player-controls">
              <span data-current-time>00:00:00</span><button data-play>▶</button><span data-total-time>00:00:00</span>
              <div class="xve-control-spacer"></div><button>适应</button><button>16:9</button><button>⛶</button>
            </div>
          </section>
          <aside class="xve-inspector">
            <div class="xve-inspector-tabs"><button class="active">画面</button><button>音频</button><button>变速</button><button>动画</button><button>调节</button><button>AI效果</button></div>
            <div class="xve-subtabs"><button class="active">基础</button><button>抠像</button><button>蒙版</button><button>美颜美体</button></div>
            <div class="xve-property-group">
              <div class="xve-property-title"><strong>位置大小</strong><button>↶</button></div>
              <label>缩放 <input data-scale type="range" min="10" max="300" value="100"><output data-scale-value>100%</output></label>
              <label class="xve-switch-row">等比缩放 <input type="checkbox" checked></label>
              <div class="xve-fields"><label>X <input data-x type="number" value="0"></label><label>Y <input data-y type="number" value="0"></label></div>
              <label>旋转 <input data-rotate type="number" value="0" step="0.1"><span>°</span></label>
            </div>
            <details open><summary>混合</summary><label>不透明度 <input type="range" min="0" max="100" value="100"></label></details>
            <details><summary>变形</summary></details><details><summary>描边</summary></details><details><summary>阴影</summary></details>
          </aside>
        </main>
        <section class="xve-timeline-panel">
          <div class="xve-timeline-toolbar">
            <button data-add-track>＋</button><button>↖</button><button>↶</button><button>↷</button><button>◫</button><button>✂</button><button>▣</button>
            <span></span><button>🎙</button><button>吸附</button><label>缩放 <input type="range" min="30" max="160" value="80"></label>
          </div>
          <div class="xve-timeline">
            <div class="xve-track-labels"><div class="xve-ruler-label">轨道</div><div>V1　🔒　◉</div><div>A1　🔒　♫</div></div>
            <div class="xve-track-area" data-track-area>
              <div class="xve-ruler"><span>00:00</span><span>00:05</span><span>00:10</span><span>00:15</span><span>00:20</span><span>00:25</span><span>00:30</span></div>
              <div class="xve-playhead"></div>
              <div class="xve-track video" data-video-track><em>把视频或图片拖到这里</em></div>
              <div class="xve-track audio" data-audio-track><em>把音频拖到这里</em></div>
            </div>
          </div>
        </section>
      </section>`;

    const q = (selector) => root.querySelector(selector);
    const video = q("[data-video]");
    const image = q("[data-image]");
    const stageEmpty = q("[data-stage-empty]");
    const input = q("[data-file-input]");
    const assets = q("[data-assets]");
    const editorStateWidget = (node.widgets || []).find((widget) => widget.name === "editor_state");
    const projectWidget = (node.widgets || []).find((widget) => widget.name === "project_id");
    const assetList = [];

    const formatTime = (seconds) => {
        const value = Math.max(0, Number(seconds) || 0);
        const hours = Math.floor(value / 3600);
        const minutes = Math.floor((value % 3600) / 60);
        const secs = Math.floor(value % 60);
        return [hours, minutes, secs].map((part) => String(part).padStart(2, "0")).join(":");
    };
    const save = () => {
        q("[data-save-state]").textContent = "● 已自动保存";
        if (editorStateWidget) editorStateWidget.value = JSON.stringify({
            assets: assetList.map(({ name, type, duration }) => ({ name, type, duration })),
            updated_at: Date.now(),
        });
        node.graph?.setDirtyCanvas?.(true, true);
    };
    const applyTransform = () => {
        const scale = Number(q("[data-scale]").value) / 100;
        const x = Number(q("[data-x]").value) || 0;
        const y = Number(q("[data-y]").value) || 0;
        const rotate = Number(q("[data-rotate]").value) || 0;
        const transform = `translate(${x}px, ${y}px) scale(${scale}) rotate(${rotate}deg)`;
        video.style.transform = transform; image.style.transform = transform;
        q("[data-scale-value]").value = `${Math.round(scale * 100)}%`;
    };
    const preview = (asset) => {
        q("[data-preview-name]").textContent = asset.name;
        stageEmpty.hidden = true; video.pause(); video.hidden = true; image.hidden = true;
        if (asset.type.startsWith("video/")) {
            video.src = asset.url; video.hidden = false; video.load();
        } else if (asset.type.startsWith("image/")) {
            image.src = asset.url; image.hidden = false; q("[data-total-time]").textContent = "00:00:05";
        } else {
            video.src = asset.url; video.hidden = false; video.load();
        }
    };
    const addToTimeline = (asset) => {
        const target = asset.type.startsWith("audio/") ? q("[data-audio-track]") : q("[data-video-track]");
        target.querySelector("em")?.remove();
        const clip = document.createElement("button");
        clip.className = "xve-clip";
        clip.style.width = `${Math.max(110, Math.min(420, (asset.duration || 5) * 22))}px`;
        clip.innerHTML = `<span>${asset.type.startsWith("audio/") ? "♫" : "▧"}</span><b>${escapeHtml(asset.name)}</b>`;
        clip.onclick = () => { root.querySelectorAll(".xve-clip.selected").forEach((item) => item.classList.remove("selected")); clip.classList.add("selected"); preview(asset); };
        target.appendChild(clip); save();
    };
    const addAssetCard = (asset) => {
        const card = document.createElement("article");
        card.className = "xve-asset"; card.draggable = true;
        const visual = asset.type.startsWith("image/")
            ? `<img src="${asset.url}" alt="">`
            : asset.type.startsWith("video/") ? `<video src="${asset.url}" muted preload="metadata"></video>` : `<div class="xve-audio-art">♫</div>`;
        card.innerHTML = `${visual}<b title="${escapeHtml(asset.name)}">${escapeHtml(asset.name)}</b><small>${asset.type.split("/")[0]}</small><button title="添加到时间线">＋</button>`;
        card.onclick = (event) => { if (!event.target.closest("button")) preview(asset); };
        card.ondblclick = () => addToTimeline(asset);
        card.querySelector("button").onclick = () => addToTimeline(asset);
        card.ondragstart = (event) => event.dataTransfer.setData("text/x-xiantu-asset", String(assetList.indexOf(asset)));
        assets.appendChild(card);
    };
    const importFiles = (files) => {
        for (const file of files) {
            const asset = { name: file.name, type: file.type || "application/octet-stream", url: URL.createObjectURL(file), duration: 5 };
            assetList.push(asset); addAssetCard(asset);
            const probe = document.createElement(file.type.startsWith("audio/") ? "audio" : "video");
            if (file.type.startsWith("audio/") || file.type.startsWith("video/")) {
                probe.preload = "metadata"; probe.src = asset.url;
                probe.onloadedmetadata = () => { asset.duration = Number.isFinite(probe.duration) ? probe.duration : 5; save(); };
            }
        }
        q("[data-empty-tip]")?.remove(); if (assetList[0]) preview(assetList.at(-1)); save();
    };
    const openFiles = () => input.click();
    q("[data-import]").onclick = openFiles; q("[data-import-card]").onclick = openFiles;
    input.onchange = () => { importFiles(input.files || []); input.value = ""; };
    for (const track of [q("[data-video-track]"), q("[data-audio-track]")]) {
        track.ondragover = (event) => { event.preventDefault(); track.classList.add("dragover"); };
        track.ondragleave = () => track.classList.remove("dragover");
        track.ondrop = (event) => { event.preventDefault(); track.classList.remove("dragover"); const asset = assetList[Number(event.dataTransfer.getData("text/x-xiantu-asset"))]; if (asset) addToTimeline(asset); };
    }
    q("[data-play]").onclick = () => {
        if (video.hidden || !video.src) return;
        if (video.paused) video.play(); else video.pause();
    };
    video.onplay = () => { q("[data-play]").textContent = "❚❚"; };
    video.onpause = () => { q("[data-play]").textContent = "▶"; };
    video.ontimeupdate = () => { q("[data-current-time]").textContent = formatTime(video.currentTime); };
    video.onloadedmetadata = () => { q("[data-total-time]").textContent = formatTime(video.duration); };
    for (const selector of ["[data-scale]", "[data-x]", "[data-y]", "[data-rotate]"]) q(selector).oninput = applyTransform;
    root.querySelectorAll("[data-tool]").forEach((button) => button.onclick = () => {
        root.querySelectorAll("[data-tool]").forEach((item) => item.classList.remove("active")); button.classList.add("active");
        q("[data-library-title]").textContent = button.querySelector("span").textContent;
    });
    q("[data-project-name]").onclick = () => {
        const next = window.prompt("项目名称", q("[data-project-name]").textContent.replace("⌄", ""));
        if (!next?.trim()) return;
        q("[data-project-name]").textContent = `${next.trim()}⌄`;
        if (projectWidget) projectWidget.value = next.trim(); save();
    };
    const close = () => { video.pause(); root.remove(); node._xveWorkbench = null; };
    q("[data-close]").onclick = close;
    root.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
    setTimeout(() => root.focus(), 0);
    return root;
}

app.registerExtension({
    name: "Xiantu.VideoEditorWorkbench",
    async nodeCreated(node) {
        if (String(node.comfyClass || node.type) !== NODE) return;
        node.title = "闲兔｜视频编辑工作台";
        for (const widget of node.widgets || []) {
            if (["project_id", "editor_state"].includes(widget.name)) {
                widget.type = "hidden"; widget.computeSize = () => [0, -4]; widget.serialize = true;
            }
        }
        const open = () => {
            if (node._xveWorkbench?.isConnected) return;
            document.querySelector(".xve-overlay")?.remove();
            node._xveWorkbench = createWorkbench(node);
            document.body.appendChild(node._xveWorkbench);
        };
        node.addWidget("button", "打开视频编辑工作台", null, open, { serialize: false });
        requestAnimationFrame(() => node.setSize?.([280, 110]));
    },
});
