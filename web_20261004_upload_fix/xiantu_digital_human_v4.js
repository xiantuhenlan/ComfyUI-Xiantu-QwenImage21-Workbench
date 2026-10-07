import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_NAME = "XiantuDigitalHumanStudio";
const NODE_TITLE = "闲兔｜数字人工作台";
const OUTPUT_NODE_TITLES = {
    XiantuDigitalHumanImageOutput: "闲兔｜数字人图片输出",
    XiantuDigitalHumanPromptOutput: "闲兔｜数字人提示词输出",
    XiantuDigitalHumanAudioOutput: "闲兔｜数字人音乐输出",
};
const STYLE_ID = "xiantu-digital-human-v4-style";

function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .xdh-v4{box-sizing:border-box;width:100%;min-width:810px;overflow:hidden;border:1px solid #34485c;border-radius:9px;color:#e7eef6;background:#101821;font-family:Inter,"Microsoft YaHei",sans-serif;box-shadow:0 10px 30px #0004}.xdh-v4 *{box-sizing:border-box}
      .xdh-v4 .xh3-head{display:flex;height:42px;align-items:center;gap:10px;padding:0 13px;border-bottom:1px solid #35485b;background:linear-gradient(180deg,#253442,#1b2835)}.xdh-v4 .xh3-logo{font-size:14px;font-weight:800}.xdh-v4 .xh3-badge{padding:3px 8px;border:1px solid #3d5870;border-radius:999px;color:#8fd8f2;background:#172b3a;font-size:9px}.xdh-v4 .xh3-spacer{flex:1}.xdh-v4 .xh3-state{display:flex;align-items:center;gap:6px;color:#9aabbd;font-size:9px}.xdh-v4 .xh3-dot{width:7px;height:7px;border-radius:50%;background:#48d98c;box-shadow:0 0 8px #48d98c}
      .xdh-v4 .xh3-body{padding:10px;background:linear-gradient(145deg,#121d28,#0e151d)}.xdh-v4 .xh3-storybar{overflow:hidden;border:1px solid #304357;border-radius:8px;background:#14202b}.xdh-v4 .xh3-story-title{display:flex;align-items:center;gap:9px;padding:9px 10px;border-bottom:1px solid #2e4255}.xdh-v4 .xh3-story-title strong{font-size:13px}.xdh-v4 .xh3-story-title span{color:#7e95a9;font-size:9px}.xdh-v4 button,.xdh-v4 select,.xdh-v4 input,.xdh-v4 textarea{border:1px solid #40566d;border-radius:6px;color:#dce5ee;background:#1b2937;font:10px "Microsoft YaHei",sans-serif;outline:none}.xdh-v4 button{min-height:29px;padding:0 10px;cursor:pointer}.xdh-v4 button:hover{filter:brightness(1.16)}.xdh-v4 .primary{border-color:#536be1;background:linear-gradient(100deg,#258fe9,#8b4cec);font-weight:700}.xdh-v4 .xh3-add-shot{margin-left:auto}
      .xdh-v4 .xh3-shot-list{display:flex;min-height:76px;gap:7px;overflow-x:auto;padding:9px}.xdh-v4 .xh3-shot{position:relative;min-width:156px;max-width:210px;padding:9px 10px 8px;border:1px solid #344b60;border-radius:7px;color:#cfd9e4;background:#1a2937;cursor:pointer}.xdh-v4 .xh3-shot:hover{border-color:#4d7593}.xdh-v4 .xh3-shot.active{border-color:#48c8ef;background:#17364a;box-shadow:inset 0 -2px #42c8ed}.xdh-v4 .xh3-shot.selected{background:#203b4d}.xdh-v4 .xh3-shot b,.xdh-v4 .xh3-shot small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.xdh-v4 .xh3-shot b{padding-right:18px;font-size:11px}.xdh-v4 .xh3-shot small{margin-top:5px;color:#8197aa;font-size:9px}.xdh-v4 .xh3-shot input{position:absolute;top:8px;right:7px}.xdh-v4.expanded .xh3-shot-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));max-height:250px}.xdh-v4.expanded .xh3-shot{max-width:none}
      .xdh-v4 .xh3-story-actions{display:flex;align-items:center;gap:7px;padding:7px 9px;border-top:1px solid #2c4053}.xdh-v4 .xh3-story-spacer{flex:1}.xdh-v4 .xh3-inline-field{display:flex;align-items:center;gap:6px;color:#8297aa;font-size:9px}.xdh-v4 .xh3-inline-field select{height:29px;padding:0 8px}.xdh-v4 .danger{border-color:#71444b;color:#ffc2c6;background:#482d33}
      .xdh-v4 .xh3-settings{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:9px}.xdh-v4 .xh3-control{display:flex;min-width:0;flex-direction:column;gap:6px;padding:9px 10px;border:1px solid #304357;border-radius:8px;background:#14202b}.xdh-v4 .xh3-control label{color:#8499ac;font-size:9px}.xdh-v4 .xh3-control input,.xdh-v4 .xh3-control select{width:100%;height:31px;padding:0 8px}
      .xdh-v4 .xh3-media-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:9px}.xdh-v4 .xh3-card{overflow:hidden;border:1px solid #304357;border-radius:8px;background:#14202b}.xdh-v4 .xh3-card-head{display:flex;align-items:center;justify-content:space-between;padding:9px 11px;border-bottom:1px solid #2d4154;font-size:11px;font-weight:700}.xdh-v4 .xh3-card-head small{color:#70879b;font-size:8px;font-weight:400}.xdh-v4 .xh3-media{display:grid;min-height:185px;place-items:center;padding:10px}.xdh-v4 .xh3-drop{display:grid;width:100%;min-height:155px;place-items:center;border:1px dashed #456078;border-radius:7px;color:#8298ab;background:#111c26;text-align:center;cursor:pointer}.xdh-v4 .xh3-drop:hover{border-color:#4cc9ed;color:#b8e8f7}.xdh-v4 .xh3-drop b{display:block;margin-bottom:6px;color:#cbd9e5;font-size:12px}.xdh-v4 .xh3-drop small{font-size:9px}.xdh-v4 .xh3-image-grid{display:grid;width:100%;grid-template-columns:repeat(3,1fr);gap:7px;place-items:stretch}.xdh-v4 .xh3-image-item{position:relative;overflow:hidden;min-height:94px;border:1px solid #334b60;border-radius:6px;background:#0d151d}.xdh-v4 .xh3-image-item img{display:block;width:100%;height:94px;object-fit:cover}.xdh-v4 .xh3-image-item b{position:absolute;left:5px;top:5px;padding:2px 5px;border-radius:4px;background:#071019cc;font-size:8px}.xdh-v4 .xh3-image-item button{position:absolute;right:4px;top:4px;min-height:20px;padding:0 6px}.xdh-v4 .xh3-image-add{display:grid;min-height:94px;place-items:center;border:1px dashed #456078;border-radius:6px;color:#8fb4c8;background:#111c26;cursor:pointer}.xdh-v4 .xh3-audio-ready{width:100%;padding:10px;border:1px solid #365067;border-radius:7px;background:#111c26}.xdh-v4 .xh3-audio-ready audio{width:100%;height:42px}.xdh-v4 .xh3-wave-tools{display:flex;align-items:center;gap:8px;margin-bottom:6px;color:#87a0b3;font-size:9px}.xdh-v4 .xh3-wave-tools input{flex:1}.xdh-v4 .xh3-wave-scroll{width:100%;overflow-x:auto;overflow-y:hidden;border:1px solid #29475d;border-radius:5px;background:#09121a}.xdh-v4 .xh3-wave-content{position:relative;min-width:100%;height:118px}.xdh-v4 .xh3-wave{display:block;width:100%;height:94px;background:#09121a;cursor:crosshair}.xdh-v4 .xh3-segment-strip{position:absolute;z-index:2;top:94px;right:0;bottom:0;left:0;background:#0c1720}.xdh-v4 .xh3-segment{position:absolute;top:1px;height:22px;overflow:hidden;border:1px solid #38546a;color:#8ca5b8;background:#182a38;font:8px/20px "Microsoft YaHei",sans-serif;text-align:center;white-space:nowrap;cursor:pointer}.xdh-v4 .xh3-segment:hover{border-color:#63cdeb;color:#d9f5ff}.xdh-v4 .xh3-segment.active{border-color:#ffd166;color:#fff1b5;background:#3e3825}.xdh-v4 .xh3-wave-line{position:absolute;z-index:4;top:0;height:94px;width:1px;pointer-events:none;transform:translateX(-.5px)}.xdh-v4 .xh3-wave-line span,.xdh-v4 .xh3-cut-handle span{position:absolute;z-index:7;top:2px;left:4px;padding:1px 4px;border-radius:3px;color:#eefaff;background:#071019dd;font:8px Consolas,monospace;white-space:nowrap}.xdh-v4 .xh3-hover-line{display:none;border-left:1px dashed #73ddff}.xdh-v4 .xh3-playhead-line{border-left:2px solid #53efb1}.xdh-v4 .xh3-cut-handle{position:absolute;z-index:6;top:0;height:118px;width:12px;margin-left:-6px;cursor:ew-resize;touch-action:none}.xdh-v4 .xh3-cut-handle:before{position:absolute;top:0;bottom:0;left:5px;width:2px;background:#ad74ff;content:""}.xdh-v4 .xh3-cut-handle.active:before{background:#ffd166;box-shadow:0 0 5px #ffd16699}.xdh-v4 .xh3-cut-handle.dragging:before{width:3px;background:#ff8f6b}.xdh-v4 .xh3-trim{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:7px 0}.xdh-v4 .xh3-trim label{display:flex;align-items:center;gap:5px;color:#8198aa;font-size:9px}.xdh-v4 .xh3-trim input{min-width:0;width:100%;height:27px;padding:0 6px}.xdh-v4 .xh3-file-name{overflow:hidden;margin:7px 0;color:#9ccfe1;font-size:9px;text-align:center;text-overflow:ellipsis;white-space:nowrap}.xdh-v4 .xh3-media-actions{display:flex;flex-wrap:wrap;justify-content:center;gap:7px}
      .xdh-v4 .xh3-prompt-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:9px}.xdh-v4 .xh3-prompt{overflow:hidden;border:1px solid #304357;border-radius:8px;background:#14202b}.xdh-v4 .xh3-prompt.optimized{border-color:#35634e}.xdh-v4 .xh3-prompt-head{display:flex;align-items:center;justify-content:space-between;padding:9px 11px;border-bottom:1px solid #2d4154;font-size:11px;font-weight:700}.xdh-v4 .xh3-prompt-head span{color:#76cbe8;font-size:9px;font-weight:400}.xdh-v4 .xh3-prompt.optimized .xh3-prompt-head span{color:#77d6a5}.xdh-v4 .xh3-prompt textarea{display:block;width:100%;min-height:150px;border:0;border-radius:0;padding:11px;color:#e0eaf3;background:#101922;font:11px/1.65 Consolas,"Microsoft YaHei",sans-serif;resize:vertical}.xdh-v4 .xh3-footer{display:flex;align-items:center;gap:10px;margin-top:9px;padding:8px 10px;border:1px solid #304357;border-radius:7px;color:#8096a9;background:#121e29;font-size:9px}.xdh-v4 .xh3-footer strong{color:#78d4a5}
      .xdh-v4 .xh3-zoom-group{display:flex;flex:0 0 250px;align-items:center;gap:6px}.xdh-v4 .xh3-zoom-group input[type="range"]{flex:none;width:195px}.xdh-v4 .xh3-wave-time{display:inline-block;flex:0 0 58px;width:58px;text-align:right;font:9px Consolas,monospace;font-variant-numeric:tabular-nums}.xdh-v4 .xh3-cut-handle:before{width:1px}.xdh-v4 .xh3-cut-handle.active:before{width:1px;box-shadow:none}.xdh-v4 .xh3-cut-handle.dragging:before{width:2px}.xdh-v4 .xh3-playhead-line{border-left-width:1px}.xdh-v4 .xh3-playhead-line span{display:none}
      .xdh-v4 .xh3-wave-tools{flex-wrap:wrap}.xdh-v4 .xh3-tool{min-width:58px}.xdh-v4 .xh3-tool.active{border-color:#55cdef;color:#e9fbff;background:#24516a;box-shadow:inset 0 -2px #5ad5f5}.xdh-v4 .xh3-snap.active{border-color:#5bcf91;color:#dffff0;background:#214c39}.xdh-v4 .xh3-hover-line.razor{border-left-color:#ff806d}.xdh-v4 .xh3-cut-handle.selected:before{width:1px;background:#ffe066;box-shadow:none}.xdh-v4 .xh3-track-tag{position:absolute;z-index:8;left:3px;padding:1px 4px;border-radius:3px;color:#b7c9d8;background:#071019cc;font:8px "Microsoft YaHei",sans-serif;pointer-events:none}.xdh-v4 .xh3-track-tag.audio{top:21px}.xdh-v4 .xh3-track-tag.story{display:none}.xdh-v4 .xh3-wave:focus{outline:1px solid #4bc8ee;outline-offset:-1px}
    `;
    document.head.appendChild(style);
}

function widget(node, name) { return (node.widgets || []).find((item) => item.name === name); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function uid() { return `shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
function blankShot(index = 0) { return { id: uid(), title: `分镜 ${String(index + 1).padStart(2, "0")}`, selected: false, prompt: "", optimized_prompt: "", images: [], audio_range: { start: 0, end: 0 }, duration_override: 0 }; }

function buildTimelineModel(state) {
    const shots = state?.storyboard?.shots || [];
    const previous = state?.timeline && typeof state.timeline === "object" ? state.timeline : {};
    const previousTracks = Array.isArray(previous.tracks) ? previous.tracks : [];
    const characterTrack = previousTracks.find((track) => track?.kind === "character") || { id: "characters", kind: "character", name: "角色替换", clips: [] };
    const clipRows = shots.map((shot, index) => ({
        id: `clip-${shot.id}`,
        shot_id: shot.id,
        index,
        source_start: Math.max(0, Number(shot.audio_range?.start || 0)),
        source_end: Math.max(0, Number(shot.audio_range?.end || 0)),
    }));
    return {
        version: 1,
        fps: 24,
        tool: "select",
        snap: previous.snap !== false,
        tracks: [
            { id: "audio-main", kind: "audio", name: "主音轨", clips: clipRows },
            { id: "storyboard", kind: "storyboard", name: "分镜", clips: clipRows.map((clip) => ({ ...clip })) },
            characterTrack,
        ],
    };
}

function migrateLegacyStudioNode(node) {
    const staleInputs = new Set(["分镜", "模型接口", "ref_video_0", "ref_video_audio_0", "ref_audio_0", "ref_audio_1"]);
    for (let index = (node.inputs || []).length - 1; index >= 0; index--) {
        if (staleInputs.has(String(node.inputs[index]?.name || ""))) node.removeInput?.(index);
    }
    const wantedOutputs = [["条件", "CONDITIONING"], ["LATENT", "LATENT"], ["图像", "IMAGE"], ["音频", "AUDIO"], ["秒数", "FLOAT"], ["预览帧", "INT"]];
    // Do not delete and recreate output slots here. Old workflows restore their own
    // serialized slots during configure; deleting them destroys links and may leave
    // the replacement slots with stale/unknown types. Repair each slot in place so
    // AUDIO/FLOAT/INT remain standard ComfyUI ports and existing links survive.
    for (let index = 0; index < wantedOutputs.length; index++) {
        const [name, type] = wantedOutputs[index];
        if (!node.outputs?.[index]) node.addOutput?.(name, type);
        const output = node.outputs?.[index];
        if (!output) continue;
        output.name = name;
        output.type = type;
        output.localized_name = name;
        if ("widget" in output) delete output.widget;
    }
    for (let index = (node.outputs || []).length - 1; index >= wantedOutputs.length; index--) {
        node.removeOutput?.(index);
    }
    node.graph?.setDirtyCanvas?.(true, true);
    const lengthWidget = widget(node, "length");
    if (lengthWidget && !Number.isFinite(Number(lengthWidget.value))) lengthWidget.value = 0;
    const sizeWidget = widget(node, "ref_image_size");
    if (sizeWidget && !["match", "max"].includes(String(sizeWidget.value))) sizeWidget.value = "max";
    const scopeWidget = widget(node, "selection_mode");
    if (scopeWidget && !["当前分镜", "勾选分镜", "从当前开始"].includes(String(scopeWidget.value))) scopeWidget.value = "当前分镜";
    const legacyPromptWidget = widget(node, "optimized_prompt");
    if (legacyPromptWidget) {
        if (legacyPromptWidget.element) legacyPromptWidget.element.remove();
        const widgetIndex = (node.widgets || []).indexOf(legacyPromptWidget);
        if (widgetIndex >= 0) node.widgets.splice(widgetIndex, 1);
    }
}

function hideWidget(item) {
    if (!item || item.__xdhV4Hidden) return;
    item.__xdhV4Hidden = true;
    item.type = "converted-widget";
    item.hidden = true;
    item.computeSize = () => [0, -4];
    item.draw = () => {};
    item.mouse = () => false;
    item.serializeValue = async () => item.value;
    if (item.element) item.element.style.display = "none";
}

function normalizeState(node) {
    const raw = widget(node, "studio_state")?.value || node.properties?.xiantuDigitalHumanStudio;
    let value = {};
    try { value = typeof raw === "string" ? JSON.parse(raw) : clone(raw || {}); } catch {}
    const source = Array.isArray(value?.storyboard?.shots) ? value.storyboard.shots : [];
    const shots = source.slice(0, 500).map((shot, index) => ({
        ...blankShot(index),
        ...shot,
        id: String(shot?.id || uid()),
        title: String(shot?.title || `分镜 ${String(index + 1).padStart(2, "0")}`),
        prompt: String(shot?.prompt || shot?.video_prompt || shot?.positive || ""),
        optimized_prompt: String(shot?.optimized_prompt || ""),
        images: (Array.isArray(shot?.images) ? shot.images : (shot?.image && typeof shot.image === "object" ? [shot.image] : [])).filter((item) => item && typeof item === "object").slice(0, 9),
        audio_range: { start: Math.max(0, Number(shot?.audio_range?.start ?? shot?.audio_trim?.start ?? 0)), end: Math.max(0, Number(shot?.audio_range?.end ?? shot?.audio_trim?.end ?? 0)) },
        duration_override: Math.max(0, Number(shot?.duration_override || 0)),
        selected: shot?.selected === true,
    }));
    if (!shots.length) shots.push(blankShot());
    const activeId = shots.some((shot) => shot.id === value.active_shot_id) ? value.active_shot_id : shots[0].id;
    const selectedIds = Array.isArray(value.selected_ids) ? value.selected_ids.map(String).filter((id) => shots.some((shot) => shot.id === id)) : shots.filter((shot) => shot.selected).map((shot) => shot.id);
    const legacyMusic = shots.map((shot) => shot?.audio).find((item) => item && typeof item === "object") || null;
    const resolution = value?.resolution && typeof value.resolution === "object" ? value.resolution : {};
    const musicDuration = Math.max(0, Number(value?.music_duration || 0));
    const legacyCuts = shots.slice(0, -1).map((shot) => Number(shot.audio_range?.end || 0));
    const audioCuts = (Array.isArray(value?.audio_cuts) ? value.audio_cuts : legacyCuts)
        .map(Number).filter((second) => Number.isFinite(second) && second > 0 && second < musicDuration)
        .sort((left, right) => left - right).filter((second, index, list) => index === 0 || Math.abs(second - list[index - 1]) > 0.001);
    const normalized = { version: 5, active_shot_id: activeId, selected_ids: selectedIds, music: value?.music && typeof value.music === "object" ? value.music : legacyMusic, music_duration: musicDuration, audio_cuts: audioCuts, selected_audio_segment: Math.max(0, Number(value?.selected_audio_segment || 0)), resolution: { aspect_ratio: String(resolution.aspect_ratio || "9:16"), megapixels: Number(resolution.megapixels || 0.6), multiple: Number(resolution.multiple || 32) }, storyboard: { version: 5, title: String(value?.storyboard?.title || "数字人项目"), shots }, expanded: value.expanded === true, timeline: value?.timeline };
    normalized.timeline = buildTimelineModel(normalized);
    return normalized;
}

function fileUrl(record) {
    if (!record?.name) return "";
    return api.apiURL(`/view?${new URLSearchParams({ filename: String(record.name), type: String(record.type || "input"), subfolder: String(record.subfolder || "") }).toString()}`);
}

function resolutionSize(resolution) {
    const ratios = { "9:16": [9, 16], "16:9": [16, 9], "1:1": [1, 1], "3:4": [3, 4], "4:3": [4, 3] };
    const [rw, rh] = ratios[resolution.aspect_ratio] || ratios["9:16"];
    const pixels = Math.max(0.1, Number(resolution.megapixels || 0.6)) * 1_000_000;
    const multiple = [8, 16, 32, 64].includes(Number(resolution.multiple)) ? Number(resolution.multiple) : 32;
    const width = Math.max(multiple, Math.round(Math.sqrt(pixels * rw / rh) / multiple) * multiple);
    const height = Math.max(multiple, Math.round(Math.sqrt(pixels * rh / rw) / multiple) * multiple);
    return [width, height];
}

async function mediaDuration(file) {
    return await new Promise((resolve) => {
        const url = URL.createObjectURL(file);
        const audio = new Audio();
        const done = (value) => { URL.revokeObjectURL(url); resolve(Number.isFinite(value) ? value : 0); };
        audio.onloadedmetadata = () => done(audio.duration);
        audio.onerror = () => done(0);
        audio.src = url;
    });
}

async function uploadMedia(file, kind) {
    const body = new FormData();
    body.append("image", file, file.name);
    body.append("type", "input");
    body.append("subfolder", `xiantu_digital_human/${kind}`);
    body.append("overwrite", "false");
    const response = await api.fetchApi("/upload/image", { method: "POST", body });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok || !data.name) throw new Error(data.error || `上传失败（HTTP ${response.status}）`);
    return { name: String(data.name), subfolder: String(data.subfolder || ""), type: "input", displayName: String(file.name), mimeType: String(file.type || ""), size: Number(file.size || 0) };
}

function timeLabel(seconds, precise = false) {
    const value = Math.max(0, Number(seconds || 0));
    const minutes = Math.floor(value / 60);
    const remain = value % 60;
    return `${minutes}:${precise ? remain.toFixed(2).padStart(5, "0") : String(Math.floor(remain)).padStart(2, "0")}`;
}

async function drawWaveform(canvas, url, trim, durationHint, boundaries = [], zoom = 1) {
    const drawId = (canvas.__xdhDrawId || 0) + 1;
    canvas.__xdhDrawId = drawId;
    try {
        const response = await fetch(url);
        const bytes = await response.arrayBuffer();
        const context = new (window.AudioContext || window.webkitAudioContext)();
        const buffer = await context.decodeAudioData(bytes.slice(0));
        if (canvas.__xdhDrawId !== drawId) { await context.close(); return null; }
        const samples = buffer.getChannelData(0);
        const viewportWidth = Math.max(420, Math.floor(canvas.closest(".xh3-wave-scroll")?.clientWidth || 420));
        const width = Math.floor(viewportWidth * Math.max(1, Number(zoom || 1)));
        const height = 94;
        const waveHeight = 70;
        canvas.width = width;
        canvas.height = height;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        const drawing = canvas.getContext("2d");
        drawing.clearRect(0, 0, width, height);
        const duration = Number(durationHint || buffer.duration || 0);
        const startX = duration ? Math.max(0, Math.min(width, Number(trim?.start || 0) / duration * width)) : 0;
        const endSeconds = Number(trim?.end || 0) > 0 ? Number(trim.end) : duration;
        const endX = duration ? Math.max(startX, Math.min(width, endSeconds / duration * width)) : width;
        drawing.fillStyle = "#15384b";
        drawing.fillRect(startX, 0, endX - startX, waveHeight);
        drawing.strokeStyle = "#58d2f3";
        drawing.lineWidth = 1;
        drawing.beginPath();
        const step = Math.max(1, Math.floor(samples.length / width));
        for (let x = 0; x < width; x++) {
            let peak = 0;
            const begin = x * step;
            for (let i = begin; i < Math.min(samples.length, begin + step); i++) peak = Math.max(peak, Math.abs(samples[i]));
            const amplitude = peak * (waveHeight * 0.44);
            drawing.moveTo(x, waveHeight / 2 - amplitude);
            drawing.lineTo(x, waveHeight / 2 + amplitude);
        }
        drawing.stroke();
        drawing.fillStyle = "#0d1b25";
        drawing.fillRect(0, waveHeight, width, height - waveHeight);
        const rawTick = duration / Math.max(1, width / 90);
        const power = 10 ** Math.floor(Math.log10(Math.max(0.01, rawTick)));
        const normalized = rawTick / power;
        const tick = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * power;
        drawing.font = '9px "Microsoft YaHei", sans-serif';
        drawing.textAlign = "center";
        drawing.textBaseline = "bottom";
        for (let second = 0; second <= duration + 0.0001; second += tick) {
            const x = duration ? second / duration * width : 0;
            drawing.strokeStyle = "#527087";
            drawing.lineWidth = 1;
            drawing.beginPath(); drawing.moveTo(x, waveHeight); drawing.lineTo(x, waveHeight + 6); drawing.stroke();
            drawing.fillStyle = "#8ea6b8";
            drawing.fillText(timeLabel(second, tick < 1), Math.max(18, Math.min(width - 18, x)), height - 2);
        }
        await context.close();
        return { width, height, duration };
    } catch { return null; }
}

function createV4Workbench(node) {
    ensureStyles();
    const names = ["studio_state", "selection_mode", "length", "ref_image_size"];
    const widgets = Object.fromEntries(names.map((name) => [name, widget(node, name)]));
    Object.values(widgets).forEach(hideWidget);
    let state = normalizeState(node);
    let uploading = false;
    let waveformZoom = 1;
    let pinnedTime = 0;
    let waveformScrollLeft = 0;
    let timelineTool = "select";
    let snapEnabled = state.timeline?.snap !== false;
    let selectedCutIndex = -1;
    const cutHistory = [];

    const initialShot = state.storyboard.shots.find((shot) => shot.id === state.active_shot_id);
    if (initialShot && !initialShot.optimized_prompt && widgets.optimized_prompt?.value) initialShot.optimized_prompt = String(widgets.optimized_prompt.value);

    const root = document.createElement("div");
    root.className = "xh3 xdh-v4";
    root.tabIndex = 0;
    root.innerHTML = `
      <div class="xh3-head"><span class="xh3-logo">闲兔数字人工作台</span><span class="xh3-badge">MiniMax H3 · 数字人</span><span class="xh3-spacer"></span><span class="xh3-state"><i class="xh3-dot"></i><span data-head-state>独立分镜工作台</span></span></div>
      <div class="xh3-body">
        <section class="xh3-storybar"><div class="xh3-story-title"><strong>分镜</strong><span data-count>1 个</span><button class="xh3-add-shot primary" data-add>＋ 增加分镜</button></div><div class="xh3-shot-list" data-shot-list></div><div class="xh3-story-actions"><button data-toggle>展开分镜</button><button data-select-all>全选</button><span class="xh3-story-spacer"></span><button data-left title="上一分镜">←</button><button data-right title="下一分镜">→</button><button data-copy>复制分镜</button><button class="danger" data-delete>删除分镜</button><label class="xh3-inline-field"><span>生成范围</span><select data-scope><option>当前分镜</option><option>勾选分镜</option><option>从当前开始</option></select></label></div></section>
        <div class="xh3-settings"><label class="xh3-control"><span>宽高比</span><select data-resolution="aspect_ratio"><option>9:16</option><option>16:9</option><option>1:1</option><option>3:4</option><option>4:3</option></select></label><label class="xh3-control"><span>百万像素</span><select data-resolution="megapixels"><option value="0.3">0.3</option><option value="0.6">0.6</option><option value="1">1.0</option><option value="2">2.0</option></select></label><label class="xh3-control"><span>multiple</span><select data-resolution="multiple"><option>8</option><option>16</option><option>32</option><option>64</option></select></label><label class="xh3-control"><span>计算尺寸</span><input data-resolution-size disabled></label></div>
        <section class="xh3-card" style="margin-top:9px"><div class="xh3-card-head">完整音乐音轨 <small data-music-duration>未上传</small></div><div class="xh3-media" data-audio-area></div><input type="file" accept="audio/*,.wav,.mp3,.flac,.m4a,.aac,.ogg" hidden data-audio-file></section>
        <div class="xh3-media-grid"><section class="xh3-card"><div class="xh3-card-head"><span>当前分镜参考图 <small>最多 9 张</small></span><label class="xh3-inline-field"><span>参考图尺寸</span><select data-ref-image-size><option value="max">最大</option><option value="match">匹配</option></select></label></div><div class="xh3-media" data-image-area></div><input type="file" accept="image/*" multiple hidden data-image-file></section><section class="xh3-card"><div class="xh3-card-head">当前分镜音频段 <small>不指定时长则自动跟随音频段</small></div><div class="xh3-media" data-segment-area></div></section></div>
        <div class="xh3-prompt-grid"><section class="xh3-prompt"><div class="xh3-prompt-head">优化前提示词 <span>发送给 Qwen H3 Prompt</span></div><textarea data-prompt placeholder="填写当前数字人的动作、表情、说话状态、镜头和环境要求……"></textarea></section><section class="xh3-prompt optimized"><div class="xh3-prompt-head">优化后提示词 <span>条件与 LATENT 只使用这一项</span></div><textarea data-optimized-prompt placeholder="连接左侧 optimized_prompt 接口后由 Qwen 提供；也可在这里手动填写……"></textarea></section></div>
        <footer class="xh3-footer"><span data-status>分镜 01 等待编辑</span><span class="xh3-spacer"></span><strong>本体输出：条件 · LATENT · 图像 · 音频 · 秒数 · 预览帧</strong></footer>
      </div>`;

    const q = (selector) => root.querySelector(selector);
    const shots = () => state.storyboard.shots;
    const activeIndex = () => Math.max(0, shots().findIndex((shot) => shot.id === state.active_shot_id));
    const current = () => shots()[activeIndex()];
    const audioSegments = () => {
        const duration = Math.max(0, Number(state.music_duration || 0));
        const cuts = (state.audio_cuts || []).filter((second) => second > 0 && second < duration).sort((a, b) => a - b);
        const boundaries = [0, ...cuts, duration];
        return boundaries.slice(0, -1).map((start, index) => ({ start, end: boundaries[index + 1] }));
    };
    const matchingShot = (segment) => shots().find((shot) => Math.abs(Number(shot.audio_range?.start || 0) - segment.start) < 0.02 && Math.abs(Number(shot.audio_range?.end || 0) - segment.end) < 0.02);

    function persist() {
        shots().forEach((shot) => { shot.selected = state.selected_ids.includes(shot.id); });
        state.timeline = { ...(state.timeline || {}), tool: timelineTool, snap: snapEnabled };
        state.timeline = buildTimelineModel(state);
        if (widgets.optimized_prompt) widgets.optimized_prompt.value = current().optimized_prompt || "";
        if (widgets.studio_state) widgets.studio_state.value = JSON.stringify(state);
        node.properties ??= {};
        node.properties.xiantuDigitalHumanStudio = clone(state);
        node.graph?.setDirtyCanvas(true, true);
        window.dispatchEvent(new CustomEvent("xiantu:digital-human-state", { detail: { nodeId: String(node.id), state: clone(state) } }));
    }

    function setActive(index) {
        if (!shots().length) return;
        const bounded = Math.max(0, Math.min(shots().length - 1, index));
        state.active_shot_id = shots()[bounded].id;
        persist();
        render();
    }

    function renderShots() {
        const box = q("[data-shot-list]");
        box.replaceChildren();
        shots().forEach((shot, index) => {
            const card = document.createElement("div");
            card.className = "xh3-shot";
            card.classList.toggle("active", shot.id === state.active_shot_id);
            card.classList.toggle("selected", state.selected_ids.includes(shot.id));
            const seconds = Math.max(0, Number(shot.audio_range?.end || 0) - Number(shot.audio_range?.start || 0));
            const media = [`图${shot.images.length}/9`, state.music ? `音频${seconds.toFixed(2)}秒` : "音轨—"].join(" · ");
            card.innerHTML = `<b>${String(index + 1).padStart(2, "0")} · ${shot.title}</b><small>${media}</small><input type="checkbox" ${state.selected_ids.includes(shot.id) ? "checked" : ""}>`;
            card.onclick = () => setActive(index);
            const checkbox = card.querySelector("input");
            checkbox.onclick = (event) => event.stopPropagation();
            checkbox.onchange = () => { state.selected_ids = checkbox.checked ? [...new Set([...state.selected_ids, shot.id])] : state.selected_ids.filter((id) => id !== shot.id); persist(); render(); };
            box.appendChild(card);
        });
    }

    function renderImage() {
        const box = q("[data-image-area]");
        const shot = current();
        box.replaceChildren();
        box.classList.add("xh3-image-grid");
        if (!shot.images.length) {
            const drop = document.createElement("div");
            drop.className = "xh3-drop";
            drop.style.gridColumn = "1 / -1";
            drop.innerHTML = `<div><b>＋ 上传数字人参考图</b><small>可多选或拖放，当前分镜最多 9 张</small></div>`;
            drop.onclick = () => !uploading && q("[data-image-file]").click();
            drop.ondragover = (event) => event.preventDefault();
            drop.ondrop = (event) => { event.preventDefault(); const files = [...(event.dataTransfer?.files || [])].filter((item) => item.type.startsWith("image/")); if (files.length) handleUpload(files, "image"); };
            box.appendChild(drop);
            return;
        }
        shot.images.forEach((record, index) => {
            const item = document.createElement("div");
            item.className = "xh3-image-item";
            item.title = record.displayName || record.name;
            item.innerHTML = `<img src="${fileUrl(record)}" alt="参考图 ${index + 1}"><b>图 ${index + 1}</b><button class="danger" title="删除">×</button>`;
            item.querySelector("button").onclick = () => { shot.images.splice(index, 1); persist(); render(); };
            box.appendChild(item);
        });
        if (shot.images.length < 9) {
            const add = document.createElement("div");
            add.className = "xh3-image-add";
            add.innerHTML = `<span>＋ 添加<br>${shot.images.length}/9</span>`;
            add.onclick = () => !uploading && q("[data-image-file]").click();
            add.ondragover = (event) => event.preventDefault();
            add.ondrop = (event) => { event.preventDefault(); const files = [...(event.dataTransfer?.files || [])].filter((item) => item.type.startsWith("image/")); if (files.length) handleUpload(files, "image"); };
            box.appendChild(add);
        }
    }

    function renderAudio() {
        const box = q("[data-audio-area]");
        box.replaceChildren();
        q("[data-music-duration]").textContent = state.music ? `${state.music_duration.toFixed(2)} 秒` : "未上传";
        if (!state.music) {
            const drop = document.createElement("div");
            drop.className = "xh3-drop";
            drop.innerHTML = `<div><b>＋ 上传完整音乐</b><small>上传几分钟的总音轨，再从播放点切分并建立分镜</small></div>`;
            drop.onclick = () => !uploading && q("[data-audio-file]").click();
            drop.ondragover = (event) => event.preventDefault();
            drop.ondrop = (event) => { event.preventDefault(); const file = [...(event.dataTransfer?.files || [])].find((item) => item.type.startsWith("audio/")); if (file) handleUpload(file, "audio"); };
            box.appendChild(drop);
            return;
        }
        const wrap = document.createElement("div");
        wrap.className = "xh3-audio-ready";
        const range = current().audio_range || { start: 0, end: state.music_duration };
        wrap.innerHTML = `<div class="xh3-wave-tools"><button class="xh3-tool active" data-tool-select title="左键只负责选择和定位">↖ 选择</button><button data-split title="在播放头位置切分">✂ 切分游标</button><button data-delete-cut ${selectedCutIndex >= 0 ? "" : "disabled"}>删除切点</button><button class="danger" data-delete-segment>删除片段</button><button data-undo ${cutHistory.length ? "" : "disabled"}>↶ 撤销</button><button class="xh3-snap ${snapEnabled ? "active" : ""}" data-snap title="吸附到 24 FPS 帧和已有切点（N）">吸附</button><span class="xh3-spacer"></span><span class="xh3-zoom-group"><span>放大</span><input data-wave-zoom type="range" min="1" max="20" step="1" value="${waveformZoom}"><b data-wave-zoom-label>${waveformZoom}×</b></span><span class="xh3-wave-time" data-wave-time>${timeLabel(pinnedTime, true)}</span></div><div class="xh3-wave-scroll" data-wave-scroll><div class="xh3-wave-content" data-wave-content><canvas class="xh3-wave" data-wave tabindex="0"></canvas><span class="xh3-track-tag audio">A1 音频</span><div class="xh3-segment-strip" data-segment-strip></div><span class="xh3-track-tag story">V1 分镜</span><div class="xh3-wave-line xh3-hover-line" data-hover-line><span></span></div><div class="xh3-wave-line xh3-playhead-line" data-playhead-line><span></span></div><div data-cut-handles></div></div></div><audio controls preload="metadata" data-player src="${fileUrl(state.music)}"></audio><div class="xh3-file-name">${state.music.displayName || state.music.name} · 总时长 ${state.music_duration.toFixed(2)} 秒 · 当前分镜 ${Number(range.start || 0).toFixed(2)}～${Number(range.end || state.music_duration).toFixed(2)} 秒</div><div class="xh3-media-actions"><button data-jump>跳到当前分镜</button><button data-clear-cuts>清除全部切点</button><button data-replace>替换完整音乐</button><button class="danger" data-remove>删除完整音乐</button></div>`;
        const player = wrap.querySelector("[data-player]");
        const canvas = wrap.querySelector("[data-wave]");
        const scroll = wrap.querySelector("[data-wave-scroll]");
        const content = wrap.querySelector("[data-wave-content]");
        const hoverLine = wrap.querySelector("[data-hover-line]");
        const playheadLine = wrap.querySelector("[data-playhead-line]");
        const duration = Math.max(0.001, Number(state.music_duration || 0));
        const snapTime = (second, excludedCut = -1) => {
            const raw = Math.max(0, Math.min(duration, Number(second || 0)));
            if (!snapEnabled) return raw;
            const frame = Math.round(raw * 24) / 24;
            const candidates = state.audio_cuts || [];
            let closest = frame;
            let distance = Math.abs(frame - raw);
            candidates.forEach((candidate, index) => { if (index !== excludedCut && Math.abs(candidate - raw) < Math.min(0.08, distance)) { closest = candidate; distance = Math.abs(candidate - raw); } });
            return closest;
        };
        const positionLine = (line, second) => {
            const safe = Math.max(0, Math.min(duration, Number(second || 0)));
            line.style.left = `${safe / duration * 100}%`;
            line.querySelector("span").textContent = timeLabel(safe, true);
        };
        const selectSegment = (segment, index) => {
            waveformScrollLeft = scroll.scrollLeft;
            state.selected_audio_segment = index;
            const assigned = matchingShot(segment);
            if (assigned) state.active_shot_id = assigned.id;
            selectedCutIndex = -1;
            pinnedTime = Number(segment.start || 0);
            persist();
            render();
            q("[data-status]").textContent = `已选择音频切块 ${index + 1}：${timeLabel(segment.start, true)} ～ ${timeLabel(segment.end, true)}${assigned ? ` · 已绑定 ${assigned.title}` : " · 未绑定分镜"}`;
        };
        const renderOverlays = () => {
            const strip = wrap.querySelector("[data-segment-strip]");
            const handles = wrap.querySelector("[data-cut-handles]");
            strip.replaceChildren();
            handles.replaceChildren();
            const segments = audioSegments();
            segments.forEach((segment, index) => {
                const start = Math.max(0, Number(segment.start || 0));
                const end = Math.min(duration, Number(segment.end || duration));
                const assigned = matchingShot(segment);
                const block = document.createElement("div");
                block.className = `xh3-segment${index === Number(state.selected_audio_segment || 0) ? " active" : ""}`;
                block.style.left = `${start / duration * 100}%`;
                block.style.width = `${Math.max(0.001, end - start) / duration * 100}%`;
                block.textContent = `${index + 1} · ${timeLabel(end - start, true)}${assigned ? ` · ${assigned.title}` : " · 未设分镜"}`;
                block.title = `音频切块 ${index + 1}：${timeLabel(start, true)} ～ ${timeLabel(end, true)}；单击选择后可手动增加分镜`;
                block.tabIndex = 0;
                block.onclick = (event) => { event.stopPropagation(); selectSegment(segment, index); };
                block.onkeydown = (event) => { if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); event.stopPropagation(); selectSegment(segment, index); requestAnimationFrame(deleteCurrentSegment); } };
                strip.appendChild(block);
            });
            for (let index = 0; index < (state.audio_cuts || []).length; index++) {
                const original = Number(state.audio_cuts[index] || 0);
                const handle = document.createElement("div");
                const active = index === Number(state.selected_audio_segment || 0) || index + 1 === Number(state.selected_audio_segment || 0);
                handle.className = `xh3-cut-handle${active ? " active" : ""}${selectedCutIndex === index ? " selected" : ""}`;
                handle.style.left = `${original / duration * 100}%`;
                handle.innerHTML = `<span>${timeLabel(original, true)}</span>`;
                handle.title = "左右拖动调整切点；双击取消切分并合并两块";
                handle.ondblclick = (event) => { event.stopPropagation(); mergeAt(index); };
                handle.onpointerdown = (event) => {
                    event.preventDefault(); event.stopPropagation();
                    selectedCutIndex = index;
                    handle.setPointerCapture?.(event.pointerId);
                    handle.classList.add("dragging");
                    const lower = Number(index > 0 ? state.audio_cuts[index - 1] : 0) + 0.02;
                    const upper = Number(index + 1 < state.audio_cuts.length ? state.audio_cuts[index + 1] : duration) - 0.02;
                    let value = original;
                    const move = (moveEvent) => {
                        const rect = content.getBoundingClientRect();
                        value = snapTime(Math.max(lower, Math.min(upper, (moveEvent.clientX - rect.left) / rect.width * duration)), index);
                        handle.style.left = `${value / duration * 100}%`;
                        handle.querySelector("span").textContent = timeLabel(value, true);
                        pinnedTime = value; player.currentTime = value; positionLine(playheadLine, value);
                        wrap.querySelector("[data-wave-time]").textContent = timeLabel(value, true);
                    };
                    const up = () => {
                        handle.classList.remove("dragging");
                        window.removeEventListener("pointermove", move);
                        window.removeEventListener("pointerup", up);
                        waveformScrollLeft = scroll.scrollLeft;
                        rememberTimelineEdit();
                        for (const shot of shots()) {
                            if (Math.abs(Number(shot.audio_range?.end || 0) - original) < 0.02) shot.audio_range.end = value;
                            if (Math.abs(Number(shot.audio_range?.start || 0) - original) < 0.02) shot.audio_range.start = value;
                        }
                        state.audio_cuts[index] = value;
                        persist(); render();
                    };
                    window.addEventListener("pointermove", move);
                    window.addEventListener("pointerup", up, { once: true });
                };
                handles.appendChild(handle);
            }
            positionLine(playheadLine, pinnedTime);
        };
        let lastViewportWidth = 0;
        const redraw = async (anchorTime = null) => {
            const viewportWidth = Math.max(1, Math.floor(scroll.clientWidth));
            const result = await drawWaveform(canvas, fileUrl(state.music), current().audio_range, duration, [], waveformZoom);
            if (!result || !content.isConnected) return;
            content.style.width = `${result.width}px`;
            scroll.style.overflowX = waveformZoom > 1 ? "auto" : "hidden";
            if (waveformZoom <= 1) waveformScrollLeft = 0;
            lastViewportWidth = viewportWidth;
            renderOverlays();
            if (anchorTime !== null) scroll.scrollLeft = Math.max(0, anchorTime / duration * result.width - scroll.clientWidth / 2);
            else scroll.scrollLeft = waveformScrollLeft;
        };
        const resizeObserver = new ResizeObserver(() => {
            if (!content.isConnected) { resizeObserver.disconnect(); return; }
            const nextWidth = Math.max(1, Math.floor(scroll.clientWidth));
            if (Math.abs(nextWidth - lastViewportWidth) > 1) requestAnimationFrame(() => redraw());
        });
        resizeObserver.observe(scroll);
        const pointerSeconds = (event) => {
            const rect = content.getBoundingClientRect();
            return Math.max(0, Math.min(duration, (event.clientX - rect.left) / rect.width * duration));
        };
        canvas.onmousemove = (event) => { const second = pointerSeconds(event); hoverLine.style.display = "block"; positionLine(hoverLine, second); wrap.querySelector("[data-wave-time]").textContent = timeLabel(second, true); canvas.title = `${timeLabel(second, true)} · 左键选择/定位`; };
        canvas.onmouseleave = () => { hoverLine.style.display = "none"; wrap.querySelector("[data-wave-time]").textContent = timeLabel(pinnedTime, true); };
        canvas.onclick = (event) => {
            const second = pointerSeconds(event);
            const segments = audioSegments();
            const index = segments.findIndex((segment) => second >= segment.start && second <= segment.end);
            pinnedTime = second;
            player.currentTime = second;
            waveformScrollLeft = scroll.scrollLeft;
            if (index >= 0) {
                state.selected_audio_segment = index;
                const assigned = matchingShot(segments[index]);
                if (assigned) state.active_shot_id = assigned.id;
            }
            persist(); render();
            q("[data-status]").textContent = `已定位 ${timeLabel(second, true)}${index >= 0 ? `，选择切块 ${index + 1}` : ""}`;
        };
        player.ontimeupdate = () => { if (!player.seeking && !player.paused) { pinnedTime = Number(player.currentTime || 0); positionLine(playheadLine, pinnedTime); wrap.querySelector("[data-wave-time]").textContent = timeLabel(pinnedTime, true); } };
        scroll.onscroll = () => { waveformScrollLeft = scroll.scrollLeft; };
        wrap.querySelector("[data-wave-zoom]").oninput = async (event) => { const centerTime = (scroll.scrollLeft + scroll.clientWidth / 2) / Math.max(1, content.scrollWidth) * duration; waveformZoom = Number(event.target.value || 1); wrap.querySelector("[data-wave-zoom-label]").textContent = `${waveformZoom}×`; await redraw(centerTime); };
        wrap.querySelector("[data-undo]").onclick = undoCut;
        wrap.querySelector("[data-split]").onclick = () => splitAt(snapTime(Number(pinnedTime || player.currentTime || 0)));
        wrap.querySelector("[data-delete-cut]").onclick = () => mergeAt(selectedCutIndex);
        wrap.querySelector("[data-snap]").onclick = () => { snapEnabled = !snapEnabled; persist(); render(); };
        wrap.querySelector("[data-jump]").onclick = () => { pinnedTime = Number(current().audio_range?.start || 0); player.currentTime = pinnedTime; positionLine(playheadLine, pinnedTime); };
        wrap.querySelector("[data-delete-segment]").onclick = deleteCurrentSegment;
        wrap.querySelector("[data-clear-cuts]").onclick = clearAllCuts;
        wrap.querySelector("[data-replace]").onclick = () => q("[data-audio-file]").click();
        wrap.querySelector("[data-remove]").onclick = () => { state.music = null; state.music_duration = 0; state.audio_cuts = []; state.selected_audio_segment = 0; shots().forEach((shot) => { shot.audio_range = { start: 0, end: 0 }; }); persist(); render(); };
        box.appendChild(wrap);
        requestAnimationFrame(redraw);
    }

    function renderSegment() {
        const box = q("[data-segment-area]");
        if (!state.music) { box.innerHTML = `<div class="xh3-drop"><div><b>等待完整音乐</b><small>上传音乐后，在音轨播放点切分并新增分镜</small></div></div>`; return; }
        const shot = current();
        const range = shot.audio_range || { start: 0, end: state.music_duration };
        const automatic = Math.max(0, Number(range.end || 0) - Number(range.start || 0));
        box.innerHTML = `<div class="xh3-audio-ready"><div class="xh3-trim"><label>开始秒<input data-range-start type="number" min="0" step="0.01" value="${Number(range.start || 0).toFixed(2)}"></label><label>结束秒<input data-range-end type="number" min="0" step="0.01" value="${Number(range.end || state.music_duration || 0).toFixed(2)}"></label></div><label class="xh3-control" style="padding:0;border:0;background:none"><span style="font-size:8px">指定视频时长（秒，0 = 自动使用本段 ${automatic.toFixed(2)} 秒）</span><input data-duration-override type="number" min="0" max="3600" step="0.01" value="${Number(shot.duration_override || 0).toFixed(2)}"></label><label class="xh3-control" style="margin-top:7px;padding:0;border:0;background:none"><span style="font-size:8px">H3 帧数 length（0 = 根据时长自动按 24 FPS 对齐到 17n+5）</span><input data-h3-length type="number" min="0" max="3600" step="1" value="${Math.max(0, Number(widgets.length?.value || 0))}"></label><div class="xh3-file-name" style="font-size:8px">实际输出：${Number(shot.duration_override || automatic).toFixed(2)} 秒</div><div class="xh3-media-actions"><button data-apply-range>应用分段范围</button></div></div>`;
        const apply = () => {
            const start = Math.max(0, Number(box.querySelector("[data-range-start]").value || 0));
            const end = Math.min(state.music_duration || Number.MAX_SAFE_INTEGER, Number(box.querySelector("[data-range-end]").value || 0));
            if (end <= start) { q("[data-status]").textContent = "分段结束必须大于开始"; return; }
            shot.audio_range = { start, end };
            shot.duration_override = Math.max(0, Number(box.querySelector("[data-duration-override]").value || 0));
            if (widgets.length) widgets.length.value = Math.max(0, Math.round(Number(box.querySelector("[data-h3-length]").value || 0)));
            persist(); render();
        };
        box.querySelector("[data-apply-range]").onclick = apply;
        box.querySelector("[data-duration-override]").onchange = apply;
        box.querySelector("[data-h3-length]").onchange = apply;
    }

    function rememberTimelineEdit() {
        cutHistory.push({ shots: clone(shots()), audioCuts: clone(state.audio_cuts || []), selectedSegment: Number(state.selected_audio_segment || 0), activeId: state.active_shot_id, selectedIds: clone(state.selected_ids) });
        if (cutHistory.length > 50) cutHistory.shift();
    }

    function undoCut() {
        const previous = cutHistory.pop();
        if (!previous) return;
        state.storyboard.shots = previous.shots;
        state.audio_cuts = previous.audioCuts || [];
        state.selected_audio_segment = previous.selectedSegment || 0;
        state.active_shot_id = previous.activeId;
        state.selected_ids = previous.selectedIds;
        selectedCutIndex = -1;
        persist(); render();
        q("[data-status]").textContent = "已撤销上一次音轨切分/合并";
    }

    function mergeAt(index) {
        if (index < 0 || index >= (state.audio_cuts || []).length) return;
        rememberTimelineEdit();
        const removed = Number(state.audio_cuts[index]);
        const segments = audioSegments();
        const mergedStart = segments[index]?.start ?? 0;
        const mergedEnd = segments[index + 1]?.end ?? state.music_duration;
        for (const shot of shots()) {
            if (Math.abs(Number(shot.audio_range?.end || 0) - removed) < 0.02) shot.audio_range.end = mergedEnd;
            if (Math.abs(Number(shot.audio_range?.start || 0) - removed) < 0.02) shot.audio_range.start = mergedStart;
        }
        state.audio_cuts.splice(index, 1);
        state.selected_audio_segment = Math.min(index, Math.max(0, audioSegments().length - 1));
        selectedCutIndex = -1;
        persist(); render();
        q("[data-status]").textContent = `已取消切点并合并为切块 ${index + 1}`;
    }

    function deleteCurrentSegment() {
        const segments = audioSegments();
        if (segments.length <= 1) { q("[data-status]").textContent = "整条音轨只剩一个切块，不能再删除"; return; }
        const index = Math.min(Number(state.selected_audio_segment || 0), segments.length - 1);
        mergeAt(index < segments.length - 1 ? index : index - 1);
    }

    function clearAllCuts() {
        if (!(state.audio_cuts || []).length) return;
        if (!window.confirm(`确认清除全部 ${state.audio_cuts.length} 个切点？已有分镜保留。`)) return;
        rememberTimelineEdit();
        state.audio_cuts = [];
        state.selected_audio_segment = 0;
        selectedCutIndex = -1;
        persist(); render();
        q("[data-status]").textContent = "已清除全部切点，恢复为完整音轨";
    }

    function splitAt(time) {
        if (!state.music || state.music_duration <= 0) { q("[data-status]").textContent = "请先上传完整音乐"; return; }
        const segments = audioSegments();
        const index = segments.findIndex((segment) => time > segment.start + 0.02 && time < segment.end - 0.02);
        if (index < 0) { q("[data-status]").textContent = "该位置已经是切点，或不在有效音频段内"; return; }
        const { start, end } = segments[index];
        if (time <= start + 0.02 || time >= end - 0.02) { q("[data-status]").textContent = "播放点必须位于当前分镜音频段内部"; return; }
        rememberTimelineEdit();
        for (const shot of shots()) {
            if (Math.abs(Number(shot.audio_range?.start || 0) - start) < 0.02 && Math.abs(Number(shot.audio_range?.end || 0) - end) < 0.02) shot.audio_range.end = time;
        }
        state.audio_cuts.push(time);
        state.audio_cuts.sort((left, right) => left - right);
        state.selected_audio_segment = index;
        selectedCutIndex = index;
        persist(); render();
        q("[data-status]").textContent = `已切成 ${audioSegments().length} 个音频块；分镜仍为 ${shots().length} 个，请选择切块后手动增加分镜`;
    }

    function render() {
        root.classList.toggle("expanded", state.expanded);
        q("[data-count]").textContent = `${shots().length} 个`;
        q("[data-head-state]").textContent = `${shots().length} 个分镜 · 当前 ${activeIndex() + 1}`;
        q("[data-toggle]").textContent = state.expanded ? "收起分镜" : "展开分镜";
        q("[data-select-all]").textContent = shots().every((shot) => state.selected_ids.includes(shot.id)) ? "取消全选" : "全选";
        q("[data-scope]").value = widgets.selection_mode?.value || "当前分镜";
        q("[data-prompt]").value = current().prompt || "";
        q("[data-optimized-prompt]").value = current().optimized_prompt || "";
        q("[data-ref-image-size]").value = widgets.ref_image_size?.value || "max";
        for (const field of root.querySelectorAll("[data-resolution]")) field.value = String(state.resolution[field.dataset.resolution]);
        const [width, height] = resolutionSize(state.resolution);
        q("[data-resolution-size]").value = `${width} × ${height}`;
        const range = current().audio_range || { start: 0, end: 0 };
        q("[data-status]").textContent = `${current().title} · 参考图 ${current().images.length}/9 · 音频 ${Number(range.start || 0).toFixed(2)}～${Number(range.end || 0).toFixed(2)} 秒`;
        renderShots();
        renderImage();
        renderAudio();
        renderSegment();
    }

    async function handleUpload(input, kind) {
        if (uploading || !input) return;
        const files = kind === "image" ? [...input].slice(0, Math.max(0, 9 - current().images.length)) : [input];
        if (!files.length) { q("[data-status]").textContent = "每个分镜最多 9 张参考图"; return; }
        uploading = true;
        q("[data-status]").textContent = `正在上传${kind === "image" ? `${files.length} 张参考图` : "音乐音轨"}`;
        try {
            if (kind === "image") {
                for (const file of files) current().images.push(await uploadMedia(file, kind));
            } else {
                const file = files[0];
                state.music = await uploadMedia(file, kind);
                state.music_duration = await mediaDuration(file);
                state.audio_cuts = [];
                state.selected_audio_segment = 0;
                if (shots().length === 1) current().audio_range = { start: 0, end: state.music_duration };
                else shots().forEach((shot, index) => { if (Number(shot.audio_range?.end || 0) <= Number(shot.audio_range?.start || 0)) shot.audio_range = { start: index ? Number(shots()[index - 1].audio_range?.end || 0) : 0, end: state.music_duration }; });
            }
            persist();
            render();
        } catch (error) {
            q("[data-status]").textContent = String(error?.message || error);
        } finally {
            uploading = false;
        }
    }

    q("[data-add]").onclick = () => {
        const segments = audioSegments();
        if (state.music && segments.length) {
            const index = Math.min(Number(state.selected_audio_segment || 0), segments.length - 1);
            const segment = segments[index];
            const existing = matchingShot(segment);
            if (existing) { state.active_shot_id = existing.id; persist(); render(); q("[data-status]").textContent = `音频切块 ${index + 1} 已绑定 ${existing.title}`; return; }
            const shot = blankShot(shots().length);
            shot.audio_range = { start: segment.start, end: segment.end };
            shots().push(shot);
            state.active_shot_id = shot.id;
            persist(); render();
            q("[data-status]").textContent = `已为音频切块 ${index + 1} 手动增加 ${shot.title}`;
            return;
        }
        const shot = blankShot(shots().length);
        shots().push(shot);
        state.active_shot_id = shot.id;
        persist(); render();
    };
    q("[data-toggle]").onclick = () => { state.expanded = !state.expanded; persist(); render(); };
    q("[data-select-all]").onclick = () => { const all = shots().every((shot) => state.selected_ids.includes(shot.id)); state.selected_ids = all ? [] : shots().map((shot) => shot.id); persist(); render(); };
    q("[data-left]").onclick = () => setActive(activeIndex() - 1);
    q("[data-right]").onclick = () => setActive(activeIndex() + 1);
    q("[data-copy]").onclick = () => { const source = clone(current()); source.id = uid(); source.title = `${current().title} 副本`; source.selected = false; shots().splice(activeIndex() + 1, 0, source); state.active_shot_id = source.id; persist(); render(); };
    q("[data-delete]").onclick = () => { if (shots().length === 1) { const replacement = blankShot(); const segment = audioSegments()[Number(state.selected_audio_segment || 0)]; if (segment) replacement.audio_range = { ...segment }; state.storyboard.shots = [replacement]; state.active_shot_id = replacement.id; state.selected_ids = []; } else { const index = activeIndex(); const [removed] = shots().splice(index, 1); state.selected_ids = state.selected_ids.filter((id) => id !== removed.id); state.active_shot_id = shots()[Math.min(index, shots().length - 1)].id; } persist(); render(); };
    q("[data-scope]").onchange = (event) => { if (widgets.selection_mode) widgets.selection_mode.value = event.target.value; persist(); render(); };
    q("[data-prompt]").oninput = (event) => { current().prompt = event.target.value; persist(); };
    q("[data-optimized-prompt]").oninput = (event) => { current().optimized_prompt = event.target.value; if (widgets.optimized_prompt) widgets.optimized_prompt.value = event.target.value; persist(); };
    q("[data-ref-image-size]").onchange = (event) => { if (widgets.ref_image_size) widgets.ref_image_size.value = event.target.value; persist(); };
    root.querySelectorAll("[data-resolution]").forEach((field) => field.onchange = () => { const key = field.dataset.resolution; state.resolution[key] = key === "aspect_ratio" ? field.value : Number(field.value); persist(); render(); });
    q("[data-image-file]").onchange = (event) => { const files = [...(event.target.files || [])]; event.target.value = ""; if (files.length) handleUpload(files, "image"); };
    q("[data-audio-file]").onchange = (event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) handleUpload(file, "audio"); };
    root.__xdhV4Sync = () => { state = normalizeState(node); render(); };
    persist();
    render();
    return root;
}

function setupIndependentOutput(node, type) {
    node.title = OUTPUT_NODE_TITLES[type];
    const stateWidget = widget(node, "studio_state");
    hideWidget(stateWidget);
    const applyState = (source, sourceId = "") => {
        if (!source || !stateWidget) return;
        stateWidget.value = JSON.stringify(source);
        node.properties ??= {};
        node.properties.xiantuDigitalHumanSourceId = String(sourceId || node.properties.xiantuDigitalHumanSourceId || "");
        node.properties.xiantuDigitalHumanStudio = clone(source);
        node.graph?.setDirtyCanvas(true, true);
    };
    const nearestWorkbench = () => (app.graph?._nodes || [])
        .filter((item) => String(item?.comfyClass || item?.type || "") === NODE_NAME)
        .sort((left, right) => Math.abs(Number(left.pos?.[0] || 0) - Number(node.pos?.[0] || 0)) - Math.abs(Number(right.pos?.[0] || 0) - Number(node.pos?.[0] || 0)))[0];
    const syncNearest = () => {
        const source = nearestWorkbench();
        if (source?.properties?.xiantuDigitalHumanStudio) applyState(source.properties.xiantuDigitalHumanStudio, source.id);
    };
    const listener = (event) => {
        const assigned = String(node.properties?.xiantuDigitalHumanSourceId || "");
        if (assigned && assigned !== String(event.detail?.nodeId || "")) return;
        applyState(event.detail?.state, event.detail?.nodeId);
    };
    window.addEventListener("xiantu:digital-human-state", listener);
    const previousConfigure = node.onConfigure;
    node.onConfigure = function () { previousConfigure?.apply(this, arguments); this.title = OUTPUT_NODE_TITLES[type]; requestAnimationFrame(syncNearest); };
    const previousRemoved = node.onRemoved;
    node.onRemoved = function () { window.removeEventListener("xiantu:digital-human-state", listener); previousRemoved?.apply(this, arguments); };
    for (const delay of [0, 200, 800]) setTimeout(syncNearest, delay);
    requestAnimationFrame(() => node.setSize?.([240, 80]));
}

app.registerExtension({
    name: "Xiantu.DigitalHumanV4",
    async nodeCreated(node) {
        const type = String(node.comfyClass || node.type || "");
        if (OUTPUT_NODE_TITLES[type]) { setupIndependentOutput(node, type); return; }
        if (type !== NODE_NAME) return;
        migrateLegacyStudioNode(node);
        for (const delay of [0, 100, 500]) setTimeout(() => migrateLegacyStudioNode(node), delay);
        node.title = NODE_TITLE;
        const root = createV4Workbench(node);
        const dom = node.addDOMWidget("xiantu_digital_human_v4_ui", "div", root, { serialize: false, hideOnZoom: false, getMinHeight: () => Math.ceil(root.scrollHeight || 720), getMaxHeight: () => Math.ceil(root.scrollHeight || 720), getValue: () => undefined, setValue: () => {} });
        dom.computeSize = (width) => [Math.max(810, width), Math.ceil(root.scrollHeight || 720)];
        const observer = new ResizeObserver(() => node.setDirtyCanvas?.(true, true));
        observer.observe(root);
        const previousConfigure = node.onConfigure;
        node.onConfigure = function () {
            previousConfigure?.apply(this, arguments);
            migrateLegacyStudioNode(this);
            for (const delay of [0, 100, 500]) setTimeout(() => migrateLegacyStudioNode(this), delay);
            this.title = NODE_TITLE;
            requestAnimationFrame(() => root.__xdhV4Sync?.());
        };
        const previousRemoved = node.onRemoved;
        node.onRemoved = function () { observer.disconnect(); previousRemoved?.apply(this, arguments); };
        requestAnimationFrame(() => { root.__xdhV4Sync?.(); node.setSize?.([830, 780]); });
    },
});
