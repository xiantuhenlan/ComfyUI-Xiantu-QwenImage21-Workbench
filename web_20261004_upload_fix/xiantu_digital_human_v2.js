import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

if (!document.querySelector("link[data-xiantu-dhv2-fresh-style]")) {
    const link = document.createElement("link");
    link.rel = "stylesheet";
link.href = new URL("./xiantu_digital_human_v2.css?v=20261007-70", import.meta.url).href;
    link.dataset.xiantuDhv2FreshStyle = "1";
    document.head.append(link);
}

const NODE = "XiantuDigitalHumanStudioV2";
const MODEL_PROFILES = Object.freeze([{id:"h3",label:"H3模型"}]);
const $ = (root, selector) => root.querySelector(selector);
const $$ = (root, selector) => [...root.querySelectorAll(selector)];
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
const icon = (name) => `<span class="dh2-icon dh2-icon-${name}" aria-hidden="true"></span>`;
const time = (seconds) => {
    const value = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(value / 60);
    const rest = value - minutes * 60;
    return `${String(minutes).padStart(2, "0")}:${rest.toFixed(2).padStart(5, "0")}`;
};
const endpoint = (state, suffix="") => `/xiantu/dhv2/projects/${encodeURIComponent(state.id)}${suffix}`;

async function jsonFetch(url, options={}) {
    const response = await api.fetchApi(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.error || `请求失败 (${response.status})`);
    return data;
}

function button(label, cls="", data="") {
    return `<button type="button" class="dh2-btn ${cls}" ${data}>${label}</button>`;
}

function shell() {
    const root = document.createElement("div");
    root.className = "dh2-overlay";
    root.innerHTML = `
      <main class="dh2-app" role="dialog" aria-modal="true" aria-label="MiniMax H3 数字人工作台">
        <header class="dh2-header">
          <div class="dh2-brand"><div class="dh2-logo"><img src="${new URL("./assets/xiantu-rabbit-logo.png", import.meta.url).href}" alt="闲兔"></div><div><h1><b>闲兔数字人工作台</b></h1><p>分镜、音轨、参考图与视频成品统一管理</p></div></div>
          <nav class="dh2-model-profiles" aria-label="数字人模型">${MODEL_PROFILES.map(profile=>`<button type="button" class="active" data-model-profile="${profile.id}"><span class="dh2-model-radio"><i></i></span><b>${profile.label}</b></button>`).join("")}</nav>
          <div class="dh2-head-actions">${button("×", "close", "data-close")}</div>
        </header>

        <section class="dh2-panel dh2-scenes">
          <div class="dh2-title">${icon("scenes")}<b>分镜管理</b><em data-scene-count>1 个</em></div>
          <div class="dh2-scene-body"><div class="dh2-scene-main"><div class="dh2-scene-list" data-scene-list></div><div class="dh2-generation-progress" data-generation-progress><div><i data-generation-bar></i></div><b data-generation-text>准备生成 · 0%</b></div></div>
            <div class="dh2-scene-actions">
              <div class="dh2-action-row">
                ${button(`${icon("copy")} 复制分镜`, "mini", "data-copy")}
                ${button(`${icon("trash")} 删除分镜`, "mini danger", "data-delete")}
                ${button(`${icon("clear")} 清空全部`, "mini", "data-clear")}
                ${button(`${icon("import")} 导入分镜`, "mini", "data-import")}
                ${button(`${icon("export")} 导出分镜`, "mini", "data-export")}
              </div>
              <div class="dh2-nav"><label class="dh2-current-label">当前分镜<select data-current></select></label>${button("← 上一分镜", "mini", "data-prev")}${button("下一分镜 →", "mini", "data-next")}${button("＋ 增加分镜", "mini primary", "data-new-right")}</div>
              <div class="dh2-generate-row"><label class="dh2-filename-prefix"><span>保存文件名</span><input type="text" maxlength="80" placeholder="留空按分镜名；例：天华 或 /西游记/天华" title="命名规则与 V3 导演台一致；输出目录会自动分到数字人/放大前和数字人/放大后" data-filename-prefix></label>${button("▶ 开始生成", "generate", "data-generate")}</div>
            </div>
          </div>
        </section>

        <section class="dh2-panel dh2-settings">
          <div class="dh2-title">${icon("settings")}<b>基础设置</b></div>
          <label>${icon("screen")}<span>宽高比</span><select data-setting="aspect"><option>1:1（方形）</option><option>2:3（竖幅照片）</option><option>3:2（照片）</option><option>3:4（竖幅标准）</option><option>4:3（标准）</option><option>9:16（竖幅宽屏）</option><option selected>16:9（宽屏）</option><option>21:9（超宽屏）</option></select></label>
          <label>${icon("pixels")}<span>分辨率</span><select data-setting="megapixels"><option value="0.1">0.1</option><option value="0.2">0.2</option><option value="0.3">0.3</option><option value="0.4">0.4</option><option value="0.5">0.5</option><option value="0.6" selected>0.6</option><option value="0.7">0.7</option><option value="0.8">0.8</option><option value="0.9">0.9</option><option value="1.0">1.0</option><option value="1.1">1.1</option><option value="1.2">1.2</option><option value="1.3">1.3</option><option value="1.4">1.4</option><option value="1.5">1.5</option><option value="1.6">1.6</option><option value="1.7">1.7</option><option value="1.8">1.8</option><option value="1.9">1.9</option><option value="2.0">2.0</option></select></label>
          <label>${icon("multiple")}<span>生成倍数</span><select data-setting="multiple"><option>32</option><option>16</option><option>64</option></select></label>
          <label>${icon("multiple")}<span>帧率</span><select data-fps><option>24</option><option>25</option><option>30</option></select></label>
          <label>${icon("spark")}<span>技能选择</span><select data-setting="skill"><option value="auto">自动选择</option><option value="h3-prompt-writing">H3 通用提示词</option><option value="3d-animation-short-generator">3D 动画短片</option><option value="brand-promo-video-generator">品牌宣传视频</option><option value="co-op-game-intro-generator">合作游戏介绍</option><option value="handdrawn-live-video-generator">手绘实拍视频</option><option value="minimalist-product-ad-generator">极简产品广告</option><option value="music-video-subtitle-generator">音乐视频字幕</option><option value="paper-collage-explainer-generator">纸张拼贴解说</option><option value="papercraft-stop-motion-explainer">纸艺定格解说</option></select></label>
          <label>${icon("avatar")}<span>表演模式</span><select data-setting="performance_mode"><option value="singing">人物演唱</option><option value="speaking">数字人口播</option></select></label>
        </section>

        <section class="dh2-panel dh2-audio">
          <div class="dh2-audio-tools">
            <div class="dh2-title">${icon("audio")}<b>音频编辑</b></div>
            ${button(`${icon("upload")} 上传音频`, "primary", "data-audio-upload")}
            ${button(`${icon("replace")} 替换音频`, "mini", "data-audio-replace")}
            ${button(`${icon("cut")} 在游标处切分`, "mini", "data-crop")}
            ${button(`${icon("remove")} 删除切点`, "mini danger-soft", "data-remove")}
            ${button(`${icon("clean")} 清除选择`, "mini", "data-deselect")}
            ${button(`${icon("mute")} 静音片段`, "mini mute", "data-mute")}
            ${button("全曲", "mini", "data-full")}${button("− 缩小", "mini", "data-zoom-out-2")}${button("＋ 放大", "mini", "data-zoom-in-2")}${button("当前段", "mini", "data-current-window")}${button("切点附近", "mini", "data-cut-window")}
            <span class="dh2-tool-spacer"></span>
            <label class="dh2-zoom">缩放<input type="range" min="1" max="8" step="0.25" value="1" data-zoom><b data-zoom-text>1×</b></label>
            ${button(`${icon("marker")} 显示标记`, "mini", "data-marker")}
          </div>
          <div class="dh2-track-strip" data-track-strip></div>
          <div class="dh2-wave-wrap" data-wave-wrap><div class="dh2-wave-stage" data-wave-stage>
            <div class="dh2-track-tag" data-track-tag>A1 音频</div>
            <canvas class="dh2-wave" data-wave tabindex="0"></canvas>
            <div class="dh2-wave-empty" data-wave-empty>上传音频后在这里显示完整音轨</div>
            <div class="dh2-wave-line dh2-hover-line" data-hover-line><span></span></div>
            <div class="dh2-wave-line dh2-playhead-line" data-playhead-line></div>
            <div data-cut-handles></div>
          </div></div>
          <div class="dh2-player-row">
            <div class="dh2-range-card"><i></i><span>当前分镜音频区间</span><strong data-range>0.00 s – 0.00 s</strong><small data-range-duration>时长 0.00 秒</small></div>
            <button class="dh2-play" data-play>▶</button><span data-player-time>00:00 / 00:00</span>
            <input class="dh2-seek" type="range" min="0" max="1" step="0.001" value="0" data-seek>
            <span class="dh2-speaker">◖))</span><input class="dh2-volume" type="range" min="0" max="1" step="0.01" value="1" data-volume><b>100</b>
          </div>
          <audio data-audio></audio><input hidden type="file" accept="audio/*" multiple data-audio-file>
        </section>

        <div class="dh2-lower">
          <section class="dh2-panel dh2-refs">
            <div class="dh2-ref-tools">${button("当前参考图", "mini primary", "data-ref-current")}${button("资产库", "mini", "data-ref-library")}</div>
            <div class="dh2-drop" data-ref-drop>${icon("picture")}<b>点击上传当前分镜参考图</b><span>支持 JPG / PNG / WEBP</span><small>建议 1280 × 720 以上，最多 9 张</small><div class="dh2-thumbs" data-thumbs></div></div>
            <label class="dh2-ref-size">参考图尺寸<select data-ref-size><option value="max">最大</option><option value="match">匹配</option></select></label>
            <input hidden type="file" accept="image/png,image/jpeg,image/webp" multiple data-ref-file>
            <input hidden type="file" accept="image/png,image/jpeg,image/webp" multiple data-asset-files>
          </section>
          <section class="dh2-panel dh2-prompt dh2-prompt-visible original">
            <div class="dh2-prompt-head"><div class="dh2-title">${icon("pen")}<b data-prompt-title>提示词</b><nav class="dh2-prompt-tabs"><button type="button" class="active" data-prompt-tab="original">提示词</button><button type="button" data-prompt-tab="optimized">优化后</button></nav></div><div class="dh2-prompt-actions"><label class="dh2-auto-optimize"><input type="checkbox" data-auto-optimize> 自动优化</label>${button("⚙ 优化设置","mini","data-opt-open")}<button type="button" data-clear-prompt>清空</button></div></div>
            <div class="dh2-prompt-editor" contenteditable="true" data-original data-placeholder="输入当前数字人的动作、表情、说话状态、镜头和环境要求；输入 @ 可插入参考图..."></div>
            <div class="dh2-mention-menu" data-mention-menu hidden></div><small>字数: <b data-original-count>0</b></small>
          </section>
          <section class="dh2-panel dh2-video-preview"><div class="dh2-title">${icon("picture")}<b>生成后的视频</b><em data-preview-title>未选择</em></div><div class="dh2-video-stage"><video controls playsinline data-result-video></video><div data-result-empty>生成完成后在这里预览视频</div></div></section>
          <section class="dh2-panel dh2-video-list-panel"><div class="dh2-result-head"><div class="dh2-title">${icon("more")}<b>生成列表</b><em data-result-count>0 个</em></div><div class="dh2-result-actions"><label><input type="checkbox" data-result-all> 全选</label>${button("删除选中", "mini danger", "data-result-delete")}${button("输出目录", "mini", "data-result-folder")}${button("合并输出", "mini primary", "data-result-merge")}</div></div><nav class="dh2-result-tabs"><button type="button" data-result-tab="before">放大前</button><button type="button" class="active" data-result-tab="after">放大后</button><button type="button" data-result-tab="merged">合并成片</button></nav><div class="dh2-video-list" data-result-list></div></section>
        </div>
        <footer class="dh2-footer"><span data-summary>ⓘ 当前分镜：01 - 分镜 01　 音频时长：0.00 秒　 画幅：16:9　 尺寸：576 × 1024　 倍数：32</span><strong>● 准备就绪 · 请编辑分镜素材，然后连接后端工作流生成视频</strong></footer>
        <div class="dh2-asset-backdrop" data-asset-dialog hidden><section class="dh2-asset-dialog" role="dialog" aria-modal="true"><header><div class="dh2-title">${icon("picture")}<b>资产库</b><em data-asset-folder-name>尚未添加图片</em></div>${button("×","close","data-asset-close")}</header><div class="dh2-asset-actions">${button("批量上传图片","primary","data-asset-files-pick")}${button("全部选择","mini","data-asset-select-all")}${button("全部取消","mini","data-asset-select-none")}${button("删除选择","mini danger","data-asset-delete")}<span>可直接拖入图片；勾选后应用到当前分镜</span></div><nav class="dh2-asset-tabs"><button type="button" class="active" data-asset-category="all">全部资产</button><button type="button" data-asset-category="character">角色资产</button><button type="button" data-asset-category="scene">场景资产</button><button type="button" data-asset-category="prop">道具资产</button><button type="button" data-asset-category="other">其他资产</button></nav><div class="dh2-asset-grid" data-asset-grid></div><div class="dh2-asset-empty" data-asset-empty>点击“批量上传图片”或直接拖入图片添加素材</div><footer>${button("取消","mini","data-asset-close")}${button("应用选中","primary","data-asset-apply")}</footer></section></div>
        <div class="dh2-opt-backdrop" data-opt-dialog hidden><section class="dh2-opt-dialog" role="dialog" aria-modal="true"><header><div class="dh2-title">${icon("spark")}<b>Qwen H3 优化设置</b></div>${button("×","close","data-opt-close")}</header><div class="dh2-opt-grid">
          <label><span>语言模型</span><input data-opt-setting="llm_model" value="Qwen3.8-27B-Q4_K_M.gguf"></label>
          <label><span>视觉模型</span><input data-opt-setting="vision_model" value="mmproj-F16.gguf"></label>
          <label><span>推理强度</span><select data-opt-setting="reasoning_effort"><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
          <label><span>最大 Token</span><input type="number" min="256" max="32768" step="256" data-opt-setting="max_tokens" value="8192"></label>
          <label><span>视频采样帧/秒</span><input type="number" min="1" max="16" step="1" data-opt-setting="video_sample_frames_per_sec" value="2"></label>
          <label><span>随机种子</span><input type="number" min="0" step="1" data-opt-setting="seed" value="0"></label>
          <label class="check"><input type="checkbox" data-opt-setting="think_mode"><span>思考模式</span></label>
          <label class="check"><input type="checkbox" data-opt-setting="force_unload_model" checked><span>生成后卸载模型</span></label>
        </div><footer>${button("完成","primary","data-opt-close")}</footer></section></div>
      </main>`;
    return root;
}

function studio(node) {
    const root = shell();
    const audio = $(root, "[data-audio]");
    const canvas = $(root, "[data-wave]");
    const context = canvas.getContext("2d");
    const waveWrap = $(root, "[data-wave-wrap]");
    const waveStage = $(root, "[data-wave-stage]");
    const playheadLine = $(root, "[data-playhead-line]");
    const hoverLine = $(root, "[data-hover-line]");
    const promptEditor = $(root, "[data-original]");
    let state = null, decoded = null, zoom = 1, showMarkers = true, saving = 0, playFrame = 0, zoomFrame = 0, audioSeekToken = 0, audioSeeking = false;
    let pinnedTime = 0, selectedCutIndex = -1, promptRange = null, promptView = "original", resultView = "after", previewResultId = "", generationActive = false, generationPercent = 0, generationResetTimer = 0, generationPulseTimer = 0, generationOwnerToken = "";
    let assetMode = false, assetFiles = [], assetCategory = "all", assetTargetSegmentIndex = 0, pendingRefSegmentIndex = 0;
    const refFields = {current:"refs"};
    const refLabels = {current:"当前分镜参考图"};
    const projectWidget = node.widgets?.find(w => w.name === "project_id");
    const segmentWidget = node.widgets?.find(w => w.name === "segment_index");
    const generateButton = $(root,"[data-generate]");
    const setGenerationState = (phase, percent=generationPercent, message="") => {
        clearTimeout(generationResetTimer);
        if(phase==="success"||phase==="error"||phase==="idle"){clearInterval(generationPulseTimer);generationPulseTimer=0;}
        generationPercent=Math.max(0,Math.min(100,Number(percent)||0));
        const bar=$(root,"[data-generation-bar]"),label=$(root,"[data-generation-text]");
        bar.style.width=`${generationPercent}%`;
        label.textContent=message||`${phase==="running"?"正在生成":phase==="submitting"?"正在提交":phase==="success"?"生成完成":phase==="error"?"生成失败":"准备生成"} · ${Math.round(generationPercent)}%`;
        if(phase==="submitting"){generationActive=true;generateButton.disabled=true;generateButton.textContent="⏳ 正在提交…";}
        else if(phase==="running"){generationActive=true;generateButton.disabled=true;generateButton.textContent=`■ 生成中 ${Math.round(generationPercent)}%`;}
        else if(phase==="success"){generationActive=false;if(globalThis.__xiantuDh2BatchOwner===generationOwnerToken)globalThis.__xiantuDh2BatchOwner="";generateButton.disabled=false;generateButton.textContent="✓ 生成完成（可再次生成）";}
        else if(phase==="error"){generationActive=false;if(globalThis.__xiantuDh2BatchOwner===generationOwnerToken)globalThis.__xiantuDh2BatchOwner="";generateButton.disabled=false;generateButton.textContent="⚠ 生成失败（点击重试）";}
        else{generationActive=false;generateButton.disabled=false;generateButton.textContent="▶ 开始生成";}
    };

    const selected = () => state?.segments?.[Math.max(0, Math.min(state.selected_segment || 0, state.segments.length - 1))];
    const audioTracks = () => state?.audio_tracks || [];
    const selectedAudioTrack = () => audioTracks()[Math.max(0, Math.min(Number(state?.selected_audio_track || 0), audioTracks().length - 1))];
    const normalizeAudioTracks = () => {
        if(!state)return;
        if(!Array.isArray(state.audio_tracks))state.audio_tracks=[];
        if(!state.audio_tracks.length&&state.audio?.path)state.audio_tracks=[{...state.audio,id:state.audio.id||crypto.randomUUID().replaceAll("-","").slice(0,12),duration:Number(state.duration||0),sample_rate:Number(state.sample_rate||0),offset:0,volume:1,muted:false}];
        state.audio_tracks.forEach((track,index)=>{track.id ||= crypto.randomUUID().replaceAll("-","").slice(0,12);track.label=`A${index+1}`;track.offset=Number(track.offset||0);track.volume=Number.isFinite(Number(track.volume))?Number(track.volume):1;track.muted=!!track.muted;});
        state.selected_audio_track=Math.max(0,Math.min(Number(state.selected_audio_track||0),Math.max(0,state.audio_tracks.length-1)));
        state.audio=selectedAudioTrack()||null;
    };
    const normalizeSegments = () => {
        state?.segments?.forEach((segment,index)=>segment.name=`分镜 ${String(index+1).padStart(2,"0")}`);
        const last=state?.segments?.[state.segments.length-1],duration=Number(state?.duration||0);
        if(last&&duration>Number(last.start))last.end=duration;
    };
    const media = path => endpoint(state, `/media/${String(path).split("/").map(encodeURIComponent).join("/")}`);
    const loadSelectedAudioTrack = async () => {
        normalizeAudioTracks();
        decoded=null;audio.pause();audio.removeAttribute("src");audio.load();
        if(!audioTracks().length){drawWave();return;}
        const source=`${endpoint(state,"/audio/mix")}?t=${Date.now()}`;audio.src=source;audio.load();
        try{decoded=await new AudioContext().decodeAudioData(await (await fetch(source,{cache:"no-store"})).arrayBuffer());}catch(error){notify(`音轨读取失败：${error.message}`,true);}
        drawWave();
    };
    const refsFor = () => selected()?.refs || [];
    const promptAssets = () => Object.keys(refFields).flatMap(kind => refsFor(kind));
    const makePromptImage = (token, record) => {
        const chip=document.createElement("span");chip.className="dh2-inline-image";chip.contentEditable="false";chip.dataset.token=token;chip.title=`${token} · ${record?.name||"参考图"}`;
        if(record){const image=document.createElement("img");image.src=media(record.path);image.alt="";image.draggable=false;chip.appendChild(image);}
        const label=document.createElement("b");label.textContent=token;chip.appendChild(label);return chip;
    };
    const renderPrompt = () => {
        const segment=selected(), field=promptView==="optimized"?"optimized_prompt":"original_prompt", prompt=String(segment?.[field]||""), assets=promptAssets(), fragment=document.createDocumentFragment();let cursor=0;
        promptEditor.dataset.promptMode=promptView;
        $(root,"[data-prompt-title]").textContent="提示词";
        $$(root,"[data-prompt-tab]").forEach(tab=>tab.classList.toggle("active",tab.dataset.promptTab===promptView));
        promptEditor.dataset.placeholder=promptView==="optimized"?"生成后在这里显示优化后的提示词，也可以手动编辑...":"输入当前数字人的动作、表情、说话状态、镜头和环境要求；输入 @ 可插入参考图...";
        for(const match of prompt.matchAll(/<(?:image\s*|picture\s*)(\d+)>/gi)){const offset=Number(match.index||0),token=`<image${Number(match[1])}>`;if(offset>cursor)fragment.appendChild(document.createTextNode(prompt.slice(cursor,offset)));fragment.appendChild(makePromptImage(token,assets[Number(match[1])-1]));cursor=offset+match[0].length;}
        if(cursor<prompt.length)fragment.appendChild(document.createTextNode(prompt.slice(cursor)));promptEditor.replaceChildren(fragment);promptRange=null;
    };
    const promptText = () => [...promptEditor.childNodes].map(node => node.nodeType===Node.TEXT_NODE ? node.textContent : (node.dataset?.token || node.textContent || "")).join("").replace(/\u00a0/g," ");
    const rememberPromptRange = () => {const selection=window.getSelection();if(selection?.rangeCount&&promptEditor.contains(selection.anchorNode))promptRange=selection.getRangeAt(0).cloneRange();};
    const insertPromptImage = (index) => {
        const assets=promptAssets(), record=assets[index];if(!record)return;const token=`<image${index+1}>`;promptEditor.focus();const selection=window.getSelection();let range=promptRange&&promptEditor.contains(promptRange.commonAncestorContainer)?promptRange.cloneRange():document.createRange();if(!promptRange||!promptEditor.contains(range.commonAncestorContainer)){range.selectNodeContents(promptEditor);range.collapse(false);}if(range.collapsed&&range.startContainer?.nodeType===Node.TEXT_NODE&&range.startOffset>0&&range.startContainer.textContent[range.startOffset-1]==="@")range.setStart(range.startContainer,range.startOffset-1);range.deleteContents();const before=document.createTextNode(promptEditor.textContent?" ":"");const chip=makePromptImage(token,record);const after=document.createTextNode(" ");const fragment=document.createDocumentFragment();fragment.append(before,chip,after);range.insertNode(fragment);range.setStartAfter(after);range.collapse(true);selection.removeAllRanges();selection.addRange(range);promptRange=range.cloneRange();const field=promptEditor.dataset.promptMode==="optimized"?"optimized_prompt":"original_prompt";selected()[field]=promptText();$(root,"[data-original-count]").textContent=selected()[field].length;$(root,"[data-mention-menu]").hidden=true;save();notify(`已插入 ${token} · ${record.name}`);
    };
    const showMentionMenu = () => {const menu=$(root,"[data-mention-menu]"),assets=promptAssets();if(!assets.length){menu.hidden=true;return;}menu.innerHTML=assets.map((record,index)=>`<button type="button" data-mention="${index}"><img src="${media(record.path)}"><span><b>&lt;image${index+1}&gt;</b>${esc(record.name)}</span></button>`).join("");menu.hidden=false;$$ (menu,"[data-mention]").forEach(button=>button.onclick=()=>insertPromptImage(Number(button.dataset.mention)));};
    const notify = (message, bad=false) => {
        const footer = $(root, ".dh2-footer strong");
        footer.textContent = `${bad ? "●" : "●"} ${message}`;
        footer.classList.toggle("bad", bad);
    };
    const syncWidgets = () => {
        if (projectWidget) projectWidget.value = state?.id || "";
        if (segmentWidget) segmentWidget.value = state?.selected_segment || 0;
        node.setDirtyCanvas?.(true, true);
    };
    const save = async () => {
        if (!state) return;
        const ticket = ++saving;
        try {
            const data = await jsonFetch(endpoint(state), {method:"PUT", headers:{"Content-Type":"application/json"}, body:JSON.stringify(state)});
            if (ticket === saving) state = data.project;
            syncWidgets();
        } catch (error) { notify(error.message, true); }
    };
    const aspectRatio = aspect => ({"1:1":1,"2:3":2/3,"3:2":3/2,"3:4":3/4,"4:3":4/3,"9:16":9/16,"16:9":16/9,"21:9":21/9})[String(aspect||"").split(/[（ (]/)[0]] || 16/9;
    const resolutionFor = (megapixels, aspect=state.settings.aspect, multiple=Number(state.settings.multiple)||32) => {
        const pixels=Math.max(.1,Number(megapixels)||.6)*1024*1024,ratio=aspectRatio(aspect);
        const width=Math.max(multiple,Math.round(Math.sqrt(pixels*ratio)/multiple)*multiple);
        const height=Math.max(multiple,Math.round(Math.sqrt(pixels/ratio)/multiple)*multiple);
        return `${width} × ${height}`;
    };
    const resolutionChoices = () => [...new Set(Array.from({length:20},(_,index)=>resolutionFor(((index+1)/10).toFixed(1))))];
    const calculate = (fromResolution=false) => {
        const settings = state.settings;
        const multiple = Number(settings.multiple);
        if(!fromResolution)settings.resolution=resolutionFor(settings.megapixels,settings.aspect,multiple);
        const match = String(settings.resolution || "").match(/(\d+)\s*[x×*]\s*(\d+)/i);
        if (!match) return false;
        settings.width = Math.max(multiple, Math.round(Number(match[1]) / multiple) * multiple);
        settings.height = Math.max(multiple, Math.round(Number(match[2]) / multiple) * multiple);
        settings.resolution = `${settings.width} × ${settings.height}`;
        return true;
    };
    function renderScenes() {
        const list = $(root, "[data-scene-list]");
        list.innerHTML = state.segments.map((segment, index) => `<div class="dh2-scene ${index === state.selected_segment ? "active" : ""}" data-scene="${index}"><input type="checkbox" data-scene-generate="${index}" title="勾选后生成此分镜" ${segment.generate_selected!==false?"checked":""}><button type="button" data-scene-select="${index}"><b>${String(index+1).padStart(2,"0")} - ${esc(segment.name)}</b><small>${time(segment.start)} – ${time(segment.end)}</small></button></div>`).join("");
        $(root, "[data-scene-count]").textContent = `${state.segments.length} 个`;
        const current = $(root, "[data-current]");
        current.innerHTML = state.segments.map((s,i)=>`<option value="${i}">${String(i+1).padStart(2,"0")} - ${esc(s.name)} (${time(s.start)} – ${time(s.end)})</option>`).join("");
        current.value = String(state.selected_segment);
        $$ (list, "[data-scene-select]").forEach(el => el.onclick = () => { state.selected_segment=Number(el.dataset.sceneSelect); syncWidgets(); render(); });
        $$ (list, "[data-scene-generate]").forEach(el => el.onchange = async () => { state.segments[Number(el.dataset.sceneGenerate)].generate_selected=el.checked;await save(); });
    }
    function renderAudioTracks() {
        normalizeAudioTracks();
        const host=$(root,"[data-track-strip]");
        const total=Math.max(.01,Number(state.duration||0));
        host.innerHTML=audioTracks().map((track,index)=>`<div class="dh2-track-chip ${index===state.selected_audio_track?"active":""} ${track.muted?"muted":""}" style="flex:${Math.max(.05,Number(track.duration||0))/total} 1 0"><button type="button" data-track-select="${index}"><b>${index+1}</b><span>${esc(track.name||`音频片段 ${index+1}`)}</span><small>${Number(track.duration||0).toFixed(2)}s</small></button><button type="button" title="${track.muted?"取消静音":"静音片段"}" data-track-mute="${index}">${track.muted?"🔇":"🔊"}</button><button type="button" title="删除片段" data-track-delete="${index}">×</button></div>`).join("");
        $(root,"[data-track-tag]").textContent="音频";
        $$ (host,"[data-track-select]").forEach(button=>button.onclick=async()=>{state.selected_audio_track=Number(button.dataset.trackSelect);normalizeAudioTracks();pinnedTime=Number(selectedAudioTrack()?.offset||0);await save();renderAudioTracks();positionWaveLine(playheadLine,pinnedTime);});
        $$ (host,"[data-track-mute]").forEach(button=>button.onclick=async()=>{const track=audioTracks()[Number(button.dataset.trackMute)];track.muted=!track.muted;await save();await loadSelectedAudioTrack();renderAudioTracks();notify(track.muted?`片段 ${Number(button.dataset.trackMute)+1} 已静音`:`片段 ${Number(button.dataset.trackMute)+1} 已取消静音`);});
        $$ (host,"[data-track-delete]").forEach(button=>button.onclick=async()=>{const track=audioTracks()[Number(button.dataset.trackDelete)];try{const data=await jsonFetch(endpoint(state,"/audio/remove"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({track_id:track.id})});state=data.project;normalizeAudioTracks();await loadSelectedAudioTrack();render();notify("音轨已删除");}catch(error){notify(error.message,true);}});
    }
    function renderThumbs() {
        const segment = selected();
        segment.refs ||= [];
        const records = refsFor();
        const box = $(root, "[data-thumbs]");
        const all=promptAssets();
        box.innerHTML = records.map((ref,index)=>{const tokenIndex=all.indexOf(ref)+1;return `<figure data-insert-ref="${index}" title="点击插入 <image${tokenIndex}>"><img src="${media(ref.path)}"><figcaption><b>&lt;image${tokenIndex}&gt;</b> ${esc(ref.name)}</figcaption><button data-remove-ref="${index}">×</button></figure>`;}).join("");
        const drop=$(root,"[data-ref-drop]");drop.classList.toggle("has-images",!!records.length);drop.querySelector(":scope > b").textContent=`点击上传${refLabels.current}`;
        $$ (box,"[data-insert-ref]").forEach(card=>card.onclick=event=>{if(event.target.closest("button"))return;const record=records[Number(card.dataset.insertRef)];insertPromptImage(all.indexOf(record));});
        $$ (box, "[data-remove-ref]").forEach(btn => btn.onclick = async event => { event.stopPropagation(); records.splice(Number(btn.dataset.removeRef),1); await save(); renderThumbs(); renderPrompt(); });
    }
    function renderAssetLibrary() {
        const grid=$(root,"[data-asset-grid]"), empty=$(root,"[data-asset-empty]");
        const visible=assetFiles.map((item,index)=>({item,index})).filter(({item})=>assetCategory==="all"||(item.category||"other")===assetCategory);
        grid.innerHTML=visible.map(({item,index})=>`<label class="dh2-asset-item ${item.selected?"selected":""}" data-asset-index="${index}"><img src="${media(item.path)}" alt=""><span>${esc(item.name)}</span><input type="checkbox" ${item.selected?"checked":""}><select data-asset-move="${index}" title="选择资产分类"><option value="character" ${(item.category||"other")==="character"?"selected":""}>角色资产</option><option value="scene" ${(item.category||"other")==="scene"?"selected":""}>场景资产</option><option value="prop" ${(item.category||"other")==="prop"?"selected":""}>道具资产</option><option value="other" ${(item.category||"other")==="other"?"selected":""}>其他资产</option></select></label>`).join("");
        empty.hidden=!!visible.length;
        $$(root,"[data-asset-category]").forEach(tab=>tab.classList.toggle("active",tab.dataset.assetCategory===assetCategory));
        $(root,"[data-asset-folder-name]").textContent=assetFiles.length?`项目资产 · ${assetFiles.length} 张`:"尚未添加图片";
        $$ (grid,"[data-asset-index]").forEach(card=>card.onchange=()=>{const item=assetFiles[Number(card.dataset.assetIndex)];item.selected=card.querySelector("input").checked;card.classList.toggle("selected",item.selected);});
        $$ (grid,"[data-asset-move]").forEach(select=>select.onchange=async event=>{event.stopPropagation();const item=assetFiles[Number(select.dataset.assetMove)];item.category=select.value;const stored=(state.assets||[]).find(asset=>String(asset.id)===String(item.id));if(stored)stored.category=select.value;await save();const label=select.options[select.selectedIndex].text;renderAssetLibrary();notify(`已移动到${label}`);});
    }
    const syncAssetFilesFromState = (selectedIds=new Set()) => {
        assetFiles=(state.assets||[]).map(item=>({...item,selected:selectedIds.has(String(item.id))}));
    };
    const imageFiles = files => [...(files||[])].filter(file=>String(file.type||"").startsWith("image/")||/\.(jpe?g|png|webp)$/i.test(file.name||""));
    const useAssetFiles = async files => {
        const images=imageFiles(files);if(!images.length)return notify("请拖入 JPG、PNG 或 WEBP 图片",true);
        notify(`正在上传 ${images.length} 张资产图片…`);
        const form=new FormData();form.append("category",assetCategory==="all"?"other":assetCategory);images.forEach((file,index)=>form.append(`file_${index}`,file,file.name));
        try{const data=await jsonFetch(endpoint(state,"/assets"),{method:"POST",body:form});state=data.project;const addedIds=new Set((data.added||[]).map(item=>String(item.id)));syncAssetFilesFromState(addedIds);assetMode=true;renderAssetLibrary();notify(`已保存 ${data.added?.length||0} 张图片到项目资产库`);}catch(error){notify(error.message,true);}
    };
    const resultUrl = record => `/view?filename=${encodeURIComponent(record.filename)}&type=${encodeURIComponent(record.type||"output")}&subfolder=${encodeURIComponent(record.subfolder||"")}&t=${encodeURIComponent(record.created||Date.now())}`;
    const resultKind = record => {const path=`${record?.subfolder||""}/${record?.filename||""}`.replaceAll("\\","/");if(path.includes("/合并成品/")||String(record?.segment_id)==="merged")return "merged";if(path.includes("/放大前/")||/^H3_Director_Final/i.test(String(record?.filename||"")))return "before";return "after";};
    function renderResults() {
        state.results ||= [];
        const list=$(root,"[data-result-list]"), player=$(root,"[data-result-video]"), empty=$(root,"[data-result-empty]");
        const visible=state.results.map((record,index)=>({record,index})).filter(({record})=>resultKind(record)===resultView);
        $(root,"[data-result-count]").textContent=`${visible.length} 个`;
        $$(root,"[data-result-tab]").forEach(tab=>tab.classList.toggle("active",tab.dataset.resultTab===resultView));
        list.innerHTML=visible.length?visible.map(({record,index})=>`<article class="dh2-result-row ${record.id===previewResultId?"active":""}" data-result-row="${index}"><input type="checkbox" data-result-check="${index}" ${record.selected?"checked":""}><button type="button" data-result-preview="${index}"><b>${esc(record.segment_name||`分镜 ${Number(record.segment_index||0)+1}`)}</b><span>${Number(record.duration||0).toFixed(2)} 秒 · ${esc(record.filename||"视频")}</span></button></article>`).join(""):`<div class="dh2-result-list-empty">${resultView==="merged"?"暂无合并成片":"暂无生成视频；执行工作流后自动加入列表"}</div>`;
        $$ (list,"[data-result-check]").forEach(check=>check.onchange=async()=>{state.results[Number(check.dataset.resultCheck)].selected=check.checked;await save();renderResults();});
        $$ (list,"[data-result-preview]").forEach(button=>button.onclick=()=>{const record=state.results[Number(button.dataset.resultPreview)];previewResultId=record.id;player.dataset.resultId=record.id;player.src=resultUrl(record);player.hidden=false;empty.hidden=true;$(root,"[data-preview-title]").textContent=`${record.segment_name} · ${Number(record.duration||0).toFixed(2)} 秒`;player.onloadedmetadata=()=>{if(Number.isFinite(player.duration)&&player.duration>0&&Math.abs(Number(record.duration||0)-player.duration)>.01){record.duration=player.duration;save();renderResults();}};renderResults();});
        const current=state.results.find(record=>record.id===previewResultId&&resultKind(record)===resultView);
        if(current&&player.dataset.resultId!==current.id){player.dataset.resultId=current.id;player.src=resultUrl(current);player.hidden=false;empty.hidden=true;$(root,"[data-preview-title]").textContent=`${current.segment_name} · ${Number(current.duration||0).toFixed(2)} 秒`;}else if(!current){delete player.dataset.resultId;player.removeAttribute("src");player.load();player.hidden=true;empty.hidden=false;$(root,"[data-preview-title]").textContent="未选择";}
        $(root,"[data-result-all]").checked=!!visible.length&&visible.every(({record})=>record.selected);
    }
    const collectVideoItems = (value, output=[]) => {
        if(Array.isArray(value)){for(const item of value)collectVideoItems(item,output);return output;}
        if(!value||typeof value!=="object")return output;
        if(value.filename&&/\.(mp4|webm|mov|mkv|gif)$/i.test(String(value.filename))){output.push(value);return output;}
        for(const item of Object.values(value))collectVideoItems(item,output);
        return output;
    };
    const appendVideoResults = async (candidates, resultSegmentIndex=state.selected_segment) => {
        if(!candidates.length)return 0;
        try{const latest=await jsonFetch(endpoint(state));if(latest?.project){state=latest.project;normalizeAudioTracks();normalizeSegments();}}catch{}
        state.results ||= [];
        const segment=state.segments[resultSegmentIndex]||selected();let added=0,lastId="";
        for(const item of candidates){const fingerprint=`${item.type||"output"}/${item.subfolder||""}/${item.filename}`;if(state.results.some(record=>record.fingerprint===fingerprint))continue;const id=crypto.randomUUID().replaceAll("-","").slice(0,12);state.results.push({id,fingerprint,filename:item.filename,subfolder:item.subfolder||"",type:item.type||"output",format:item.format||"video/mp4",segment_id:segment.id,segment_index:resultSegmentIndex,segment_name:`${String(resultSegmentIndex+1).padStart(2,"0")} - ${segment.name}`,duration:Math.max(0,Number(segment.end||0)-Number(segment.start||0)),created:Date.now(),selected:false});lastId=id;added++;}
        if(added){previewResultId=lastId;await save();renderResults();notify(`已加入 ${added} 个生成视频`);}
        return added;
    };
    const captureHistoryResults = async (promptId, segmentIndex) => {
        if(!promptId)return 0;
        try{for(let attempt=0;attempt<10;attempt++){if(attempt)await new Promise(resolve=>setTimeout(resolve,250));const response=await api.fetchApi(`/history/${encodeURIComponent(promptId)}`);if(!response.ok)continue;const history=await response.json(),entry=history?.[promptId]||Object.values(history||{})[0],items=collectVideoItems(entry?.outputs||{});if(items.length)return await appendVideoResults(items,segmentIndex);}notify("工作流已完成，但历史记录中没有找到视频文件",true);return 0;}catch(error){notify(`读取生成视频失败：${error.message}`,true);return 0;}
    };
    const captureResult = async ({detail}) => {
        if(!state)return;
        if(String(detail?.node)===String(node.id)){
            try{
                const data=await jsonFetch(endpoint(state));
                state=data.project;state.audio_cuts ||= [];state.results ||= [];
                normalizeAudioTracks();normalizeSegments();syncWidgets();renderScenes();
                if(state.settings?.auto_optimize&&selected().optimized_prompt)promptView="optimized";
                renderForm();
                if(state.settings?.auto_optimize&&selected().optimized_prompt)notify("提示词优化完成，已显示在“优化后”页");
            }catch(error){notify(`刷新优化提示词失败：${error.message}`,true);}
        }
        // Batch results are recorded once from the completed prompt history.
        // Per-node "executed" events can arrive late and must never guess the
        // segment from a counter that may already have advanced.
        if(generationActive)return;
        if(!detail?.output)return;
        const candidates=collectVideoItems(detail.output);
        const resultSegmentIndex=generationActive&&generationQueueIndices.length?generationQueueIndices[Math.min(generationCompleted,generationQueueIndices.length-1)]:state.selected_segment;
        await appendVideoResults(candidates,resultSegmentIndex);
    };
    let generationTotal=0,generationCompleted=0,generationQueueIndices=[],generationOriginalIndex=0,generationAdvancing=false,generationPromptId="";
    const completedPromptIds=new Set();
    const ownsGeneration=()=>generationActive&&generationOwnerToken&&globalThis.__xiantuDh2BatchOwner===generationOwnerToken;
    const activeSceneNumber=()=>Number(generationQueueIndices[Math.min(generationCompleted,generationQueueIndices.length-1)]??0)+1;
    const readComfyQueue=async()=>{const response=await api.fetchApi("/queue");if(!response.ok)throw new Error("无法读取 ComfyUI 队列");const data=await response.json();return [...(data.queue_running||[]),...(data.queue_pending||[])];};
    const queuePromptIds=items=>new Set(items.map(item=>String(item?.[1]||"")).filter(Boolean));
    const resolveQueuedPromptId=async(segmentIndex,beforeIds,directResult)=>{
        const direct=String(directResult?.prompt_id||directResult?.promptId||"");if(direct)return direct;
        for(let attempt=0;attempt<12;attempt++){
            if(attempt)await new Promise(resolve=>setTimeout(resolve,100));
            const items=await readComfyQueue();
            const matches=items.filter(item=>{const id=String(item?.[1]||"");const promptNode=item?.[2]?.[String(node.id)];return id&&!beforeIds.has(id)&&Number(promptNode?.inputs?.segment_index)===Number(segmentIndex);}).sort((a,b)=>Number(b?.[0]||0)-Number(a?.[0]||0));
            if(matches.length)return String(matches[0][1]);
        }
        return "";
    };
    const restoreGenerationSelection=async()=>{state.selected_segment=Math.max(0,Math.min(generationOriginalIndex,state.segments.length-1));syncWidgets();await save();render();};
    const submitGenerationAt=async position=>{
        const segmentIndex=generationQueueIndices[position];
        if(!Number.isInteger(segmentIndex))throw new Error("批量队列中的分镜索引无效");
        state.selected_segment=segmentIndex;syncWidgets();await save();renderScenes();renderForm();
        // Save responses and delayed UI events are allowed to refresh state,
        // but the hidden Comfy widget must be locked to this exact queue item.
        if(segmentWidget)segmentWidget.value=segmentIndex;
        node.setDirtyCanvas?.(true,true);
        setGenerationState("submitting",0,`正在提交实际分镜 ${segmentIndex+1}（批次 ${position+1}/${generationTotal}）· 0%`);
        const beforeIds=queuePromptIds(await readComfyQueue());
        const queued=await app.queuePrompt(0,1);
        generationPromptId=await resolveQueuedPromptId(segmentIndex,beforeIds,queued);
        if(!generationPromptId)throw new Error(`分镜 ${segmentIndex+1} 提交后未返回 prompt_id，已停止批量推进`);
        setGenerationState("running",0,`实际分镜 ${segmentIndex+1}（批次 ${position+1}/${generationTotal}）· 等待采样 0%`);
    };
    const generationStarted = () => {if(ownsGeneration())setGenerationState("running",0,`实际分镜 ${activeSceneNumber()}（批次 ${Math.min(generationCompleted+1,generationTotal)}/${generationTotal}）· 等待采样 0%`);};
    const generationProgress = ({detail}) => {if(!ownsGeneration())return;const value=Number(detail?.value??0),maximum=Number(detail?.max??0),percent=maximum>0?Math.max(0,Math.min(100,value/maximum*100)):generationPercent;setGenerationState("running",percent,`实际分镜 ${activeSceneNumber()}（批次 ${Math.min(generationCompleted+1,generationTotal)}/${generationTotal}）· 采样 ${Math.round(percent)}%`);};
    const generationExecuting = ({detail}) => {if(!ownsGeneration())return;const executingNode=detail&&typeof detail==="object"&&"node" in detail?detail.node:detail;if(executingNode!==null)setGenerationState("running",generationPercent,`实际分镜 ${activeSceneNumber()}（批次 ${Math.min(generationCompleted+1,generationTotal)}/${generationTotal}）· ${generationPercent>0?`采样 ${Math.round(generationPercent)}%`:"准备采样 0%"}`);};
    const generationSucceeded = async({detail}) => {if(!ownsGeneration()||generationAdvancing)return;const promptId=String(detail?.prompt_id||"");if(!promptId||promptId!==generationPromptId||completedPromptIds.has(promptId))return;completedPromptIds.add(promptId);generationAdvancing=true;const finishedIndex=generationQueueIndices[Math.min(generationCompleted,generationQueueIndices.length-1)];try{await captureHistoryResults(promptId,finishedIndex);try{const data=await jsonFetch(endpoint(state));state=data.project;state.results||=[];normalizeAudioTracks();normalizeSegments();if(state.settings?.auto_optimize&&selected().optimized_prompt)promptView="optimized";renderForm();renderResults();}catch{}setGenerationState("running",100,`实际分镜 ${finishedIndex+1}（批次 ${generationCompleted+1}/${generationTotal}）· 采样 100%`);generationCompleted=Math.min(generationTotal,generationCompleted+1);if(generationCompleted>=generationTotal){setGenerationState("success",100,`全部 ${generationTotal} 个分镜生成完成 · 100%`);await restoreGenerationSelection();}else{await submitGenerationAt(generationCompleted);}}catch(error){setGenerationState("error",generationPercent,`提交下一个分镜失败：${error.message}`);await restoreGenerationSelection().catch(()=>{});}finally{generationAdvancing=false;}};
    const generationFailed = async({detail}) => {if(!ownsGeneration())return;const promptId=String(detail?.prompt_id||"");if(promptId&&generationPromptId&&promptId!==generationPromptId)return;setGenerationState("error",generationPercent,detail?.exception_message?`生成失败：${detail.exception_message}`:`实际分镜 ${activeSceneNumber()} 生成失败`);await restoreGenerationSelection().catch(()=>{});};
    function renderForm() {
        const segment = selected();
        const activeModel=String(state.settings.model_profile||"h3");
        $$(root,"[data-model-profile]").forEach(button=>button.classList.toggle("active",button.dataset.modelProfile===activeModel));
        $(root,"[data-range]").textContent = `${Number(segment.start).toFixed(2)} s – ${Number(segment.end).toFixed(2)} s`;
        $(root,"[data-range-duration]").textContent = `时长 ${Math.max(0,segment.end-segment.start).toFixed(2)} 秒`;
        renderPrompt();
        $(root,"[data-auto-optimize]").checked = !!state.settings.auto_optimize;
        $(root,"[data-original-count]").textContent = String(promptView==="optimized"?segment.optimized_prompt||"":segment.original_prompt||"").length;
        $$(root,"[data-opt-setting]").forEach(el=>{
            const key=el.dataset.optSetting;
            const fallback={llm_model:"Qwen3.8-27B-Q4_K_M.gguf",vision_model:"mmproj-F16.gguf",reasoning_effort:"medium",max_tokens:8192,video_sample_frames_per_sec:2,seed:0,think_mode:false,force_unload_model:true}[key];
            const value=state.settings[key] ?? fallback;
            if(el.type==="checkbox")el.checked=!!value;else el.value=String(value);
        });
        if(!Number.isFinite(Number(state.settings.megapixels)))state.settings.megapixels="0.6";
        $$ (root,"[data-setting]").forEach(el => el.value = String(state.settings[el.dataset.setting]));
        const megapixels=$(root,'[data-setting="megapixels"]');
        [...megapixels.options].forEach(option => {
            const value=Number(option.value).toFixed(1);
            option.value=value;
            option.textContent=`${value} MP · ${resolutionFor(value)}`;
        });
        megapixels.value=Number(state.settings.megapixels).toFixed(1);
        $(root,"[data-ref-size]").value = state.settings.reference_size || "max";
        $(root,"[data-fps]").value = String(state.settings.fps || 24);
        $(root,"[data-filename-prefix]").value = String(state.settings.filename_prefix || "");
        $(root,"[data-summary]").textContent = `ⓘ 当前分镜：${String(state.selected_segment+1).padStart(2,"0")} - ${segment.name}　 音频时长：${Number(state.duration||0).toFixed(2)} 秒　 画幅：${state.settings.aspect.split(" ")[0]}　 尺寸：${state.settings.width} × ${state.settings.height}　 倍数：${state.settings.multiple}`;
    }
    function drawWave() {
        const viewportWidth=Math.max(1,waveWrap.clientWidth);waveStage.style.width=`${Math.max(viewportWidth,Math.round(viewportWidth*zoom))}px`;waveWrap.classList.toggle("is-zoomed",zoom>1.001);
        const rect = canvas.getBoundingClientRect();
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, rect.width * ratio); canvas.height = Math.max(1, rect.height * ratio);
        context.setTransform(ratio,0,0,ratio,0,0);
        const w=rect.width,h=rect.height, timeline=28, waveH=h-timeline;
        context.clearRect(0,0,w,h); context.fillStyle="#061724"; context.fillRect(0,0,w,h);
        const duration = state?.duration || decoded?.duration || 0;
        if (!decoded || !duration) { renderCutHandles(); return; }
        const channel = decoded.getChannelData(0), sampleRate=Number(decoded.sampleRate||44100);
        context.fillStyle="#0d3a50"; context.fillRect(0,0,w,waveH);
        context.fillStyle="#1fc8d1";
        for(let x=0;x<w;x++) { let min=0,max=0;const start=Math.max(0,Math.floor(x/w*duration*sampleRate)),finish=Math.min(channel.length,Math.ceil((x+1)/w*duration*sampleRate));if(finish>start){min=1;max=-1;for(let j=start;j<finish;j++){const v=channel[j];min=Math.min(min,v);max=Math.max(max,v);}}const y1=(1+min)*waveH/2,y2=(1+max)*waveH/2;context.fillRect(x,y1,1,Math.max(1,y2-y1)); }
        audioTracks().forEach((track,index)=>{const x=Number(track.offset||0)/duration*w;context.strokeStyle=index===state.selected_audio_track?"#ffd34f":"#4aa8d1";context.lineWidth=index===state.selected_audio_track?2:1;context.beginPath();context.moveTo(x,0);context.lineTo(x,waveH);context.stroke();context.fillStyle="#dff5ff";context.font="10px Arial";context.textAlign="left";context.fillText(`${index+1} ${track.name||"音频片段"}`,Math.min(w-90,x+4),waveH-5);});
        const segment=selected(), left=(segment.start/duration)*w, right=(segment.end/duration)*w;
        context.fillStyle="rgba(6,224,158,.13)"; context.fillRect(left,0,Math.max(1,right-left),waveH);
        context.strokeStyle="#35e1bd"; context.lineWidth=2; context.beginPath(); context.moveTo(left,0);context.lineTo(left,h);context.moveTo(right,0);context.lineTo(right,h);context.stroke();
        context.fillStyle="#06121d";context.fillRect(0,waveH,w,timeline);context.strokeStyle="#2a536d";context.beginPath();context.moveTo(0,waveH+.5);context.lineTo(w,waveH+.5);context.stroke();
        context.font="12px Arial";context.fillStyle="#a8c1d0";context.textAlign="center";
        const visibleSeconds=duration/zoom,step=visibleSeconds>60?10:visibleSeconds>20?5:visibleSeconds>8?1:.5;for(let t=0;t<=duration+.0001;t+=step){const x=t/duration*w;context.fillRect(x,waveH,1,7);context.fillText(time(t),x,waveH+20);}
        if(showMarkers){ context.fillStyle="#16dca2";context.fillRect(left+3,3,Math.max(72,right-left-6),20);context.fillStyle="#dffef4";context.font="bold 12px Arial";context.fillText(`分镜 ${state.selected_segment+1}  ${time(segment.start)} – ${time(segment.end)}`,Math.min(w-70,left+Math.max(45,(right-left)/2)),17); }
        renderCutHandles();positionWaveLine(playheadLine,pinnedTime);
    }
    const pointerTime = event => {const rect=canvas.getBoundingClientRect();return Math.max(0,Math.min(state?.duration||0,(event.clientX-rect.left)/Math.max(1,rect.width)*(state?.duration||0)));};
    const positionWaveLine = (line,second) => {const duration=state?.duration||0;if(!duration)return;line.style.left=`${Math.max(0,Math.min(100,second/duration*100))}%`;const label=line.querySelector("span");if(label)label.textContent=time(second);};
    function renderCutHandles(){
        const host=$(root,"[data-cut-handles]");host.replaceChildren();
        const duration=state?.duration||0;if(!duration)return;
        const current=selected();
        const addBoundaryHandle=(kind,value)=>{
            const handle=document.createElement("div");
            handle.className=`dh2-boundary-handle ${kind}`;
            handle.style.left=`${Math.max(0,Math.min(100,value/duration*100))}%`;
            handle.innerHTML=`<span>${kind==="start"?"开始":"结束"} ${time(value)}</span>`;
            handle.title=kind==="start"?"拖动修改当前分镜开始时间":"拖动修改当前分镜结束时间";
            handle.onpointerdown=event=>{
                event.preventDefault();event.stopPropagation();
                const segmentIndex=state.selected_segment;
                const original=Number(state.segments[segmentIndex]?.[kind]||0);
                const linkedCut=(state.audio_cuts||[]).findIndex(c=>Math.abs(Number(c)-original)<.03);
                const move=moveEvent=>{
                    const segment=state.segments[segmentIndex];if(!segment)return;
                    const rect=waveStage.getBoundingClientRect();
                    let nextValue=Math.max(0,Math.min(duration,(moveEvent.clientX-rect.left)/Math.max(1,rect.width)*duration));
                    if(kind==="start"){
                        const previous=state.segments[segmentIndex-1];
                        nextValue=Math.min(Number(segment.end)-.05,Math.max(previous?Number(previous.start)+.05:0,nextValue));
                        segment.start=nextValue;if(previous)previous.end=nextValue;
                    }else{
                        const following=state.segments[segmentIndex+1];
                        if(following&&segmentIndex+1===state.segments.length-1)following.end=duration;
                        nextValue=Math.max(Number(segment.start)+.05,Math.min(following?Number(following.end)-.05:duration,nextValue));
                        segment.end=nextValue;if(following)following.start=nextValue;
                    }
                    if(linkedCut>=0)state.audio_cuts[linkedCut]=nextValue;
                    pinnedTime=nextValue;
                    renderScenes();renderForm();drawWave();
                };
                const up=async()=>{window.removeEventListener("pointermove",move);window.removeEventListener("pointerup",up);syncWidgets();await save();};
                window.addEventListener("pointermove",move);window.addEventListener("pointerup",up);
            };
            host.appendChild(handle);
        };
        addBoundaryHandle("start",Number(current.start)||0);
        addBoundaryHandle("end",Number(current.end)||0);
        state.audio_cuts ||= [];state.audio_cuts.sort((a,b)=>a-b);
        state.audio_cuts.forEach((cut,index)=>{const handle=document.createElement("div");handle.className=`dh2-cut-handle${index===selectedCutIndex?" selected":""}`;handle.style.left=`${cut/duration*100}%`;handle.innerHTML=`<span>${time(cut)}</span>`;handle.title="拖动调整切点；双击删除切点";handle.onclick=event=>{event.stopPropagation();selectedCutIndex=index;renderCutHandles();};handle.ondblclick=async event=>{event.stopPropagation();state.audio_cuts.splice(index,1);selectedCutIndex=-1;await save();drawWave();};handle.onpointerdown=event=>{event.preventDefault();event.stopPropagation();selectedCutIndex=index;const move=moveEvent=>{const rect=waveStage.getBoundingClientRect();const value=Math.max(.01,Math.min(duration-.01,(moveEvent.clientX-rect.left)/rect.width*duration));state.audio_cuts[index]=value;state.audio_cuts.sort((a,b)=>a-b);pinnedTime=value;drawWave();};const up=async()=>{window.removeEventListener("pointermove",move);window.removeEventListener("pointerup",up);await save();};window.addEventListener("pointermove",move);window.addEventListener("pointerup",up);};host.appendChild(handle);});
    }
    async function addCut(){const duration=state?.duration||0,value=Math.max(.01,Math.min(duration-.01,pinnedTime||audio.currentTime||0));if(!duration||state.audio_cuts?.some(c=>Math.abs(c-value)<.02))return notify("请先把播放游标放到新的切分位置",true);state.audio_cuts||=[];state.audio_cuts.push(value);state.audio_cuts.sort((a,b)=>a-b);selectedCutIndex=state.audio_cuts.findIndex(c=>c===value);await save();drawWave();notify(`已在 ${time(value)} 添加切点`);}
    const render = () => { renderScenes(); renderAudioTracks(); renderForm(); renderThumbs(); renderAssetLibrary(); renderResults(); $(root,"[data-wave-empty]").hidden=!!decoded; requestAnimationFrame(drawWave); };
    const addSegment = async (position, source=null) => {
        const base=source || selected(), duration=state.duration||0, start=base ? base.end : 0, end=Math.min(duration,start+Math.max(.1,Math.min(5,duration-start)));
        const item={id:crypto.randomUUID().replaceAll("-","").slice(0,12),name:`分镜 ${String(state.segments.length+1).padStart(2,"0")}`,start,end,refs:source?[...(source.refs||[])]:[],original_prompt:source?.original_prompt||"",optimized_prompt:source?.optimized_prompt||""};
        state.segments.splice(position,0,item);state.selected_segment=position;normalizeSegments();await save();render();
    };
    const addSegmentFromAudio = async () => {
        const duration=Number(state.duration||0),current=selected(),currentIndex=Number(state.selected_segment||0);
        if(!duration||!current)return notify("请先上传音频",true);
        const cuts=[...(state.audio_cuts||[])].map(Number).filter(value=>value>.01&&value<duration-.05).sort((a,b)=>a-b);
        const selectedCut=selectedCutIndex>=0?Number(state.audio_cuts?.[selectedCutIndex]):NaN;
        let split=Number.isFinite(selectedCut)?selectedCut:Number(pinnedTime||audio.currentTime||0);
        if(!(split>Number(current.start)+.01))split=cuts.find(value=>value>Number(current.start)+.01)??NaN;
        if(!Number.isFinite(split)||split>=duration-.05)return notify("请先在当前分镜之后选择一个有效切点（末段至少保留 0.05 秒）",true);
        if(state.segments.some((segment,index)=>index!==currentIndex&&Math.abs(Number(segment.start)-split)<.02))return notify(`已有分镜从 ${time(split)} 开始`,true);
        const oldEnd=Number(current.end||0);
        const nextCut=cuts.find(value=>value>split+.01);
        const end=oldEnd>split+.01?oldEnd:(nextCut??duration);
        current.end=split;
        const item={id:crypto.randomUUID().replaceAll("-","").slice(0,12),name:`分镜 ${String(state.segments.length+1).padStart(2,"0")}`,start:split,end,refs:[],avatar_refs:[],scene_refs:[],library_refs:[],original_prompt:"",optimized_prompt:""};
        state.segments.splice(currentIndex+1,0,item);state.selected_segment=currentIndex+1;normalizeSegments();syncWidgets();await save();render();notify(`已从 ${time(split)} 接续新建分镜；上一分镜结束时间已同步`);
    };
    const addSegmentsFromText = async () => {
        const source=(selected().original_prompt||"").trim();
        if(!source)return notify("请先在原始提示词中输入分镜内容",true);
        const parts=source.split(/(?:\r?\n){2,}|\r?\n|(?<=[。！？!?；;])\s+/).map(value=>value.trim()).filter(Boolean);
        if(!parts.length)return notify("没有识别到可用的分镜文本",true);
        const duration=Number(state.duration||0), length=duration>0?duration/parts.length:5;
        state.segments=parts.map((text,index)=>({id:crypto.randomUUID().replaceAll("-","").slice(0,12),name:`分镜 ${String(index+1).padStart(2,"0")}`,start:duration>0?index*length:index*5,end:duration>0?(index+1)*length:(index+1)*5,refs:[],avatar_refs:[],scene_refs:[],library_refs:[],original_prompt:text,optimized_prompt:""}));
        state.selected_segment=0;await save();render();notify(`已按文本生成 ${parts.length} 个分镜`);
    };
    async function uploadAudio(file, mode="add") {
        if (!file) return;
        const isAudio = String(file.type || "").toLowerCase().startsWith("audio/") || /\.(aac|aif|aiff|flac|m4a|mp3|ogg|opus|wav|wma)$/i.test(String(file.name || ""));
        if (!isAudio) return notify("请拖入有效的音频文件", true);
        notify("正在上传音频…");
        const form=new FormData();form.append("file",file,file.name);form.append("mode",mode);if(mode==="replace"&&selectedAudioTrack()?.id)form.append("track_id",selectedAudioTrack().id);
        try { const data=await jsonFetch(endpoint(state,"/audio"),{method:"POST",body:form});state=data.project;normalizeAudioTracks();selectedCutIndex=-1;const buffer=await file.arrayBuffer();const uploaded=await new AudioContext().decodeAudioData(buffer.slice(0));const track=selectedAudioTrack();if(track)track.duration=uploaded.duration;await save();pinnedTime=Number(selectedAudioTrack()?.offset||0);await loadSelectedAudioTrack();render();notify(mode==="replace"?"当前音频片段已替换":"音频片段已接到上一段后面"); }
        catch(error){notify(error.message,true);}
    }
    async function uploadRefs(files, targetIndex=pendingRefSegmentIndex) {
        if(!files.length)return;const lockedIndex=Math.max(0,Math.min(Number(targetIndex)||0,state.segments.length-1));notify(`正在上传${refLabels.current}…`);const form=new FormData();form.append("segment_index",String(lockedIndex));form.append("kind","current");[...files].slice(0,9).forEach((file,i)=>form.append(`file_${i}`,file,file.name));
        try{const data=await jsonFetch(endpoint(state,"/refs"),{method:"POST",body:form});state=data.project;state.selected_segment=lockedIndex;syncWidgets();await save();render();notify(`参考图已上传到分镜 ${lockedIndex+1}`);}catch(error){notify(error.message,true);}
    }
    async function init() {
        try {
            if(projectWidget?.value){
                try {
                    const data=await jsonFetch(`/xiantu/dhv2/projects/${encodeURIComponent(projectWidget.value)}`);
                    state=data.project;
                } catch (_missingProject) {
                    const data=await jsonFetch("/xiantu/dhv2/projects",{method:"POST"});
                    state=data.project;
                }
            } else {
                const data=await jsonFetch("/xiantu/dhv2/projects",{method:"POST"});
                state=data.project;
            }
            state.audio_cuts ||= [];
            state.results ||= [];
            state.assets ||= [];
            state.segments ||= [];
            normalizeAudioTracks();
            state.segments.forEach(segment=>{segment.refs=[...(segment.refs||[]),...(segment.avatar_refs||[]),...(segment.scene_refs||[]),...(segment.library_refs||[])].slice(0,9);delete segment.avatar_refs;delete segment.scene_refs;delete segment.library_refs;});
            normalizeSegments();
            syncAssetFilesFromState();
            syncWidgets();
            await loadSelectedAudioTrack();
            render();
        } catch(error){notify(`加载项目失败：${error.message}`,true);}
    }

    const closeStudio=()=>{if(generationActive){root.hidden=true;return;}cancelAnimationFrame(playFrame);cancelAnimationFrame(zoomFrame);clearTimeout(generationResetTimer);clearInterval(generationPulseTimer);api.removeEventListener?.("executed",captureResult);api.removeEventListener?.("execution_start",generationStarted);api.removeEventListener?.("progress",generationProgress);api.removeEventListener?.("executing",generationExecuting);api.removeEventListener?.("execution_success",generationSucceeded);api.removeEventListener?.("execution_error",generationFailed);api.removeEventListener?.("execution_interrupted",generationFailed);if(node._dh2Studio===root)node._dh2Studio=null;root.remove();};
    root._close=closeStudio;
    $(root,"[data-close]").onclick=closeStudio;
    api.addEventListener("executed",captureResult);
    api.addEventListener("execution_start",generationStarted);
    api.addEventListener("progress",generationProgress);
    api.addEventListener("executing",generationExecuting);
    api.addEventListener("execution_success",generationSucceeded);
    api.addEventListener("execution_error",generationFailed);
    api.addEventListener("execution_interrupted",generationFailed);
    const audioFile=$(root,"[data-audio-file]");
    $(root,"[data-audio-upload]").onclick=()=>{audioFile.dataset.mode="add";audioFile.click();};$(root,"[data-audio-replace]").onclick=()=>{if(!selectedAudioTrack())return notify("请先上传或选择一条音轨",true);audioFile.dataset.mode="replace";audioFile.click();};audioFile.onchange=async()=>{const files=[...(audioFile.files||[])],mode=audioFile.dataset.mode||"add";audioFile.value="";if(mode==="replace")return uploadAudio(files[0],"replace");for(const file of files)await uploadAudio(file,"add");};
    const draggedAudios = transfer => [...(transfer?.files || [])].filter(file => String(file.type || "").toLowerCase().startsWith("audio/") || /\.(aac|aif|aiff|flac|m4a|mp3|ogg|opus|wav|wma)$/i.test(String(file.name || "")));
    const draggedAudio = transfer => draggedAudios(transfer)[0];
    waveWrap.ondragenter=event=>{if(!draggedAudio(event.dataTransfer)&&![...(event.dataTransfer?.items||[])].some(item=>item.kind==="file"&&String(item.type||"").startsWith("audio/")))return;event.preventDefault();waveWrap.classList.add("is-audio-dragover");};
    waveWrap.ondragover=event=>{event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect="copy";waveWrap.classList.add("is-audio-dragover");};
    waveWrap.ondragleave=event=>{if(!waveWrap.contains(event.relatedTarget))waveWrap.classList.remove("is-audio-dragover");};
    waveWrap.ondrop=async event=>{event.preventDefault();waveWrap.classList.remove("is-audio-dragover");const file=draggedAudio(event.dataTransfer);if(!file)return notify("请拖入有效的音频文件",true);await uploadAudio(file,selectedAudioTrack()?"replace":"add");};
    const refFile=$(root,"[data-ref-file]");$(root,"[data-ref-drop]").onclick=event=>{if(event.target.closest("figure,button"))return;pendingRefSegmentIndex=state.selected_segment;refFile.click();};refFile.onchange=()=>{const files=[...(refFile.files||[])];refFile.value="";uploadRefs(files,pendingRefSegmentIndex);};
    const assetDialog=$(root,"[data-asset-dialog]"),assetGrid=$(root,"[data-asset-grid]"),assetFilesInput=$(root,"[data-asset-files]");
    assetFilesInput.onchange=async()=>{await useAssetFiles(assetFilesInput.files||[]);assetFilesInput.value="";};
    $(root,"[data-ref-current]").onclick=()=>{assetDialog.hidden=true;};$(root,"[data-ref-library]").onclick=()=>{assetTargetSegmentIndex=state.selected_segment;syncAssetFilesFromState();assetMode=true;renderAssetLibrary();assetDialog.hidden=false;};
    $(root,"[data-asset-files-pick]").onclick=()=>assetFilesInput.click();
    $$(root,"[data-asset-category]").forEach(tab=>tab.onclick=()=>{assetCategory=tab.dataset.assetCategory;renderAssetLibrary();});
    $$(root,"[data-asset-close]").forEach(button=>button.onclick=()=>{assetDialog.hidden=true;});assetDialog.onclick=event=>{if(event.target===assetDialog)assetDialog.hidden=true;};
    $(root,"[data-asset-select-all]").onclick=()=>{assetFiles.filter(item=>assetCategory==="all"||(item.category||"other")===assetCategory).forEach(item=>item.selected=true);renderAssetLibrary();};
    $(root,"[data-asset-select-none]").onclick=()=>{assetFiles.filter(item=>assetCategory==="all"||(item.category||"other")===assetCategory).forEach(item=>item.selected=false);renderAssetLibrary();};
    $(root,"[data-asset-delete]").onclick=async()=>{const ids=assetFiles.filter(item=>item.selected).map(item=>item.id);if(!ids.length)return notify("请先选择要删除的资产",true);try{const data=await jsonFetch(endpoint(state,"/assets/delete"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({asset_ids:ids})});state=data.project;syncAssetFilesFromState();renderAssetLibrary();renderThumbs();notify(`已删除 ${data.deleted||0} 个资产`);}catch(error){notify(error.message,true);}};
    $(root,"[data-asset-apply]").onclick=async()=>{const target=state.segments[assetTargetSegmentIndex],chosen=assetFiles.filter(item=>item.selected),known=new Set((target?.refs||[]).map(item=>item.path)),available=Math.max(0,9-(target?.refs||[]).length);if(!chosen.length)return notify("请先在资产库勾选图片",true);if(!available)return notify("目标分镜已经有 9 张参考图",true);target.refs||=[];target.refs.push(...chosen.filter(item=>!known.has(item.path)).slice(0,available).map(({id,name,path})=>({id,name,path})));state.selected_segment=assetTargetSegmentIndex;await save();assetFiles.forEach(item=>item.selected=false);assetDialog.hidden=true;render();notify(`已把资产应用到分镜 ${assetTargetSegmentIndex+1}`);};
    const bindImageDrop=(element,handler)=>{element.ondragenter=event=>{if(!imageFiles(event.dataTransfer?.files).length&&![...(event.dataTransfer?.items||[])].some(item=>item.kind==="file"&&String(item.type||"").startsWith("image/")))return;event.preventDefault();element.classList.add("is-image-dragover");};element.ondragover=event=>{event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect="copy";element.classList.add("is-image-dragover");};element.ondragleave=event=>{if(!element.contains(event.relatedTarget))element.classList.remove("is-image-dragover");};element.ondrop=async event=>{event.preventDefault();element.classList.remove("is-image-dragover");await handler(imageFiles(event.dataTransfer?.files));};};
    bindImageDrop($(root,"[data-ref-drop]"),files=>uploadRefs(files,state.selected_segment));
    bindImageDrop(assetGrid,files=>useAssetFiles(files));
    $(root,"[data-copy]").onclick=()=>addSegment(state.selected_segment+1,selected());
    $(root,"[data-delete]").onclick=async()=>{if(state.segments.length<=1)return;state.segments.splice(state.selected_segment,1);state.selected_segment=Math.min(state.selected_segment,state.segments.length-1);normalizeSegments();await save();render();};
    $(root,"[data-clear]").onclick=async()=>{state.segments=[{id:crypto.randomUUID().replaceAll("-","").slice(0,12),name:"分镜 01",start:0,end:state.duration||0,refs:[],original_prompt:"",optimized_prompt:""}];state.selected_segment=0;await save();render();};
    $(root,"[data-prev]").onclick=()=>{state.selected_segment=Math.max(0,state.selected_segment-1);syncWidgets();render();};$(root,"[data-next]").onclick=()=>{state.selected_segment=Math.min(state.segments.length-1,state.selected_segment+1);syncWidgets();render();};$(root,"[data-new-right]").onclick=()=>addSegmentFromAudio();
    $(root,"[data-current]").onchange=e=>{state.selected_segment=Number(e.target.value);syncWidgets();render();};
    $(root,"[data-import]").onclick=()=>{const input=document.createElement("input");input.type="file";input.accept="application/json";input.onchange=async()=>{try{const incoming=JSON.parse(await input.files[0].text());state.segments=incoming.segments||incoming;state.selected_segment=0;normalizeSegments();await save();render();}catch(e){notify("分镜文件格式错误",true);}};input.click();};
    $(root,"[data-export]").onclick=()=>{const blob=new Blob([JSON.stringify({segments:state.segments},null,2)],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="数字人分镜.json";a.click();URL.revokeObjectURL(a.href);};
    $$ (root,"[data-setting]").forEach(el=>el.onchange=async()=>{state.settings[el.dataset.setting]=el.value;calculate(false);await save();renderForm();});
    $(root,"[data-ref-size]").onchange=e=>{state.settings.reference_size=e.target.value;save();};$(root,"[data-fps]").onchange=e=>{state.settings.fps=Number(e.target.value);save();};
    $(root,"[data-filename-prefix]").oninput=event=>{state.settings.filename_prefix=event.target.value.slice(0,80);clearTimeout(root._saveFilenamePrefix);root._saveFilenamePrefix=setTimeout(save,350);};
    $$(root,"[data-prompt-tab]").forEach(tab=>tab.onclick=()=>{promptView=tab.dataset.promptTab==="optimized"?"optimized":"original";renderPrompt();$(root,"[data-original-count]").textContent=String(promptView==="optimized"?selected().optimized_prompt||"":selected().original_prompt||"").length;});
    promptEditor.oninput=event=>{const field=promptEditor.dataset.promptMode==="optimized"?"optimized_prompt":"original_prompt";selected()[field]=promptText();$(root,"[data-original-count]").textContent=selected()[field].length;rememberPromptRange();if(event.data==="@"||selected()[field].endsWith("@"))showMentionMenu();else $(root,"[data-mention-menu]").hidden=true;clearTimeout(root._saveText);root._saveText=setTimeout(save,350);};
    promptEditor.onkeyup=rememberPromptRange;promptEditor.onmouseup=rememberPromptRange;promptEditor.onfocus=rememberPromptRange;
    $(root,"[data-auto-optimize]").onchange=async event=>{state.settings.auto_optimize=event.target.checked;await save();notify(event.target.checked?"已开启自动优化：生成时由工作台内部调用本地 Qwen H3 Prompt":"已关闭自动优化：直接使用原始提示词生成条件");};
    $$(root,"[data-model-profile]").forEach(button=>button.onclick=async()=>{const profile=button.dataset.modelProfile;if(profile!=="h3")return;state.settings.model_profile=profile;await save();renderForm();notify("当前数字人模型：H3模型");});
    const optimizationDialog=$(root,"[data-opt-dialog]");
    $(root,"[data-opt-open]").onclick=()=>{optimizationDialog.hidden=false;};
    $$(root,"[data-opt-close]").forEach(button=>button.onclick=()=>{optimizationDialog.hidden=true;});
    optimizationDialog.onclick=event=>{if(event.target===optimizationDialog)optimizationDialog.hidden=true;};
    $$(root,"[data-opt-setting]").forEach(el=>el.onchange=async()=>{const key=el.dataset.optSetting;let value=el.type==="checkbox"?el.checked:el.value;if(el.type==="number")value=Number(value);state.settings[key]=value;await save();});
    $(root,"[data-clear-prompt]").onclick=()=>{promptEditor.replaceChildren();selected()[promptView==="optimized"?"optimized_prompt":"original_prompt"]="";save();renderForm();};
    const removeLegacyOptimizerLinks=()=>{
        const graph=node.graph||app.graph;if(!graph)return 0;const ids=[];
        for(const output of node.outputs||[])for(const linkId of output?.links||[]){const link=graph.links?.[linkId],target=link?graph.getNodeById?.(link.target_id):null;if(String(target?.comfyClass||target?.type)==="QwenH3PromptLocal")ids.push(linkId);}
        for(const linkId of ids)graph.removeLink(linkId);
        if(ids.length)graph.setDirtyCanvas?.(true,true);return ids.length;
    };
    generateButton.onclick=async()=>{
        if(generationActive)return;
        const selectedIndices=state.segments.map((segment,index)=>segment.generate_selected!==false?index:-1).filter(index=>index>=0);
        if(!selectedIndices.length)return notify("请先勾选至少一个要生成的分镜",true);
        generationOwnerToken=crypto.randomUUID();globalThis.__xiantuDh2BatchOwner=generationOwnerToken;
        generationOriginalIndex=state.selected_segment;generationQueueIndices=Object.freeze([...selectedIndices]);generationTotal=selectedIndices.length;generationCompleted=0;generationAdvancing=false;generationPromptId="";completedPromptIds.clear();setGenerationState("submitting",0,`准备严格按顺序生成 ${generationTotal} 个分镜 · 0%`);
        try{
            const removed=removeLegacyOptimizerLinks();
            await submitGenerationAt(0);
            notify(removed?`已移除旧的外部 Qwen 回路线；当前只提交第 1 个，完成后再提交下一个`:`当前只提交第 1 个，完成后再提交下一个`);
        }catch(error){await restoreGenerationSelection().catch(()=>{});setGenerationState("error",generationPercent,`提交失败：${error.message}`);notify(`生成提交失败：${error.message}`,true);}
    };
    $$(root,"[data-result-tab]").forEach(tab=>tab.onclick=()=>{resultView=tab.dataset.resultTab;previewResultId="";renderResults();});
    $(root,"[data-result-all]").onchange=event=>{state.results.filter(record=>resultKind(record)===resultView).forEach(record=>record.selected=event.target.checked);save();renderResults();};
    $(root,"[data-result-delete]").onclick=async()=>{const count=state.results.filter(record=>record.selected).length;if(!count)return notify("请先选择要删除的生成记录",true);state.results=state.results.filter(record=>!record.selected);if(!state.results.some(record=>record.id===previewResultId))previewResultId="";await save();renderResults();notify(`已删除 ${count} 条生成记录`);};
    $(root,"[data-result-folder]").onclick=async()=>{try{await jsonFetch(endpoint(state,"/results/open-folder"),{method:"POST"});notify("已打开输出目录");}catch(error){notify(`打开输出目录失败：${error.message}`,true);}};
    $(root,"[data-result-merge]").onclick=async()=>{const ids=state.results.filter(record=>record.selected&&resultKind(record)==="after").map(record=>record.id);if(ids.length<2)return notify("请在“放大后”中至少选择两个视频再合并",true);try{notify("正在按分镜编号从小到大合并…");const data=await jsonFetch(endpoint(state,"/merge"),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({result_ids:ids})});state=data.project;resultView="merged";previewResultId=data.result.id;renderResults();notify(`视频合并完成：${data.result.filename}`);}catch(error){notify(error.message,true);}};
    const updatePlayhead=()=>{pinnedTime=Number(audio.currentTime||0);$(root,"[data-player-time]").textContent=`${time(audio.currentTime)} / ${time(audio.duration||0)}`;$(root,"[data-seek]").value=audio.duration?audio.currentTime/audio.duration:0;positionWaveLine(playheadLine,pinnedTime);};
    const animatePlayhead=()=>{updatePlayhead();if(!audio.paused&&!audio.ended)playFrame=requestAnimationFrame(animatePlayhead);};
    const seekAudio=(target,play=false)=>{const duration=Number(audio.duration||state?.duration||0),wanted=Math.max(0,Math.min(duration,Number(target)||0)),token=++audioSeekToken;pinnedTime=wanted;positionWaveLine(playheadLine,wanted);$(root,"[data-player-time]").textContent=`${time(wanted)} / ${time(duration)}`;$(root,"[data-seek]").value=duration?wanted/duration:0;const finish=()=>{if(token!==audioSeekToken)return;audioSeeking=false;pinnedTime=wanted;positionWaveLine(playheadLine,wanted);if(play)audio.play().catch(error=>notify(`音频播放失败：${error.message}`,true));};if(audio.readyState<=0||!Number.isFinite(audio.duration)){audio.addEventListener("loadedmetadata",()=>{if(token===audioSeekToken)seekAudio(wanted,play);},{once:true});audio.load();return;}audio.pause();const same=Math.abs(Number(audio.currentTime||0)-wanted)<.02;if(same){finish();return;}audioSeeking=true;audio.addEventListener("seeked",finish,{once:true});audio.currentTime=wanted;setTimeout(()=>{if(token===audioSeekToken&&audioSeeking)finish();},800);};
    $(root,"[data-play]").onclick=()=>{if(!audio.paused)return audio.pause();seekAudio(pinnedTime,true);};audio.onplay=()=>{$(root,"[data-play]").textContent="Ⅱ";cancelAnimationFrame(playFrame);playFrame=requestAnimationFrame(animatePlayhead);};audio.onpause=()=>{$(root,"[data-play]").textContent="▶";cancelAnimationFrame(playFrame);};audio.onended=audio.onpause;audio.ontimeupdate=()=>{if(!audio.seeking&&!audioSeeking)updatePlayhead();};$(root,"[data-seek]").oninput=e=>{const duration=Number(audio.duration||state?.duration||0);if(duration)seekAudio(Number(e.target.value)*duration,false);};$(root,"[data-volume]").oninput=e=>audio.volume=Number(e.target.value);
    const setZoom=value=>{const duration=state?.duration||1,center=(waveWrap.scrollLeft+waveWrap.clientWidth/2)/Math.max(1,waveStage.scrollWidth)*duration;zoom=Math.max(1,Math.min(8,Number(value)||1));$(root,"[data-zoom]").value=zoom;$(root,"[data-zoom-text]").textContent=`${zoom}×`;drawWave();cancelAnimationFrame(zoomFrame);zoomFrame=requestAnimationFrame(()=>{waveWrap.scrollLeft=Math.max(0,center/duration*waveStage.scrollWidth-waveWrap.clientWidth/2);});};
    waveWrap.onwheel=event=>{if(event.ctrlKey){event.preventDefault();setZoom(zoom+(event.deltaY<0?.5:-.5));return;}if(zoom>1&&(event.shiftKey||Math.abs(event.deltaY)>Math.abs(event.deltaX))){event.preventDefault();waveWrap.scrollLeft+=event.deltaX||event.deltaY;}};
    $(root,"[data-zoom]").oninput=e=>setZoom(e.target.value);$(root,"[data-marker]").onclick=()=>{showMarkers=!showMarkers;drawWave();};
    $(root,"[data-full]").onclick=()=>{setZoom(1);waveWrap.scrollLeft=0;};$(root,"[data-zoom-in-2]").onclick=()=>setZoom(zoom+.5);$(root,"[data-zoom-out-2]").onclick=()=>setZoom(zoom-.5);$(root,"[data-current-window]").onclick=()=>{setZoom(Math.min(8,Math.max(1,(state.duration||1)/Math.max(.1,selected().end-selected().start))));requestAnimationFrame(()=>waveWrap.scrollLeft=Math.max(0,selected().start/(state.duration||1)*waveStage.scrollWidth-20));};$(root,"[data-cut-window]").onclick=()=>{setZoom(Math.max(4,zoom));requestAnimationFrame(()=>waveWrap.scrollLeft=Math.max(0,pinnedTime/(state.duration||1)*waveStage.scrollWidth-waveWrap.clientWidth/2));};
    canvas.onmousemove=e=>{if(!state?.duration)return;const value=pointerTime(e);hoverLine.style.display="block";positionWaveLine(hoverLine,value);canvas.title=`${time(value)} · 单击后从这里播放`;};canvas.onmouseleave=()=>hoverLine.style.display="none";
    waveStage.addEventListener("pointerdown",event=>{
        if(event.button!==0||!state?.duration||event.target.closest?.(".dh2-cut-handle,.dh2-boundary-handle"))return;
        event.preventDefault();event.stopPropagation();pinnedTime=pointerTime(event);
        positionWaveLine(playheadLine,pinnedTime);$(root,"[data-player-time]").textContent=`${time(pinnedTime)} / ${time(audio.duration||state.duration||0)}`;$(root,"[data-seek]").value=state.duration?pinnedTime/state.duration:0;
        selectedCutIndex=(state.audio_cuts||[]).findIndex(c=>Math.abs(c-pinnedTime)<Math.max(.03,state.duration/waveStage.clientWidth*8));renderCutHandles();
        seekAudio(pinnedTime,false);
    },true);
    $(root,"[data-crop]").onclick=addCut;$(root,"[data-remove]").onclick=async()=>{if(selectedCutIndex<0)return notify("请先点击一个紫色切点",true);state.audio_cuts.splice(selectedCutIndex,1);selectedCutIndex=-1;await save();drawWave();notify("切点已删除");};$(root,"[data-deselect]").onclick=()=>{selectedCutIndex=-1;renderCutHandles();};$(root,"[data-mute]").onclick=async()=>{selected().muted=!selected().muted;await save();notify(selected().muted?"当前分镜已标记静音":"当前分镜已取消静音");};
    new ResizeObserver(drawWave).observe(canvas);root.addEventListener("keydown",e=>{if(e.key==="Escape")closeStudio();});
    init();return root;
}

app.registerExtension({
    name:"Xiantu.DigitalHumanV2.Fresh",
    async nodeCreated(node){
        if(String(node.comfyClass||node.type)!==NODE)return;
        node.title="闲兔｜数字人工作台 V2";
        const repairPorts=()=>{
          const legacyInputNames={clip:"H3_CLIP",vae:"H3_VIDEO_VAE",audio_vae:"H3_AUDIO_VAE"};
          for(const slot of node.inputs||[]){if(legacyInputNames[slot?.name])slot.name=legacyInputNames[slot.name];}
          const wantedInputs=[["H3_CLIP","CLIP"],["H3_VIDEO_VAE","VAE"],["H3_AUDIO_VAE","VAE"]];
          for(const [name,type] of wantedInputs){
            let slot=(node.inputs||[]).find(item=>item?.name===name);
            if(!slot){node.addInput?.(name,type);slot=(node.inputs||[]).find(item=>item?.name===name);}
            if(slot){slot.name=name;slot.type=type;slot.localized_name=name;}
          }
          const wantedOutputs=[["H3条件","CONDITIONING"],["H3 Latent","LATENT"],["H3图像","IMAGE"],["H3音频","AUDIO"],["H3放大前文件名","STRING"],["H3放大后文件名","STRING"]];
          for(let index=0;index<wantedOutputs.length;index++){
            const [name,type]=wantedOutputs[index];if(!node.outputs?.[index])node.addOutput?.(name,type);
            const slot=node.outputs?.[index];if(slot){slot.name=name;slot.type=type;slot.localized_name=name;}
          }
          // Do not remove ports after the H3 group. Future model adapters append
          // their own isolated input/output groups and must survive UI repair.
          const deprecatedOutputs=new Set(["时长","SKILL","原始提示词","文件名格式"]);
          for(let index=(node.outputs||[]).length-1;index>=wantedOutputs.length;index--){if(deprecatedOutputs.has(String(node.outputs[index]?.name||"")))node.removeOutput?.(index);}
          node.graph?.setDirtyCanvas?.(true,true);
        };
        repairPorts();setTimeout(repairPorts,0);setTimeout(repairPorts,120);setTimeout(repairPorts,500);
        for(const widget of node.widgets||[]){if(["project_id","segment_index"].includes(widget.name)){widget.type="hidden";widget.computeSize=()=>[0,-4];widget.serialize=true;}}
        const open=()=>{if(node._dh2Studio?.isConnected){node._dh2Studio.hidden=false;return;}const previous=document.querySelector(".dh2-overlay");previous?._close?.();if(previous?.isConnected&&!previous.hidden)return;const panel=studio(node);node._dh2Studio=panel;document.body.appendChild(panel);};
        node.addWidget("button","打开数字人工作台",null,open,{serialize:false});
        requestAnimationFrame(()=>node.setSize?.([260,170]));
    }
});
