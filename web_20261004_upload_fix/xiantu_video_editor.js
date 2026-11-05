import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE = "XiantuVideoEditorWorkbench";
const compactDirectorState = (state) => ({
    ...state,
    shots: Array.isArray(state.shots) ? state.shots.map((shot) => {
        const result = { ...shot };
        if (shot.prompts && typeof shot.prompts === "object") {
            result.prompts = { ...shot.prompts };
            const mode = String(shot.mode || "reference");
            if (typeof shot.prompt === "string" && result.prompts[mode] === shot.prompt) {
                delete result.prompts[mode];
            }
        }
        return result;
    }) : state.shots,
});
const compactDirectorNodeSnapshot = (node, data) => {
    const index = (node.widgets || []).findIndex((widget) => widget.name === "editor_state");
    if (index < 0 || !Array.isArray(data.widgets_values)) return;
    const candidates = [];
    for (const value of [data.widgets_values[index], data.properties?.xiantuVideoEditorState]) {
        try {
            const state = typeof value === "string" ? JSON.parse(value) : value;
            if (state && Array.isArray(state.shots)) candidates.push(state);
        } catch {}
    }
    const state = candidates.sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0))[0];
    if (!state) return;
    data.widgets_values = [...data.widgets_values];
    data.widgets_values[index] = JSON.stringify(compactDirectorState(state));
    data.properties = { ...(data.properties || {}) };
    delete data.properties.xiantuVideoEditorState;
};
let directorRecoveryDbPromise;
let directorRecoveryWarningShown = false;
const openDirectorRecoveryDb = () => directorRecoveryDbPromise ||= new Promise((resolve, reject) => {
    const request = indexedDB.open("xiantu_video_editor_recovery", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("states");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("工作台恢复存储被其他页面占用"));
}).catch((error) => { directorRecoveryDbPromise = null; throw error; });
const readDirectorRecovery = async (key) => {
    try {
        const db = await openDirectorRecoveryDb();
        return await new Promise((resolve, reject) => {
            const request = db.transaction("states", "readonly").objectStore("states").get(key);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    } catch { return null; }
};
const writeDirectorRecovery = async (key, serialized) => {
    try {
        const legacy = localStorage.getItem(key);
        const db = await openDirectorRecoveryDb();
        await new Promise((resolve, reject) => {
            const transaction = db.transaction("states", "readwrite");
            transaction.objectStore("states").put(serialized, key);
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error);
        });
        // Remove only this obsolete recovery copy, and only AFTER the complete
        // replacement has committed. Other workflows/drafts are never cleared.
        if (legacy !== null && localStorage.getItem(key) === legacy) {
            localStorage.removeItem(key);
            return true;
        }
    } catch (error) {
        if (!directorRecoveryWarningShown) {
            console.warn("导演台浏览器恢复副本保存失败；完整数据仍保留在工作流节点中", error);
            directorRecoveryWarningShown = true;
        }
    }
    return false;
};
const H3_DATA_BRIDGE = "XiantuH3ContinuationDataBridge";
const isExternalSelfLift = (type) => String(type || "") === "SelfLiftH3Sampler";
const connectedSelfLiftNodes = (graph, workbenchId) => {
    const all = graph?._nodes || [];
    const byId = (id) => graph?.getNodeById?.(id) || all.find((item) => String(item.id) === String(id));
    const getLink = (id) => graph?.links instanceof Map ? graph.links.get(id) : graph?.links?.[id];
    const reaches = (item, seen = new Set()) => {
        if (!item || Number(item.mode) === 2 || seen.has(String(item.id))) return false;
        if (String(item.id) === String(workbenchId)) return true;
        seen.add(String(item.id));
        return (item.inputs || []).some((input) => {
            const link = getLink(input.link);
            return link && reaches(byId(Array.isArray(link) ? link[1] : link.origin_id), seen);
        });
    };
    return all.filter((item) => isExternalSelfLift(item.comfyClass || item.type)
        && ![2, 4].includes(Number(item.mode))
        && (item.outputs || []).some((output) => (output.links || []).length > 0)
        && reaches(item));
};
const syncSelfLiftCanvasBridges = (graph, workbenchId, enabled,
    createBridge = () => globalThis.LiteGraph?.createNode(H3_DATA_BRIDGE)) => {
    if (!graph) return false;
    const owner = String(workbenchId);
    const byId = (id) => graph.getNodeById?.(id)
        || (graph._nodes || []).find((item) => String(item.id) === String(id));
    const getLink = (id) => graph.links instanceof Map ? graph.links.get(id) : graph.links?.[id];
    const source = (input) => {
        const link = getLink(input?.link);
        if (!link) return null;
        return { node: byId(Array.isArray(link) ? link[1] : link.origin_id),
            slot: Array.isArray(link) ? link[2] : link.origin_slot };
    };
    const isBridge = (item) => (item?.comfyClass || item?.type) === H3_DATA_BRIDGE;
    const samplers = connectedSelfLiftNodes(graph, workbenchId);
    const related = new Set((graph._nodes || []).filter((item) => isBridge(item)
        && item.properties?.xiantuSelfLiftBridgeOwner === owner));
    for (const sampler of samplers) {
        for (const input of sampler.inputs || []) {
            const upstream = source(input)?.node;
            if (isBridge(upstream) && (!upstream.properties?.xiantuSelfLiftBridgeOwner
                || upstream.properties.xiantuSelfLiftBridgeOwner === owner)) related.add(upstream);
        }
    }
    let changed = false;
    let begun = false;
    const begin = () => {
        if (!begun) { graph.beforeChange?.(); begun = true; }
    };
    const connect = (from, target, slot) => {
        const result = from.node.connect(from.slot, target, slot);
        const actual = source(target.inputs[slot]);
        if (result === false || !actual || actual.node !== from.node || actual.slot !== from.slot) {
            throw new Error("数据兼容桥连线失败，已恢复原连线");
        }
    };
    const remove = (bridge) => {
        const routes = [];
        for (let index = 0; index < (bridge.outputs || []).length; index += 1) {
            const from = source(bridge.inputs[index]);
            for (const linkId of [...(bridge.outputs[index].links || [])]) {
                const link = getLink(linkId);
                if (!link) continue;
                const target = byId(Array.isArray(link) ? link[3] : link.target_id);
                const slot = Array.isArray(link) ? link[4] : link.target_slot;
                if (!from?.node || !target) throw new Error("数据兼容桥原连线缺失，请检查画布连接");
                routes.push({ from, target, slot, index });
            }
        }
        begin();
        try {
            for (const route of routes) connect(route.from, route.target, route.slot);
        } catch (error) {
            for (const route of routes) bridge.connect(route.index, route.target, route.slot);
            throw error;
        }
        graph.remove(bridge);
        changed = true;
    };
    try {
        for (const bridge of related) {
            const used = samplers.some((sampler) => (sampler.inputs || [])
                .some((input) => source(input)?.node === bridge));
            if (!enabled || !used) remove(bridge);
        }
        if (enabled) for (const sampler of samplers) {
            const latent = source(sampler.inputs?.find((input) => input.name === "latent_image"));
            if (isBridge(latent?.node)) {
                const bridge = latent.node;
                if (!bridge.properties?.xiantuSelfLiftBridgeOwner) {
                    begin();
                    bridge.properties ||= {};
                    bridge.properties.xiantuSelfLiftBridgeOwner = owner;
                    changed = true;
                }
                continue;
            }
            const names = ["model", "positive", "latent_image", "model_hires"];
            const routes = names.map((name, index) => {
                const slot = (sampler.inputs || []).findIndex((input) => input.name === name);
                return { from: source(sampler.inputs?.[slot]), slot, index };
            });
            if (routes.slice(0, 3).some((route) => !route.from?.node)) continue;
            const bridge = createBridge();
            if (!bridge) throw new Error("H3续接数据兼容桥节点未加载，请刷新页面后重试");
            begin();
            bridge.properties ||= {};
            bridge.properties.xiantuSelfLiftBridgeOwner = owner;
            bridge.properties.xiantuSelfLiftBridgeSampler = String(sampler.id);
            bridge.pos = [sampler.pos[0] - Math.max(240, bridge.size?.[0] || 0) - 60, sampler.pos[1]];
            graph.add(bridge);
            const wired = routes.filter((route) => route.from?.node);
            try {
                for (const route of wired) connect(route.from, bridge, route.index);
                for (const route of wired) connect({ node: bridge, slot: route.index }, sampler, route.slot);
            } catch (error) {
                for (const route of wired) route.from.node.connect(route.from.slot, sampler, route.slot);
                graph.remove(bridge);
                throw error;
            }
            changed = true;
        }
    } finally {
        if (begun) graph.afterChange?.();
        if (changed) { graph.change?.(); graph.setDirtyCanvas?.(true, true); }
    }
    return changed;
};
const FUNCTION_TAG = "xiantuFunctionTag";
const FUNCTION_TAG_LABELS = Object.freeze({ speed: "加速", optimization: "性能优化", sampling: "采样 SIGMAS", model: "模型", lora: "LoRA", custom: "自定义" });
const readFunctionTag = (item) => {
    const raw = item?.properties?.[FUNCTION_TAG];
    if (raw && typeof raw === "object") return { category: String(raw.category || "custom"), label: String(raw.label || ""), note: String(raw.note || "") };
    return null;
};
const functionTagDisplayName = (tag) => {
    if (!tag) return "已标记";
    if (tag.category !== "custom") return FUNCTION_TAG_LABELS[tag.category] || tag.label || tag.note || "已标记";
    const legacyCustomName = tag.note && tag.note !== FUNCTION_TAG_LABELS.custom ? tag.note : "";
    return tag.label || legacyCustomName || FUNCTION_TAG_LABELS.custom;
};
const WORKBENCH_LOGO_URL = new URL("./assets/xiantu-rabbit-logo.png", import.meta.url).href;
let videoEditorStyleReady = Promise.resolve();

{
    const styleUrl = new URL("./xiantu_video_editor.css?v=20261101-055", import.meta.url).href;
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
    videoEditorStyleReady = installInlineFallback();
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
const workbenchGraphScope = (graph, workbenchId) => {
    const parents = new Map(), children = new Map();
    const getLink = (id) => graph?.links instanceof Map ? graph.links.get(id) : graph?.links?.[id];
    for (const item of graph?._nodes || []) {
        const id = String(item.id);
        parents.set(id, (item.inputs || []).flatMap((input) => {
            const link = getLink(input.link);
            if (!link) return [];
            const origin = String(Array.isArray(link) ? link[1] : link.origin_id);
            if (!children.has(origin)) children.set(origin, []);
            children.get(origin).push(id);
            return [origin];
        }));
    }
    const visit = (starts, edges) => {
        const seen = new Set(), pending = [...starts];
        while (pending.length) {
            const id = String(pending.pop());
            if (seen.has(id)) continue;
            seen.add(id); pending.push(...(edges.get(id) || []));
        }
        return seen;
    };
    const downstream = visit([workbenchId], children);
    return { downstream, ids: visit(downstream, parents) };
};
const scopeWorkbenchPrompt = (prompt, workbenchId) => {
    const nodes = prompt?.output || {}, parents = new Map(), children = new Map();
    for (const [id, item] of Object.entries(nodes)) {
        parents.set(id, Object.values(item.inputs || {}).flatMap((value) => {
            if (!Array.isArray(value) || value.length !== 2 || !nodes[String(value[0])]) return [];
            const origin = String(value[0]);
            if (!children.has(origin)) children.set(origin, []);
            children.get(origin).push(id);
            return [origin];
        }));
    }
    const visit = (starts, edges) => {
        const seen = new Set(), pending = [...starts];
        while (pending.length) {
            const id = String(pending.pop());
            if (seen.has(id)) continue;
            seen.add(id); pending.push(...(edges.get(id) || []));
        }
        return seen;
    };
    const keep = visit(visit([workbenchId], children), parents);
    prompt.output = Object.fromEntries(Object.entries(nodes).filter(([id]) => keep.has(id)));
    if (prompt.workflow) {
        prompt.workflow = { ...prompt.workflow };
        if (Array.isArray(prompt.workflow.nodes)) prompt.workflow.nodes = prompt.workflow.nodes.filter((item) => keep.has(String(item.id)));
        if (Array.isArray(prompt.workflow.links)) prompt.workflow.links = prompt.workflow.links.filter((link) =>
            keep.has(String(Array.isArray(link) ? link[1] : link.origin_id))
            && keep.has(String(Array.isArray(link) ? link[3] : link.target_id)));
    }
    return prompt;
};
const refreshWorkflowSeed = (workbenchId, graph = app.graph) => {
    const seed = freshSeed();
    const seedNames = new Set(["seed", "noise_seed", "随机种子", "噪声种子"]);
    const scope = workbenchGraphScope(graph, workbenchId).ids;
    for (const graphNode of graph?._nodes || []) {
        if (!scope.has(String(graphNode.id))) continue;
        for (const widget of graphNode.widgets || []) {
            if (!seedNames.has(String(widget?.name || "").toLowerCase())) continue;
            widget.value = seed;
        }
    }
    graph?.setDirtyCanvas?.(true, true);
    return seed;
};
const injectWorkflowSeed = (prompt, seed, workbenchId) => {
    scopeWorkbenchPrompt(prompt, workbenchId);
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
    "序号", "分镜编号", "分镜名称", "时长（秒）", "是否承接上一分镜", "承接上下文帧数", "生成类型", "提示词", "参考图尺寸",
    "速度优化作用范围", "采样作用范围", "速度选择", "性能优化选择", "采样 SIGMAS 选择", "采样器（自动匹配）", "LoRA 选择", "LoRA 全局节点",
    ...Array.from({ length: 9 }, (_, index) => `参考图片绝对路径${index + 1}`),
    ...Array.from({ length: 3 }, (_, index) => `参考视频绝对路径${index + 1}`),
    ...Array.from({ length: 3 }, (_, index) => `参考音频绝对路径${index + 1}`),
    "画面比例", "生成分辨率", "保存文件名",
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
      <section class="xve-app" role="dialog" aria-label="闲兔 漫剧/短剧工作导演台">
        <header class="xve-topbar">
          <strong class="xve-brand"><img src="${WORKBENCH_LOGO_URL}" alt=""><span>闲兔 漫剧/短剧工作导演台</span></strong>
          <nav class="xve-model-nav" aria-label="视频模型">
            <button type="button" class="active" data-model-profile="minimax-h3"><i></i>MiniMax H3</button>
          </nav>
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
          <nav class="xve-workflow-nav xve-panel" aria-label="导演台功能导航">
            <button type="button" data-mode="text"><i>文</i><span>文生视频</span></button>
            <button type="button" data-mode="image"><i>图</i><span>图生视频</span></button>
            <button type="button" data-mode="frames"><i>帧</i><span>首尾帧</span></button>
            <button type="button" class="active" data-mode="reference"><i>参</i><span>多参考生视频</span></button>
            <hr>
            <button type="button" class="upcoming" data-workflow-preview="character" aria-disabled="true"><i>角</i><span>角色替换</span></button>
            <button type="button" class="upcoming" data-workflow-preview="motion" aria-disabled="true"><i>动</i><span>动作迁移</span></button>
            <button type="button" class="upcoming" data-workflow-preview="sequel" aria-disabled="true"><i>续</i><span>视频续集</span></button>
          </nav>
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
              <div class="xve-shot-head-row">
                <div class="xve-shot-tabs" data-shot-tabs></div>
                <div class="xve-shot-actions">
                  <button type="button" data-prev-shot title="上一个分镜">←</button>
                  <button type="button" data-next-shot title="下一个分镜">→</button>
                  <button type="button" data-clear-shots>清空分镜</button>
                  <button type="button" data-delete-shot>删除</button>
                  <button type="button" data-add-shot><b>＋</b> 分镜</button>
                </div>
              </div>
              <div class="xve-shot-toolbar">
                <div class="xve-optimization-actions">
                  <button type="button" data-open-placeholder="optimization">速度性能优化</button>
                  <button type="button" data-sigma-open>采样 SIGMAS</button>
                  <button type="button" data-lora-open>LoRA</button>
                  <button type="button" class="xve-repair-button face" data-face-repair>人脸修复</button>
                </div>
                <div class="xve-generate-tools">
                  <label class="xve-check xve-continuity-toggle"><input type="checkbox" data-cascade checked><span></span>继承上一分镜</label>
                  <label class="xve-continuity-field" data-continuity-setting>上下文帧数<select data-continuity-frames><option value="22" selected>22帧（约0.9秒）</option><option value="39">39帧（约1.6秒）</option><option value="56">56帧（约2.3秒）</option></select></label>
                  <label class="xve-seconds">秒数 <input type="number" min="1" step="1" value="5" data-seconds></label>
                  <label class="xve-filename-prefix"><span>保存文件名</span><input type="text" maxlength="80" placeholder="留空按分镜名" data-filename-prefix></label>
                  <button type="button" class="xve-generate small" data-generate>▶ 开始生成</button>
                </div>
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
              <div class="xve-prompt-head">
                <label for="xve-prompt">单个分镜提示词</label>
                <div class="xve-sheet-actions">
                  <label class="xve-selflift-compat" data-selflift-compat-label title="当前导演台未连接启用的 SelfLift 二采节点"><input type="checkbox" data-selflift-compat disabled>二采兼容</label>
                  <button type="button" data-download-sheet>⇩ 下载表格</button>
                  <button type="button" data-upload-sheet>↥ 上传表格</button>
                  <input type="file" accept=".csv,.xls,.xlsx,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" data-sheet-file hidden>
                </div>
              </div>
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
              <div class="xve-results-head"><strong>生成后视频列表 <span data-result-count>（0）</span></strong><div class="xve-results-actions"><button type="button" data-result-folder>▣ 保存目录</button><button type="button" data-result-merge>▦ 导出成片</button><button type="button" class="refresh" data-result-refresh>⟳ 刷新</button></div></div>
              <nav class="xve-result-tabs"><button type="button" data-result-tab="before">放大前</button><button type="button" class="active" data-result-tab="after">放大后</button><button type="button" data-result-tab="merged">合并成片</button></nav>
              <div class="xve-result-list" data-result-list></div>
              <div class="xve-results-foot"><span data-result-total>共 0 个视频</span><div><label><input type="checkbox" data-result-all> 全部选择</label><button type="button" data-result-delete-selected>批量删除</button></div></div>
            </section>
          </div>
          <section class="xve-timeline xve-panel">
            <header><strong>视频编辑</strong><div class="xve-edit-tools"><button type="button" data-edit-split title="在播放头处切割选中视频">切割</button><button type="button" data-edit-delete title="从时间线删除选中片段">删除片段</button><button type="button" data-edit-link title="切换选中音频与视频的联动">音画解绑</button><button type="button" data-edit-mute title="静音或恢复选中音频">静音</button><label title="选中音频音量">音量 <input type="range" min="0" max="200" step="1" value="100" data-edit-volume><output data-edit-volume-value>100%</output></label><label title="音频淡入秒数">淡入 <input type="number" min="0" max="10" step="0.1" value="0" data-edit-fade-in></label><label title="音频淡出秒数">淡出 <input type="number" min="0" max="10" step="0.1" value="0" data-edit-fade-out></label></div><div class="xve-timeline-tools"><span>缩放</span><button type="button" data-timeline-zoom-out>−</button><input type="range" min="20" max="100" step="2" value="38" data-timeline-zoom><button type="button" data-timeline-zoom-in>＋</button><b data-timeline-zoom-value>100%</b></div></header>
            <div class="xve-timeline-body">
              <div class="xve-track-labels"><span>时间</span><b>视频轨道</b><b class="xve-audio-lane-labels"><span>音频1</span><span>音频2</span></b></div>
              <div class="xve-track-viewport" data-timeline-viewport>
                <div class="xve-time-ruler" data-time-ruler></div>
                <div class="xve-track xve-video-track" data-video-track></div>
                <div class="xve-track xve-audio-track" data-audio-track><em>暂无音频素材</em></div>
                <i class="xve-playhead" data-playhead></i>
              </div>
            </div>
          </section>
        </main>
        <div class="xve-placeholder-backdrop" data-placeholder-dialog hidden>
          <section class="xve-placeholder-dialog" role="dialog" aria-modal="true" aria-labelledby="xve-placeholder-title">
            <header><b id="xve-placeholder-title" data-placeholder-title>速度性能优化</b><div class="xve-dialog-header-actions"><label><input type="checkbox" data-speed-optimization-global> 全局</label><button type="button" data-placeholder-close aria-label="关闭">×</button></div></header>
	            <main class="xve-function-tag-main">
	              <nav class="xve-function-tag-filters" data-function-tag-filters>
	                <button type="button" class="active" data-function-tag-filter="speed">速度</button>
	                <button type="button" data-function-tag-filter="optimization">性能优化</button>
	              </nav>
	              <div class="xve-function-tag-list" data-function-tag-list></div>
            </main>
            <footer><button type="button" data-placeholder-close>关闭</button></footer>
          </section>
        </div>
        <div class="xve-sigma-backdrop" data-sigma-dialog hidden>
          <section class="xve-sigma-dialog" role="dialog" aria-modal="true" aria-labelledby="xve-sigma-dialog-title">
            <header><b id="xve-sigma-dialog-title">采样 SIGMAS</b><div class="xve-dialog-header-actions"><label><input type="checkbox" data-sampling-global> 全局</label><button type="button" data-sigma-close aria-label="关闭">×</button></div></header>
            <main class="xve-sigma-main">
              <section class="xve-sigma-tagged"><div class="xve-shot-config-head"><strong>采样标记节点</strong><span data-sampling-shot-state></span><button type="button" data-sampling-use-default>使用默认</button></div><div class="xve-function-tag-list compact" data-sampling-tag-list></div></section>
              <section class="xve-sampler-pairing"><strong>采样器选择（自动配对）</strong><div class="xve-sampler-pair-list" data-sampler-pair-list></div></section>
            </main>
            <footer><button type="button" data-sigma-close>关闭</button></footer>
          </section>
        </div>
        <div class="xve-sigma-backdrop" data-lora-dialog hidden>
          <section class="xve-sigma-dialog" role="dialog" aria-modal="true" aria-labelledby="xve-lora-dialog-title">
            <header><b id="xve-lora-dialog-title">LoRA 功能</b><button type="button" data-lora-close aria-label="关闭">×</button></header>
            <main><section><div class="xve-shot-config-head"><strong>LoRA 标记节点</strong><span data-lora-shot-state></span><button type="button" data-lora-use-default>使用默认</button></div><div class="xve-function-tag-list" data-lora-tag-list></div></section></main>
            <footer><button type="button" data-lora-close>关闭</button></footer>
          </section>
        </div>
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
    let textDialogMode = "text";
    const closeTextDialog = (value = null) => {
        textDialog.hidden = true;
        const resolve = resolveTextDialog;
        resolveTextDialog = null;
        resolve?.(value);
    };
    const openTextDialog = ({ title, label, value = "", maxLength = 80 }) => new Promise((resolve) => {
        if (resolveTextDialog) closeTextDialog(null);
        resolveTextDialog = resolve;
        textDialogMode = "text";
        q("[data-text-dialog-title]").textContent = title;
        q("[data-text-dialog-label]").textContent = label;
        const field = q("[data-text-dialog-input]");
        field.hidden = false;
        field.maxLength = maxLength;
        field.value = value;
        q("[data-text-dialog-confirm]").textContent = "确定";
        textDialog.hidden = false;
        requestAnimationFrame(() => { field.focus(); field.select(); });
    });
    const openConfirmDialog = ({ title, message, confirmText = "确定" }) => new Promise((resolve) => {
        if (resolveTextDialog) closeTextDialog(null);
        resolveTextDialog = resolve;
        textDialogMode = "confirm";
        q("[data-text-dialog-title]").textContent = title;
        q("[data-text-dialog-label]").textContent = message;
        q("[data-text-dialog-input]").hidden = true;
        q("[data-text-dialog-confirm]").textContent = confirmText;
        textDialog.hidden = false;
        requestAnimationFrame(() => q("[data-text-dialog-confirm]")?.focus());
    });
    root.querySelectorAll("[data-text-dialog-cancel]").forEach((button) => { button.onclick = () => closeTextDialog(null); });
    q("[data-text-dialog-confirm]").onclick = () => closeTextDialog(textDialogMode === "confirm" ? true : q("[data-text-dialog-input]").value);
    textDialog.onclick = (event) => { if (event.target === textDialog) closeTextDialog(null); };
    textDialog.onkeydown = (event) => {
        event.stopPropagation();
        if (event.key === "Escape") closeTextDialog(null);
        if (event.key === "Enter") closeTextDialog(textDialogMode === "confirm" ? true : q("[data-text-dialog-input]").value);
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
        if (node._xveRecoveredState) addCandidate(node._xveRecoveredState);
        try { addCandidate(localStorage.getItem(editorStateStorageKey)); } catch {}
        return candidates.sort((left, right) => Number(right?.updated_at || 0) - Number(left?.updated_at || 0))[0] || {};
    })();
    let lastSavedUpdatedAt = Number(initialState.updated_at || 0);
    let lastSavedContent = "";
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
    const videoModes = ["text", "image", "frames", "reference"];
    const ensureModePrompts = (shot) => {
        const currentMode = videoModes.includes(String(shot?.mode)) ? String(shot.mode) : "reference";
        const saved = shot?.prompts && typeof shot.prompts === "object" ? shot.prompts : {};
        const legacyPrompt = String(shot?.prompt || "");
        const savedFunctionSelections = shot?.functionSelections && typeof shot.functionSelections === "object" ? shot.functionSelections : {};
        shot.mode = currentMode;
        shot.prompts = Object.fromEntries(videoModes.map((mode) => [mode, String(saved[mode] ?? (mode === currentMode ? legacyPrompt : ""))]));
        shot.prompt = shot.prompts[currentMode];
        shot.functionSelections = {};
        if (savedFunctionSelections.samplingNodeId !== undefined && savedFunctionSelections.samplingNodeId !== null && String(savedFunctionSelections.samplingNodeId)) {
            shot.functionSelections.samplingNodeId = String(savedFunctionSelections.samplingNodeId);
        }
        if (savedFunctionSelections.loraNodeModes && typeof savedFunctionSelections.loraNodeModes === "object") {
            shot.functionSelections.loraNodeModes = Object.fromEntries(Object.entries(savedFunctionSelections.loraNodeModes).map(([id, mode]) => [String(id), Number(mode)]));
        }
        for (const category of ["speed", "optimization"]) {
            const key = `${category}NodeModes`;
            if (savedFunctionSelections[key] && typeof savedFunctionSelections[key] === "object") {
                shot.functionSelections[key] = Object.fromEntries(Object.entries(savedFunctionSelections[key]).map(([id, mode]) => [String(id), Number(mode)]));
            }
        }
        return shot;
    };
    shots.forEach(ensureModePrompts);
    let functionSelectionDefaults = initialState.functionSelectionDefaults && typeof initialState.functionSelectionDefaults === "object"
        ? structuredClone(initialState.functionSelectionDefaults)
        : null;
    const savedFunctionSelectionScopes = initialState.functionSelectionScopes && typeof initialState.functionSelectionScopes === "object"
        ? initialState.functionSelectionScopes
        : {};
    let functionSelectionScopes = {
        samplingGlobal: Boolean(savedFunctionSelectionScopes.samplingGlobal),
        speedOptimizationGlobal: savedFunctionSelectionScopes.speedOptimizationGlobal === undefined
            ? true
            : Boolean(savedFunctionSelectionScopes.speedOptimizationGlobal),
        loraGlobalByNode: savedFunctionSelectionScopes.loraGlobalByNode && typeof savedFunctionSelectionScopes.loraGlobalByNode === "object"
            ? Object.fromEntries(Object.entries(savedFunctionSelectionScopes.loraGlobalByNode).map(([id, enabled]) => [String(id), Boolean(enabled)]))
            : {},
    };
    let samplingSamplerPairs = initialState.samplingSamplerPairs && typeof initialState.samplingSamplerPairs === "object"
        ? Object.fromEntries(Object.entries(initialState.samplingSamplerPairs).map(([samplingId, samplerId]) => [String(samplingId), String(samplerId)]))
        : {};
    let activeShotId = String(initialState.activeShotId || shots[0].id);
    if (!shots.some((shot) => shot.id === activeShotId)) activeShotId = shots[0].id;
    const sanitizeEditNumber = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
    const sanitizeEditEnd = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) && Number(value) > 0
        ? Number(value)
        : null;
    let videoEditSegments = Array.isArray(initialState.videoEditSegments) ? initialState.videoEditSegments.map((segment) => ({
        id: String(segment.id || makeId()),
        shotId: String(segment.shotId || ""),
        sourceStart: Math.max(0, sanitizeEditNumber(segment.sourceStart)),
        sourceEnd: sanitizeEditEnd(segment.sourceEnd),
    })).filter((segment) => segment.shotId) : [];
    let audioEditSegments = Array.isArray(initialState.audioEditSegments) ? initialState.audioEditSegments.map((segment) => ({
        id: String(segment.id || makeId()),
        videoSegmentId: String(segment.videoSegmentId || ""),
        shotId: String(segment.shotId || ""),
        sourceStart: Math.max(0, sanitizeEditNumber(segment.sourceStart)),
        sourceEnd: sanitizeEditEnd(segment.sourceEnd),
        timelineStart: Math.max(0, sanitizeEditNumber(segment.timelineStart)),
        linked: segment.linked !== false,
        muted: Boolean(segment.muted),
        volume: Math.max(0, Math.min(2, sanitizeEditNumber(segment.volume, 1))),
        fadeIn: Math.max(0, sanitizeEditNumber(segment.fadeIn)),
        fadeOut: Math.max(0, sanitizeEditNumber(segment.fadeOut)),
    })).filter((segment) => segment.shotId) : [];
    let activeEditSelection = initialState.activeEditSelection && ["video", "audio"].includes(initialState.activeEditSelection.kind)
        ? { kind: initialState.activeEditSelection.kind, id: String(initialState.activeEditSelection.id || "") }
        : null;
    let excludedTimelineShotIds = new Set(Number(initialState.version || 0) >= 3 && Array.isArray(initialState.excludedTimelineShotIds) ? initialState.excludedTimelineShotIds.map(String) : []);
    let timelinePlayheadSeconds = Math.max(0, sanitizeEditNumber(initialState.timelinePlayheadSeconds));
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
    let sigmaGroupKeys = Array.isArray(initialState.sigmaGroupKeys) ? initialState.sigmaGroupKeys.map(String) : [];
    let activeSigmaGroupKey = String(initialState.activeSigmaGroupKey || "");
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
    const continuityMode = "latent";
    let selfLiftCompatibility = Boolean(initialState.selfLiftCompatibility);
    const continuityCacheNamespace = String(initialState.continuityCacheNamespace || globalThis.crypto?.randomUUID?.() || makeId());
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
    runtime.directorStagePercent = 0;
    runtime.externalBusy = false;
    let hardwareTimer = null;
    let selfLiftCompatibilityTimer = null;
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
    const buildEditorState = () => ({
            version: 3,
            activeShotId,
            modelProfile,
            sigmaGroupKeys: [...sigmaGroupKeys],
            activeSigmaGroupKey,
            filenamePrefix,
            referenceSize,
            referenceSizeExplicit,
            resolution: { ...resolutionState, ...resolutionFor() },
            timelineScale,
            timelinePlayheadSeconds,
            activeEditSelection,
            videoEditSegments,
            audioEditSegments,
            excludedTimelineShotIds: [...excludedTimelineShotIds],
            continuityEnabled,
            continuityOverlapFrames,
            continuityMode,
            selfLiftCompatibility,
            continuityCacheNamespace,
            cleanupSettings: { ...cleanupSettings },
            faceRepair: structuredClone(faceRepairSettings),
            functionSelectionDefaults: functionSelectionDefaults ? structuredClone(functionSelectionDefaults) : null,
            functionSelectionScopes: { ...functionSelectionScopes },
            samplingSamplerPairs: { ...samplingSamplerPairs },
            generationProgress: { ...generationProgress },
            shots,
            assets: assetList.map(({ id, sourceAssetId, sourceCategory, sourceContentHash, sourceRelativePath, sourcePath, serverName, subfolder, sourceType, shotId, name, alias, note, type, duration, width, height, global }) => ({ id, sourceAssetId: String(sourceAssetId || ""), sourceCategory: String(sourceCategory || ""), sourceContentHash: String(sourceContentHash || ""), sourceRelativePath: String(sourceRelativePath || ""), sourcePath: String(sourcePath || ""), serverName: String(serverName || ""), subfolder: String(subfolder || ""), sourceType: String(sourceType || "input"), shotId, name, alias: String(alias || ""), note: String(note || ""), type, duration, width, height, global: Boolean(global) })),
            selectedAssetIds: [...selectedAssetIds],
            results,
            resultView,
            updated_at: lastSavedUpdatedAt,
        });
    const save = () => {
        const nextState = compactDirectorState(buildEditorState());
        const content = JSON.stringify({ ...nextState, updated_at: 0 });
        const changed = content !== lastSavedContent;
        if (changed) {
            lastSavedUpdatedAt = Date.now();
            lastSavedContent = content;
        }
        nextState.updated_at = lastSavedUpdatedAt;
        const serialized = JSON.stringify(nextState);
        const widgetChanged = String(editorStateWidget?.value || "") !== serialized;
        if (editorStateWidget) editorStateWidget.value = serialized;
        node.properties ??= {};
        const hadDuplicate = Boolean(node.properties.xiantuVideoEditorState);
        if (editorStateWidget) delete node.properties.xiantuVideoEditorState;
        else node.properties.xiantuVideoEditorState = nextState;
        if (changed || widgetChanged || hadDuplicate) {
            try { localStorage.setItem(filenamePrefixStorageKey, filenamePrefix); } catch {}
            writeDirectorRecovery(editorStateStorageKey, serialized).then((migrated) => {
                if (migrated) node.graph?.change?.();
            });
            node.graph?.change?.();
            node.graph?.setDirtyCanvas?.(true, true);
            node.setDirtyCanvas?.(true, true);
        }
    };
    const workflowGroups = () => {
        const groups = Array.isArray(node.graph?._groups) ? node.graph._groups : [];
        return groups.map((group, index) => ({
            group,
            key: String(group.id ?? group._id ?? `${String(group.title || "未命名组")}|${Number(group.pos?.[0] || 0)}|${Number(group.pos?.[1] || 0)}|${index}`),
            title: String(group.title || `工作流组 ${index + 1}`),
        }));
    };
    const groupMembers = (group) => {
        try { group.recomputeInsideNodes?.(); } catch {}
        if (Array.isArray(group._nodes)) return group._nodes.filter((item) => item && item !== node);
        const [left, top] = group.pos || [0, 0];
        const [width, height] = group.size || [0, 0];
        return (node.graph?._nodes || []).filter((item) => {
            if (!item || item === node) return false;
            const [x, y] = item.pos || [0, 0];
            const [w, h] = item.size || [0, 0];
            return x >= left && y >= top && x + w <= left + width && y + h <= top + height;
        });
    };
    const groupProducesSigmas = (group) => groupMembers(group).some((item) =>
        (item.outputs || []).some((output) => String(output?.type || "").toUpperCase() === "SIGMAS")
    );
    const selectedSigmaGroups = () => {
        const groups = workflowGroups();
        if (!sigmaGroupKeys.length) {
            sigmaGroupKeys = groups.filter(({ group, title }) => /sigmas?/i.test(title) || groupProducesSigmas(group)).map(({ key }) => key);
        }
        sigmaGroupKeys = sigmaGroupKeys.filter((key) => groups.some((item) => item.key === key));
        if (!activeSigmaGroupKey || !sigmaGroupKeys.includes(activeSigmaGroupKey)) {
            const enabled = groups.find(({ key, group }) => sigmaGroupKeys.includes(key) && groupMembers(group).some((item) => Number(item.mode || 0) !== 4));
            activeSigmaGroupKey = enabled?.key || sigmaGroupKeys[0] || "";
        }
        return groups.filter(({ key }) => sigmaGroupKeys.includes(key));
    };
    const applySigmaGroup = (key) => {
        activeSigmaGroupKey = String(key || "");
        for (const { key: itemKey, group } of selectedSigmaGroups()) {
            for (const item of groupMembers(group)) item.mode = itemKey === activeSigmaGroupKey ? 0 : 4;
        }
        node.graph?.change?.();
        node.graph?.setDirtyCanvas?.(true, true);
        renderSigmaGroups();
        save();
    };
    const renderSigmaGroups = () => {
        const pills = q("[data-sigma-pills]");
        const menu = q("[data-sigma-menu]");
        if (!pills || !menu) return;
        const groups = workflowGroups();
        const selected = selectedSigmaGroups();
        pills.replaceChildren();
        for (const { key, title } of selected) {
            const pill = document.createElement("span");
            pill.className = `xve-sigma-pill${key === activeSigmaGroupKey ? " active" : ""}`;
            const choose = document.createElement("button");
            choose.type = "button";
            choose.textContent = title;
            choose.title = `启用 ${title}`;
            choose.onclick = () => applySigmaGroup(key);
            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "xve-sigma-remove";
            remove.textContent = "×";
            remove.title = `从采样 SIGMAS 选择中移除 ${title}`;
            remove.onclick = (event) => {
                event.stopPropagation();
                sigmaGroupKeys = sigmaGroupKeys.filter((item) => item !== key);
                if (activeSigmaGroupKey === key) activeSigmaGroupKey = sigmaGroupKeys[0] || "";
                renderSigmaGroups();
                save();
            };
            pill.append(choose, remove);
            pills.appendChild(pill);
        }
        menu.replaceChildren();
        for (const { key, title } of groups.filter((item) => !sigmaGroupKeys.includes(item.key))) {
            const option = document.createElement("button");
            option.type = "button";
            option.textContent = title;
            option.onclick = () => {
                sigmaGroupKeys.push(key);
                if (!activeSigmaGroupKey) activeSigmaGroupKey = key;
                q("[data-sigma-dialog]").hidden = true;
                renderSigmaGroups();
                save();
            };
            menu.appendChild(option);
        }
        if (!menu.childElementCount) {
            const empty = document.createElement("small");
            empty.textContent = "当前工作流没有可添加的其他组";
            menu.appendChild(empty);
        }
    };
    let promptCommitTimer = 0;
    const commitPromptChanges = () => {
        promptCommitTimer = 0;
        renderResolutionSettings();
        renderTimeline();
        save();
    };
    const updatePrompt = (deferCommit = false) => {
        const shot = activeShot();
        if (!shot) return;
        const nextPrompt = promptText();
        ensureModePrompts(shot);
        shot.prompt = nextPrompt;
        shot.prompts[shot.mode] = nextPrompt;
        shot.seconds = Math.max(1, Number(q("[data-seconds]").value) || 5);
        if (deferCommit) {
            window.clearTimeout(promptCommitTimer);
            promptCommitTimer = window.setTimeout(commitPromptChanges, 160);
            return;
        }
        window.clearTimeout(promptCommitTimer);
        commitPromptChanges();
    };
    const loadShot = () => {
        const shot = activeShot();
        if (!shot) return;
        ensureModePrompts(shot);
        applyShotFunctionSelections(shot);
        q("[data-seconds]").value = String(shot.seconds || 5);
        root.querySelectorAll("[data-mode]").forEach((button) => button.classList.toggle("active", button.dataset.mode === shot.mode));
        continuityEnabled = Boolean(shot.inheritPrevious);
        referenceSize = shot.referenceSize === "max" ? "max" : "match";
        syncModeUI();
        syncContinuityUI();
        renderPromptContent(shot.prompts[shot.mode]);
        renderResolutionSettings();
    };
    const syncContinuityUI = () => {
        const firstShot = shots.findIndex((shot) => shot.id === activeShotId) <= 0;
        if (firstShot) { continuityEnabled = false; if (activeShot()) activeShot().inheritPrevious = false; }
        q("[data-cascade]").checked = Boolean(continuityEnabled);
        q("[data-cascade]").disabled = firstShot;
        q("[data-continuity-frames]").value = String(continuityOverlapFrames);
        q("[data-continuity-frames]").disabled = !continuityEnabled;
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
            button.innerHTML = `<span class="xve-shot-check ${shot.selected ? "checked" : ""}">✓</span><span class="xve-shot-tab-copy"><b>分镜 ${String(index + 1).padStart(2, "0")}</b><small>${Math.max(1, Number(shot.seconds) || 5)}秒</small></span>${shot.id === activeShotId ? '<i>×</i>' : ""}`;
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
        const autoImageFrame = mode === "image" && Boolean(activeShot()?.inheritPrevious);
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
        meta.textContent = mode === "frames"
            ? (autoFirstFrame ? `首帧自动承接上一分镜 · 当前尾帧 ${visibleAssets.length}/1` : `当前分镜${title} ${visibleAssets.length}/2`)
            : autoImageFrame
                ? `H3 自动承接上一分镜尾帧与多帧上下文 · 当前输入图 ${visibleAssets.length}/1（可选）`
                : `当前分镜${title} ${visibleAssets.length}${Number.isFinite(modeLimit) ? `/${modeLimit}` : " 个"}`;
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
            const uploadName = mode === "frames" ? (autoFirstFrame ? "尾帧" : (visibleAssets.length ? "尾帧" : "首帧")) : autoImageFrame ? "可选输入图" : noun;
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
        q("[data-reference-size]").disabled = mode === "text";
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
    const mentionRangeAtCaret = (editor = q("[data-prompt]")) => {
        const selection = window.getSelection();
        if (!selection?.rangeCount) return null;
        const range = selection.getRangeAt(0);
        if (!range.collapsed || !editor.contains(range.startContainer)) return null;
        let textNode = range.startContainer;
        let offset = range.startOffset;
        if (textNode.nodeType !== Node.TEXT_NODE) {
            if (offset < 1) return null;
            let candidate = textNode.childNodes?.[offset - 1] || null;
            while (candidate?.lastChild) candidate = candidate.lastChild;
            if (candidate?.nodeType !== Node.TEXT_NODE) return null;
            textNode = candidate;
            offset = String(textNode.nodeValue || "").length;
        }
        if (offset < 1 || textNode.nodeValue?.[offset - 1] !== "@") return null;
        const trigger = document.createRange();
        trigger.setStart(textNode, offset - 1);
        trigger.setEnd(textNode, offset);
        return trigger;
    };
    const insertMention = (tag) => {
        const editor = q("[data-prompt]");
        const item = mentionItems().find((candidate) => candidate.tag === tag);
        if (!item) return;
        const selection = window.getSelection();
        const triggerRange = promptMentionRange?.cloneRange();
        const range = triggerRange || document.createRange();
        if (!promptMentionRange) {
            range.selectNodeContents(editor);
            range.collapse(false);
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
    const refreshMentionMenu = () => {
        promptMentionRange = mentionRangeAtCaret();
        if (promptMentionRange) showMentionMenu();
        else hideMentionMenu();
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
                index > 0 && shot.inheritPrevious ? Number(continuityOverlapFrames) : "",
                MODE_LABELS[shot.mode] || MODE_LABELS.reference,
                shot.prompt || "",
                shot.referenceSize === "max" ? "MAX" : "标准",
                functionSelectionScopes.speedOptimizationGlobal ? "全局" : "单分镜",
                functionSelectionScopes.samplingGlobal ? "全局" : "单分镜",
                selectionTextForShot(shot, "speed"),
                selectionTextForShot(shot, "optimization"),
                samplingSelectionText(shot),
                samplerPairTextForShot(shot),
                loraSelectionText(shot),
                loraGlobalSelectionText(),
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
                [["是否承接上一分镜", "是否继承上一帧", "是否继承", "继承上一帧"], "是否承接上一分镜"],
                [["生成类型（全参考生视频）", "生成类型"], "生成类型"],
                [["提示词", "分镜提示词"], "提示词"],
                [["参考图尺寸", "图片参数（MAX）", "图片参数"], "参考图尺寸"],
                [["宽高比", "画面比例"], "宽高比"],
                [["分辨率", "生成分辨率"], "分辨率"],
                [["保存文件名", "文件名"], "保存文件名"],
            ];
            for (const [aliases, label] of required) if (column(...aliases) < 0) throw new Error(`缺少列：${label}`);
            const valueAt = (row, ...names) => column(...names) < 0 ? "" : String(row[column(...names)] ?? "").trim();
            const dataRows = rows.slice(1).filter((row) => row.some((value) => String(value).trim()));
            if (!dataRows.length) throw new Error("表格没有可导入的分镜行");
            const first = dataRows[0];
            const aspect = valueAt(first, "画面比例", "宽高比").split(/[（ (]/)[0];
            if (resolutionRatios[aspect]) resolutionState.aspect = aspect;
            const resolutionText = valueAt(first, "生成分辨率", "分辨率");
            const mpMatch = resolutionText.match(/([0-9]+(?:\.[0-9]+)?)\s*MP/i);
            const sizeMatch = resolutionText.match(/(\d+)\s*[x×*]\s*(\d+)/i);
            if (mpMatch) resolutionState.megapixels = Math.max(0.1, Math.min(3, Number(mpMatch[1]) || 1));
            else if (sizeMatch) resolutionState.megapixels = Math.max(0.1, Math.min(3, Math.round((Number(sizeMatch[1]) * Number(sizeMatch[2]) / (1024 * 1024)) * 10) / 10));
            filenamePrefix = valueAt(first, "保存文件名");
            const importedContinuityFrames = dataRows
                .map((row) => Number(valueAt(row, "承接上下文帧数", "上下文帧数", "承接帧数")))
                .find((value) => Number.isFinite(value) && value > 0);
            if (importedContinuityFrames) continuityOverlapFrames = snapContinuityFrames(importedContinuityFrames);
            const speedScopeText = valueAt(first, "速度优化作用范围", "速度作用范围");
            const samplingScopeText = valueAt(first, "采样作用范围", "采样SIGMAS作用范围");
            functionSelectionScopes.speedOptimizationGlobal = speedScopeText ? speedScopeText !== "单分镜" : true;
            functionSelectionScopes.samplingGlobal = samplingScopeText ? samplingScopeText === "全局" : false;
            functionSelectionScopes.loraGlobalByNode = Object.fromEntries(
                parseNodeSelectionIds(valueAt(first, "LoRA 全局节点", "LORA全局节点", "LoRA全局节点"), "lora").map((id) => [id, true]),
            );
            if (functionSelectionScopes.speedOptimizationGlobal) {
                applyImportedGlobalNodeModes(dataRows, valueAt, "speed", "全局速度选择", "速度选择");
                applyImportedGlobalNodeModes(dataRows, valueAt, "optimization", "全局性能优化选择", "性能优化选择");
            }
            if (functionSelectionScopes.samplingGlobal) {
                const importedSamplingId = dataRows
                    .map((row) => parseSamplingSelection(valueAt(row, "采样 SIGMAS 选择", "采样SIGMAS选择", "采样选择")))
                    .find(Boolean);
                if (importedSamplingId) ensureFunctionSelectionDefaults().samplingNodeId = importedSamplingId;
            }
            const firstLoraModes = parseNodeModeSelection(valueAt(first, "LoRA 选择", "LORA选择", "LoRA选择"), "lora");
            if (firstLoraModes) {
                const defaults = ensureFunctionSelectionDefaults();
                for (const id of Object.keys(functionSelectionScopes.loraGlobalByNode)) {
                    if (Object.prototype.hasOwnProperty.call(firstLoraModes, id)) defaults.loraNodeModes[id] = firstLoraModes[id];
                }
            }

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
                const yes = ["是", "true", "1", "yes", "继承", "承接"].includes(valueAt(row, "是否承接上一分镜", "是否继承上一帧", "是否继承", "继承上一帧").toLowerCase());
                const shot = ensureModePrompts({ id: shotId, sheetNumber, title: valueAt(row, "分镜名称", "分镜名", "镜头名") || `分镜 ${sheetNumber}`, selected: true, prompt: valueAt(row, "提示词", "分镜提示词"), mode, seconds, inheritPrevious: index > 0 && yes, referenceSize: valueAt(row, "参考图尺寸", "图片参数（MAX）", "图片参数").toUpperCase() === "MAX" ? "max" : "match" });
                const samplingNodeId = parseSamplingSelection(valueAt(row, "采样 SIGMAS 选择", "采样SIGMAS选择", "采样选择"));
                const samplerPairName = valueAt(row, "采样器（自动匹配）", "采样器", "搭配采样器").toLowerCase();
                const importedSamplerPair = samplerChoiceNodes().find((item) => samplerNameOf(item) === samplerPairName);
                if (samplingNodeId && importedSamplerPair) samplingSamplerPairs[samplingNodeId] = functionNodeId(importedSamplerPair);
                if (!functionSelectionScopes.samplingGlobal && samplingNodeId) shot.functionSelections.samplingNodeId = samplingNodeId;
                if (!functionSelectionScopes.speedOptimizationGlobal) {
                    const speedModes = parseNodeModeSelection(valueAt(row, "速度选择", "全局速度选择"), "speed");
                    const optimizationModes = parseNodeModeSelection(valueAt(row, "性能优化选择", "全局性能优化选择"), "optimization");
                    if (speedModes) shot.functionSelections.speedNodeModes = speedModes;
                    if (optimizationModes) shot.functionSelections.optimizationNodeModes = optimizationModes;
                }
                const loraNodeModes = parseNodeModeSelection(valueAt(row, "LoRA 选择", "LORA选择", "LoRA选择"), "lora");
                if (loraNodeModes) {
                    const localLoraModes = Object.fromEntries(Object.entries(loraNodeModes).filter(([id]) => !functionSelectionScopes.loraGlobalByNode[id]));
                    if (Object.keys(localLoraModes).length) shot.functionSelections.loraNodeModes = localLoraModes;
                }
                importedShots.push(shot);
                for (let ref = 1; ref <= 9; ref += 1) await makeAssetFromPath(valueAt(row, `参考图片绝对路径${ref}`, `参考图绝对地址${ref}`), "image", shotId, rowNumber, `参考图片绝对路径${ref}`);
                for (let ref = 1; ref <= 3; ref += 1) await makeAssetFromPath(valueAt(row, `参考视频绝对路径${ref}`, `参考视频${ref}`), "video", shotId, rowNumber, `参考视频绝对路径${ref}`);
                for (let ref = 1; ref <= 3; ref += 1) await makeAssetFromPath(valueAt(row, `参考音频绝对路径${ref}`, `参考音频${ref}`), "audio", shotId, rowNumber, `参考音频绝对路径${ref}`);
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
                catch (error) { showDirectorError(String(error?.message || error)); renderLibrary(); }
            };
            card.querySelector("[data-library-rename]").onclick = async (event) => {
                event.preventDefault(); event.stopPropagation();
                const value = await openTextDialog({ title: "修改资产名称", label: "资产名称", value: asset.name || "", maxLength: 80 });
                if (value === null || !String(value).trim()) return;
                try { await persistLibraryAsset({ name: String(value).trim().slice(0, 80) }); renderLibrary(); renderAssets(); }
                catch (error) { showDirectorError(String(error?.message || error)); }
            };
            card.querySelector("[data-library-note]").onclick = async (event) => {
                event.preventDefault(); event.stopPropagation();
                const value = await openTextDialog({ title: "编辑资产备注", label: "备注（留空即删除）", value: String(asset.note || ""), maxLength: 2000 });
                if (value === null) return;
                try { await persistLibraryAsset({ note: String(value).trim().slice(0, 2000) }); renderLibrary(); renderAssets(); }
                catch (error) { showDirectorError(String(error?.message || error)); }
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
        if (!await openConfirmDialog({ title: "迁移旧资产", message: `检测到 ${records.length} 个旧资产。确认复制到公共“闲兔资产库”？旧 IndexedDB 不会删除。`, confirmText: "确认复制" })) return;
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
        const output = shot?.successfulOutput || shot?.lastOutput;
        const result = results.find((item) => String(item.shotId) === String(shot?.id)
            && (!output?.filename || item.filename === output.filename));
        return Math.max(1 / resolutionState.fps, Number(output?.duration
            || (Number(output?.frameCount) > 0 ? output.frameCount / (output.frameRate || resolutionState.fps) : 0)
            || (Number(result?.frameCount) > 0 ? result.frameCount / (result.frameRate || resolutionState.fps) : 0)
            || result?.actualDuration || result?.duration
            || shot?.seconds || 5));
    };
    const syncEditSegments = () => {
        const shotIds = new Set(shots.map((shot) => String(shot.id)));
        videoEditSegments = videoEditSegments.filter((segment) => shotIds.has(String(segment.shotId)));
        audioEditSegments = audioEditSegments.filter((segment) => shotIds.has(String(segment.shotId)));
        for (const shot of shots) {
            if (excludedTimelineShotIds.has(String(shot.id))) continue;
            if (videoEditSegments.some((segment) => String(segment.shotId) === String(shot.id))) continue;
            const videoSegment = { id: makeId(), shotId: String(shot.id), sourceStart: 0, sourceEnd: null };
            videoEditSegments.push(videoSegment);
            audioEditSegments.push({ id: makeId(), videoSegmentId: videoSegment.id, shotId: String(shot.id), sourceStart: 0, sourceEnd: null, timelineStart: 0, linked: true, muted: false, volume: 1, fadeIn: 0, fadeOut: 0 });
        }
        const segmentIds = new Set(videoEditSegments.map((segment) => String(segment.id)));
        audioEditSegments = audioEditSegments.filter((segment) => !segment.linked || segmentIds.has(String(segment.videoSegmentId)));
        const videoById = new Map(videoEditSegments.map((segment) => [String(segment.id), segment]));
        for (const audio of audioEditSegments) {
            if (!audio.linked) continue;
            const linkedVideo = videoById.get(String(audio.videoSegmentId));
            if (!linkedVideo) continue;
            audio.shotId = linkedVideo.shotId;
            audio.sourceStart = linkedVideo.sourceStart;
            audio.sourceEnd = linkedVideo.sourceEnd;
        }
        for (const segment of videoEditSegments) {
            if (audioEditSegments.some((audio) => String(audio.videoSegmentId) === String(segment.id))) continue;
            audioEditSegments.push({ id: makeId(), videoSegmentId: segment.id, shotId: segment.shotId, sourceStart: segment.sourceStart, sourceEnd: segment.sourceEnd, timelineStart: 0, linked: true, muted: false, volume: 1, fadeIn: 0, fadeOut: 0 });
        }
        const selectionExists = activeEditSelection?.kind === "video"
            ? videoEditSegments.some((segment) => String(segment.id) === String(activeEditSelection.id))
            : activeEditSelection?.kind === "audio"
                ? audioEditSegments.some((segment) => String(segment.id) === String(activeEditSelection.id))
                : false;
        if (!selectionExists) {
            const preferred = videoEditSegments.find((segment) => String(segment.shotId) === String(activeShotId)) || videoEditSegments[0];
            activeEditSelection = preferred ? { kind: "video", id: preferred.id } : null;
        }
    };
    const editSegmentBounds = (segment) => {
        const shot = shots.find((item) => String(item.id) === String(segment?.shotId));
        const sourceDuration = Math.max(1 / resolutionState.fps, timelineDurationForShot(shot));
        const sourceStart = Math.max(0, Math.min(sourceDuration - 1 / resolutionState.fps, Number(segment?.sourceStart || 0)));
        const savedEnd = segment?.sourceEnd;
        const hasSavedEnd = savedEnd !== null && savedEnd !== undefined && savedEnd !== ""
            && Number.isFinite(Number(savedEnd)) && Number(savedEnd) > sourceStart;
        const sourceEnd = Math.max(sourceStart + 1 / resolutionState.fps, Math.min(sourceDuration, hasSavedEnd ? Number(savedEnd) : sourceDuration));
        return { shot, sourceDuration, sourceStart, sourceEnd, duration: sourceEnd - sourceStart };
    };
    const timelineLayout = () => {
        syncEditSegments();
        const minimumDuration = 1 / resolutionState.fps;
        const overlapSeconds = continuityOverlapFrames / resolutionState.fps;
        let cursor = 0;
        let previousShotId = "";
        return videoEditSegments.map((segment, index) => {
            const { shot, duration } = editSegmentBounds(segment);
            const inherited = index > 0 && String(segment.shotId) !== previousShotId
                && Boolean(shot?.inheritPrevious || Number(shot?.contextTrimFrames || 0) > 0);
            // Generated files already exclude the disposable context prefix.
            // Their visible frames are consecutive, not duplicate intervals.
            const overlap = 0;
            const start = Math.max(0, cursor - overlap);
            const end = start + duration;
            cursor = Math.max(cursor, end);
            previousShotId = String(segment.shotId);
            return { segment, shot, index, duration, start, end, overlap, inherited };
        });
    };
    const audioTimelineLayout = (videoLayout = timelineLayout()) => {
        syncEditSegments();
        const items = audioEditSegments.map((segment, index) => {
            const bounds = editSegmentBounds(segment);
            const linkedVideo = videoLayout.find((item) => String(item.segment.id) === String(segment.videoSegmentId));
            const duration = Math.max(1 / resolutionState.fps, bounds.duration);
            const start = segment.linked && linkedVideo ? linkedVideo.start : Math.max(0, Number(segment.timelineStart || 0));
            const inherited = Boolean(segment.linked && linkedVideo?.inherited);
            const overlap = inherited ? Math.max(0, Number(linkedVideo?.overlap || 0)) : 0;
            return { segment, shot: bounds.shot, index, duration, start, end: start + duration, sourceStart: bounds.sourceStart, inherited, overlap };
        });
        for (const item of items) item.lane = item.segment.linked ? 0 : 1;
        return items;
    };
    const renderTimeline = () => {
        const ruler = q("[data-time-ruler]");
        const videoTrack = q("[data-video-track]");
        const audioTrack = q("[data-audio-track]");
        const playhead = q("[data-playhead]");
        const scale = timelineScale;
        const layout = timelineLayout();
        const audioLayout = audioTimelineLayout(layout);
        const totalDuration = Math.max(40, [...layout, ...audioLayout].reduce((maximum, item) => Math.max(maximum, item.end), 0));
        const width = Math.ceil(totalDuration * scale);
        for (const element of [ruler, videoTrack, audioTrack]) element.style.width = `${width}px`;
        ruler.innerHTML = Array.from({ length: Math.floor(totalDuration / 2) + 1 }, (_, index) => `<span style="left:${index * 2 * scale}px"><i></i>${index * 2}s</span>`).join("");
        const segmentLabel = (segment, shot) => {
            const shotNumber = Math.max(1, shots.findIndex((item) => String(item.id) === String(shot?.id)) + 1);
            const siblings = videoEditSegments.filter((item) => String(item.shotId) === String(segment.shotId));
            const part = siblings.findIndex((item) => String(item.id) === String(segment.id));
            return `分镜${String(shotNumber).padStart(2, "0")}${siblings.length > 1 ? `-${part + 1}` : ""}`;
        };
        videoTrack.innerHTML = layout.length ? layout.map(({ segment, shot, index, duration, start, overlap, inherited }) => {
            const left = Math.max(0, start * scale - (index > 0 ? 1 : 0));
            const generated = results.some((result) => String(result.shotId) === String(shot?.id));
            const selected = activeEditSelection?.kind === "video" && String(activeEditSelection.id) === String(segment.id);
            const overlapLayer = inherited && overlap > 0 ? `<span class="xve-timeline-overlap" style="width:${Math.max(1, overlap * scale)}px" title="与上一分镜重叠 ${continuityOverlapFrames} 帧"></span>` : "";
            return `<button type="button" class="${selected ? "active" : ""} ${generated ? "generated" : ""} ${inherited ? "inherited" : ""}" draggable="true" data-timeline-clip="${escapeHtml(segment.id)}" style="z-index:${index + 1};left:${left}px;width:${Math.max(1, duration * scale - 1)}px">${overlapLayer}<b>${segmentLabel(segment, shot)}</b><small>${duration.toFixed(1)}s</small><i data-trim-edge="start"></i><i data-trim-edge="end"></i></button>`;
        }).join("") : `<em>暂无视频片段</em>`;
        audioTrack.innerHTML = audioLayout.length ? audioLayout.map(({ segment, shot, index, duration, start, overlap, inherited, lane }) => {
            const naturalLeft = Math.max(0, Math.round(start * scale));
            const width = Math.max(1, Math.round(duration * scale) - 1);
            const left = naturalLeft;
            const generated = results.some((result) => String(result.shotId) === String(shot?.id));
            const selected = activeEditSelection?.kind === "audio" && String(activeEditSelection.id) === String(segment.id);
            const videoSegment = videoEditSegments.find((item) => String(item.id) === String(segment.videoSegmentId)) || segment;
            const overlapLayer = inherited && overlap > 0 ? `<span class="xve-timeline-overlap" style="width:${Math.max(1, overlap * scale)}px" title="与上一分镜音频重叠 ${continuityOverlapFrames} 帧"></span>` : "";
            return `<div class="${selected ? "active" : ""} ${generated ? "generated" : ""} ${inherited ? "inherited" : ""} ${segment.muted ? "muted" : ""} ${segment.linked ? "linked" : "unlinked"}" data-timeline-audio="${escapeHtml(segment.id)}" data-audio-lane="${lane || 0}" style="z-index:${index + 1};left:${left}px;width:${width}px">${overlapLayer}<b>${segmentLabel(videoSegment, shot)}${segment.linked ? "" : " · 独立"}${segment.muted ? " · 静音" : ""}</b><small>${duration.toFixed(1)}s</small><i data-trim-edge="start"></i><i data-trim-edge="end"></i></div>`;
        }).join("") : `<em>暂无音频片段</em>`;
        root.querySelectorAll("[data-timeline-clip]").forEach((clip) => {
            clip.onclick = (event) => {
                if (event.target.closest("[data-trim-edge]")) return;
                updatePrompt();
                const segment = videoEditSegments.find((item) => String(item.id) === String(clip.dataset.timelineClip));
                const item = layout.find((entry) => String(entry.segment.id) === String(segment?.id));
                const shot = item?.shot;
                if (!segment || !shot) return;
                const rect = clip.getBoundingClientRect();
                const localSeconds = Math.max(0, Math.min(item.duration, (event.clientX - rect.left) / Math.max(1, rect.width) * item.duration));
                const sourceSeconds = editSegmentBounds(segment).sourceStart + localSeconds;
                activeEditSelection = { kind: "video", id: segment.id };
                activeShotId = shot.id;
                timelinePlayheadSeconds = item.start + localSeconds;
                renderShots(); loadShot(); syncEditToolbar(); save();
                let resultIndex = results.findIndex((result) => String(result.shotId) === String(shot.id) && resultKind(result) === "after");
                if (resultIndex < 0) resultIndex = results.findIndex((result) => String(result.shotId) === String(shot.id) && resultKind(result) === "before");
                q("[data-playhead]").style.left = `${timelinePlayheadSeconds * timelineScale}px`;
                if (resultIndex >= 0) playResult(resultIndex, sourceSeconds);
            };
            clip.ondragstart = (event) => event.dataTransfer.setData("text/x-xiantu-result-index", clip.dataset.timelineClip);
            clip.ondragover = (event) => event.preventDefault();
            clip.ondrop = (event) => {
                event.preventDefault();
                const fromId = String(event.dataTransfer.getData("text/x-xiantu-result-index"));
                const toId = String(clip.dataset.timelineClip);
                const from = videoEditSegments.findIndex((item) => String(item.id) === fromId);
                const to = videoEditSegments.findIndex((item) => String(item.id) === toId);
                if (from < 0 || to < 0 || from === to) return;
                const [moved] = videoEditSegments.splice(from, 1); videoEditSegments.splice(to, 0, moved); renderTimeline(); save();
            };
        });
        root.querySelectorAll("[data-timeline-audio]").forEach((clip) => {
            clip.onclick = (event) => {
                if (clip._xveDragged) { clip._xveDragged = false; return; }
                if (event.target.closest("[data-trim-edge]")) return;
                updatePrompt();
                const segment = audioEditSegments.find((item) => String(item.id) === String(clip.dataset.timelineAudio));
                const item = audioLayout.find((entry) => String(entry.segment.id) === String(segment?.id));
                const shot = item?.shot;
                if (!segment || !shot) return;
                activeEditSelection = { kind: "audio", id: segment.id };
                activeShotId = shot.id;
                timelinePlayheadSeconds = item.start + Math.max(0, Math.min(item.duration, (event.clientX - clip.getBoundingClientRect().left) / Math.max(1, clip.getBoundingClientRect().width) * item.duration));
                renderShots(); loadShot(); renderTimeline(); syncEditToolbar(); save();
            };
            clip.onpointerdown = (event) => {
                if (event.button !== 0 || event.target.closest("[data-trim-edge]")) return;
                const segment = audioEditSegments.find((item) => String(item.id) === String(clip.dataset.timelineAudio));
                if (!segment || segment.linked) return;
                const originX = event.clientX;
                const originStart = Math.max(0, Number(segment.timelineStart || 0));
                let moved = false;
                const onMove = (moveEvent) => {
                    const delta = (moveEvent.clientX - originX) / timelineScale;
                    if (Math.abs(delta) > 0.03) moved = true;
                    segment.timelineStart = Math.max(0, originStart + delta);
                    clip.style.left = `${segment.timelineStart * timelineScale}px`;
                };
                const onUp = () => {
                    window.removeEventListener("pointermove", onMove);
                    window.removeEventListener("pointerup", onUp);
                    clip._xveDragged = moved;
                    renderTimeline(); save();
                };
                window.addEventListener("pointermove", onMove);
                window.addEventListener("pointerup", onUp, { once: true });
                event.preventDefault();
            };
        });
        root.querySelectorAll("[data-trim-edge]").forEach((handle) => {
            handle.onpointerdown = (event) => {
                if (event.button !== 0) return;
                const clip = handle.closest("[data-timeline-clip],[data-timeline-audio]");
                const kind = clip?.hasAttribute("data-timeline-clip") ? "video" : "audio";
                const id = kind === "video" ? clip?.dataset.timelineClip : clip?.dataset.timelineAudio;
                const segments = kind === "video" ? videoEditSegments : audioEditSegments;
                const segment = segments.find((item) => String(item.id) === String(id));
                if (!segment) return;
                const bounds = editSegmentBounds(segment);
                const edge = handle.dataset.trimEdge;
                const originX = event.clientX;
                const originStart = bounds.sourceStart;
                const originEnd = bounds.sourceEnd;
                const minimum = 1 / resolutionState.fps;
                const onMove = (moveEvent) => {
                    const delta = (moveEvent.clientX - originX) / timelineScale;
                    if (edge === "start") segment.sourceStart = Math.max(0, Math.min(originEnd - minimum, originStart + delta));
                    else segment.sourceEnd = Math.max(originStart + minimum, Math.min(bounds.sourceDuration, originEnd + delta));
                    if (kind === "video") {
                        const linkedAudio = audioEditSegments.find((item) => item.linked && String(item.videoSegmentId) === String(segment.id));
                        if (linkedAudio) {
                            linkedAudio.sourceStart = segment.sourceStart;
                            linkedAudio.sourceEnd = segment.sourceEnd;
                        }
                    }
                    clip.title = `${editSegmentBounds(segment).duration.toFixed(2)} 秒`;
                };
                const onUp = () => {
                    window.removeEventListener("pointermove", onMove);
                    window.removeEventListener("pointerup", onUp);
                    renderTimeline(); syncEditToolbar(); save();
                };
                window.addEventListener("pointermove", onMove);
                window.addEventListener("pointerup", onUp, { once: true });
                event.stopPropagation();
                event.preventDefault();
            };
        });
        const viewport = q("[data-timeline-viewport]");
        let scrubbingTimeline = false;
        const movePlayhead = (event) => {
            const rect = viewport.getBoundingClientRect();
            const left = Math.max(0, Math.min(width, event.clientX - rect.left + viewport.scrollLeft));
            playhead.style.left = `${left}px`;
            timelinePlayheadSeconds = left / scale;
            return left;
        };
        viewport.onpointerdown = (event) => {
            if (event.button !== 0 || event.target.closest("[data-timeline-clip],[data-timeline-audio]")) return;
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
        return timelineLayout().find(({ shot }) => String(shot.id) === String(result?.shotId))?.start || 0;
    };
    const syncPlayheadToVideo = () => {
        if (!previewResult || video.hidden) return;
        const current = Math.max(0, Number(video.currentTime || 0));
        const selectedSegment = activeEditSelection?.kind === "video" ? videoEditSegments.find((segment) => String(segment.id) === String(activeEditSelection.id)) : null;
        const selectedLayout = selectedSegment && String(selectedSegment.shotId) === String(previewResult.shotId) ? timelineLayout().find((item) => String(item.segment.id) === String(selectedSegment.id)) : null;
        const seconds = selectedLayout ? selectedLayout.start + Math.max(0, current - editSegmentBounds(selectedSegment).sourceStart) : resultStartTime(previewResult) + current;
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
        const matching = timelineLayout().filter(({ start, end }) => timelineSeconds >= start && timelineSeconds <= end).at(-1);
        if (matching) {
                const { segment, shot, start } = matching;
                activeEditSelection = { kind: "video", id: segment.id };
                activeShotId = shot.id;
                renderShots(); loadShot(); syncEditToolbar(); save();
                let resultIndex = results.findIndex((result) => String(result.shotId) === String(shot.id) && resultKind(result) === "after");
                if (resultIndex < 0) resultIndex = results.findIndex((result) => String(result.shotId) === String(shot.id) && resultKind(result) === "before");
                if (resultIndex >= 0) playResult(resultIndex, editSegmentBounds(segment).sourceStart + Math.max(0, timelineSeconds - start));
        }
    };
    const selectedVideoEditSegment = () => activeEditSelection?.kind === "video" ? videoEditSegments.find((segment) => String(segment.id) === String(activeEditSelection.id)) : null;
    const selectedAudioEditSegment = () => activeEditSelection?.kind === "audio" ? audioEditSegments.find((segment) => String(segment.id) === String(activeEditSelection.id)) : null;
    const syncEditToolbar = () => {
        const selectedVideo = selectedVideoEditSegment();
        const selectedAudio = selectedAudioEditSegment();
        q("[data-edit-split]").disabled = !selectedVideo;
        q("[data-edit-delete]").disabled = !selectedVideo && !selectedAudio;
        q("[data-edit-link]").disabled = !selectedAudio;
        q("[data-edit-link]").textContent = selectedAudio?.linked ? "音画解绑" : "音画联动";
        q("[data-edit-mute]").disabled = !selectedAudio;
        q("[data-edit-mute]").textContent = selectedAudio?.muted ? "恢复声音" : "静音";
        q("[data-edit-volume]").disabled = !selectedAudio;
        q("[data-edit-volume]").value = String(Math.round((selectedAudio?.volume ?? 1) * 100));
        q("[data-edit-volume-value]").textContent = `${Math.round((selectedAudio?.volume ?? 1) * 100)}%`;
        q("[data-edit-fade-in]").disabled = !selectedAudio;
        q("[data-edit-fade-out]").disabled = !selectedAudio;
        q("[data-edit-fade-in]").value = String(selectedAudio?.fadeIn || 0);
        q("[data-edit-fade-out]").value = String(selectedAudio?.fadeOut || 0);
    };
    const splitSelectedVideoSegment = () => {
        const segment = selectedVideoEditSegment();
        const index = videoEditSegments.indexOf(segment);
        const item = timelineLayout().find((entry) => String(entry.segment.id) === String(segment?.id));
        if (!segment || index < 0 || !item) return;
        const bounds = editSegmentBounds(segment);
        const local = timelinePlayheadSeconds - item.start;
        const minimum = Math.max(0.1, 2 / resolutionState.fps);
        if (local < minimum || local > bounds.duration - minimum) {
            q("[data-edit-split]").title = "请先把播放头放在选中片段内部，且距离边缘至少 0.1 秒";
            return;
        }
        const splitAt = bounds.sourceStart + local;
        const first = { ...segment, id: makeId(), sourceStart: bounds.sourceStart, sourceEnd: splitAt };
        const second = { ...segment, id: makeId(), sourceStart: splitAt, sourceEnd: bounds.sourceEnd };
        videoEditSegments.splice(index, 1, first, second);
        const linkedIndex = audioEditSegments.findIndex((audio) => audio.linked && String(audio.videoSegmentId) === String(segment.id));
        if (linkedIndex >= 0) {
            const audio = audioEditSegments[linkedIndex];
            audioEditSegments.splice(linkedIndex, 1,
                { ...audio, id: makeId(), videoSegmentId: first.id, sourceStart: bounds.sourceStart, sourceEnd: splitAt },
                { ...audio, id: makeId(), videoSegmentId: second.id, sourceStart: splitAt, sourceEnd: bounds.sourceEnd });
        }
        activeEditSelection = { kind: "video", id: second.id };
        renderTimeline(); syncEditToolbar(); save();
    };
    const deleteSelectedEditSegment = () => {
        const videoSegment = selectedVideoEditSegment();
        const audioSegment = selectedAudioEditSegment();
        if (videoSegment) {
            videoEditSegments = videoEditSegments.filter((segment) => String(segment.id) !== String(videoSegment.id));
            audioEditSegments = audioEditSegments.filter((segment) => !(segment.linked && String(segment.videoSegmentId) === String(videoSegment.id)));
            if (!videoEditSegments.some((segment) => String(segment.shotId) === String(videoSegment.shotId))) excludedTimelineShotIds.add(String(videoSegment.shotId));
        } else if (audioSegment) audioEditSegments = audioEditSegments.filter((segment) => String(segment.id) !== String(audioSegment.id));
        activeEditSelection = null;
        renderTimeline(); syncEditToolbar(); save();
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
            if (shot?.successfulOutput?.filename === oldFilename && String(shot.successfulOutput.subfolder || "") === String(payload.subfolder || current.subfolder || "")) {
                shot.successfulOutput = { ...shot.successfulOutput, filename: current.filename, subfolder: current.subfolder, type: current.type };
            }
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
        if (!selected.length || !await openConfirmDialog({ title: "删除资产", message: `确认从公共资产库删除 ${selected.length} 个资产？已经应用到分镜的 input 副本不会删除。`, confirmText: "确认删除" })) return;
        try {
            await commonAssetRequest("/xiantu/video-editor/common-assets/delete", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ids: selected.map((asset) => asset.id) }),
            });
            await loadLibraryAssets(); renderLibrary();
        } catch (error) { showDirectorError(String(error?.message || error)); }
    };
    q("[data-library-apply]").onclick = applyLibrarySelection;
    const libraryGrid = q("[data-library-grid]");
    libraryGrid.ondragover = (event) => { if (draggingFiles(event)) event.preventDefault(); };
    libraryGrid.ondrop = async (event) => { if (!draggingFiles(event)) return; event.preventDefault(); await addLibraryFiles(event.dataTransfer.files || []); };

    q("[data-add-shot]").onclick = () => {
        updatePrompt();
        const shot = ensureModePrompts({ id: makeId(), title: `分镜 ${shots.length + 1}`, selected: true, prompt: "", prompts: {}, mode: activeShot()?.mode || "reference", seconds: activeShot()?.seconds || 5, inheritPrevious: true, referenceSize: activeShot()?.referenceSize || referenceSize, functionSelections: {} });
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
        shots = [ensureModePrompts({ id: makeId(), title: "分镜 1", selected: true, prompt: "", prompts: {}, mode: "reference", seconds: 5, inheritPrevious: false, referenceSize: "match" })];
        activeShotId = shots[0].id; renderShots(); loadShot(); save();
    };
    q("[data-prev-shot]").onclick = () => moveShot(-1);
    q("[data-next-shot]").onclick = () => moveShot(1);
    const placeholderDialog = q("[data-placeholder-dialog]");
    const closePlaceholderDialog = () => { placeholderDialog.hidden = true; };
    let activeFunctionTagFilter = "speed";
    const functionTaggedNodes = (category) => {
        const graph = node.graph || app.graph, scope = workbenchGraphScope(graph, node.id).ids;
        return (graph?._nodes || []).filter((item) => item !== node && scope.has(String(item.id))
            && readFunctionTag(item)?.category === category);
    };
    const commitNodeMode = (item, mode) => {
        if (Number(item.mode || 0) === mode) return;
        item.mode = mode;
        item.graph?.change?.();
        item.graph?.setDirtyCanvas?.(true, true);
    };
    const functionNodeId = (item) => String(item?.id ?? "");
    const normalizedNodeMode = (value, fallback = 0) => [0, 2, 4].includes(Number(value)) ? Number(value) : fallback;
	    const currentFunctionNodeModes = (category) => Object.fromEntries(functionTaggedNodes(category).map((item) => [functionNodeId(item), normalizedNodeMode(item.mode)]));
	    const currentLoraNodeModes = () => currentFunctionNodeModes("lora");
    const ensureFunctionSelectionDefaults = () => {
	        const samplingNodes = functionTaggedNodes("sampling");
	        const loraNodes = functionTaggedNodes("lora");
        const saved = functionSelectionDefaults && typeof functionSelectionDefaults === "object" ? functionSelectionDefaults : {};
        const savedSamplingId = String(saved.samplingNodeId || "");
        const defaultSampling = samplingNodes.find((item) => functionNodeId(item) === savedSamplingId)
            || samplingNodes.find((item) => Number(item.mode || 0) === 0)
            || samplingNodes[0]
            || null;
        const savedLoraModes = saved.loraNodeModes && typeof saved.loraNodeModes === "object" ? saved.loraNodeModes : {};
	        functionSelectionDefaults = {
	            samplingNodeId: defaultSampling ? functionNodeId(defaultSampling) : "",
	            loraNodeModes: Object.fromEntries(loraNodes.map((item) => {
	                const id = functionNodeId(item);
	                return [id, normalizedNodeMode(savedLoraModes[id], normalizedNodeMode(item.mode))];
	            })),
	        };
	        for (const category of ["speed", "optimization"]) {
	            const key = `${category}NodeModes`;
	            const savedModes = saved[key] && typeof saved[key] === "object" ? saved[key] : {};
	            functionSelectionDefaults[key] = Object.fromEntries(functionTaggedNodes(category).map((item) => {
	                const id = functionNodeId(item);
	                return [id, normalizedNodeMode(savedModes[id], normalizedNodeMode(item.mode))];
	            }));
	        }
	        return functionSelectionDefaults;
	    };
	    const shotHasSamplingOverride = (shot) => Boolean(shot?.functionSelections?.samplingNodeId);
	    const shotHasLoraOverride = (shot) => Boolean(shot?.functionSelections?.loraNodeModes
	        && typeof shot.functionSelections.loraNodeModes === "object"
	        && Object.keys(shot.functionSelections.loraNodeModes).some((id) => !functionSelectionScopes.loraGlobalByNode?.[id]));
	    const NODE_MODE_LABELS = { 0: "启用", 4: "忽略", 2: "关闭" };
	    const NODE_MODE_VALUES = { "启用": 0, "忽略": 4, "关闭": 2, "0": 0, "4": 4, "2": 2 };
	    const nodeModeSelectionText = (category, modes = null) => functionTaggedNodes(category).map((item) => {
	        const id = functionNodeId(item);
	        const mode = normalizedNodeMode(modes?.[id], normalizedNodeMode(item.mode));
	        return `${String(item.title || item.type || "未命名节点")} [${id}]=${NODE_MODE_LABELS[mode]}`;
	    }).join("；");
	    const samplingSelectionText = (shot) => {
	        const defaults = ensureFunctionSelectionDefaults();
	        const id = functionSelectionScopes.samplingGlobal
	            ? String(defaults.samplingNodeId || "")
	            : (shotHasSamplingOverride(shot) ? String(shot.functionSelections.samplingNodeId) : String(defaults.samplingNodeId || ""));
	        if (!id) return "默认";
	        const item = functionTaggedNodes("sampling").find((candidate) => functionNodeId(candidate) === id);
	        return item ? `${String(item.title || item.type || "未命名节点")} [${id}]` : `节点 [${id}]`;
	    };
	    const samplerPairTextForShot = (shot) => {
	        const tagged = functionTaggedNodes("sampling");
	        const defaults = ensureFunctionSelectionDefaults();
	        const requestedId = !functionSelectionScopes.samplingGlobal && shotHasSamplingOverride(shot)
	            ? String(shot.functionSelections.samplingNodeId)
	            : String(defaults.samplingNodeId || "");
	        const selected = tagged.find((item) => functionNodeId(item) === requestedId) || tagged[0] || null;
	        return selected ? samplerPairKeyFor(selected, tagged) : "";
	    };
	    const effectiveNodeModesForShot = (shot, category) => {
	        const defaults = ensureFunctionSelectionDefaults();
	        const key = `${category}NodeModes`;
	        const overrides = shot?.functionSelections?.[key] && typeof shot.functionSelections[key] === "object" ? shot.functionSelections[key] : {};
	        return Object.fromEntries(functionTaggedNodes(category).map((item) => {
	            const id = functionNodeId(item);
	            const forceGlobal = (category === "lora" && Boolean(functionSelectionScopes.loraGlobalByNode?.[id]))
	                || (["speed", "optimization"].includes(category) && functionSelectionScopes.speedOptimizationGlobal);
	            const mode = forceGlobal
	                ? normalizedNodeMode(defaults[key]?.[id], normalizedNodeMode(item.mode))
	                : normalizedNodeMode(overrides[id], normalizedNodeMode(defaults[key]?.[id], normalizedNodeMode(item.mode)));
	            return [id, mode];
	        }));
	    };
	    const selectionTextForShot = (shot, category) => nodeModeSelectionText(category, effectiveNodeModesForShot(shot, category));
	    const loraSelectionText = (shot) => selectionTextForShot(shot, "lora") || "默认";
	    const loraGlobalSelectionText = () => functionTaggedNodes("lora")
	        .filter((item) => Boolean(functionSelectionScopes.loraGlobalByNode?.[functionNodeId(item)]))
	        .map((item) => `${String(item.title || item.type || "未命名节点")} [${functionNodeId(item)}]`)
	        .join("；");
	    const parseNodeModeSelection = (value, category) => {
	        const text = String(value || "").trim();
	        if (!text || text === "默认") return null;
	        const tagged = functionTaggedNodes(category);
	        const parsed = {};
	        for (const part of text.split(/[；;]/).map((item) => item.trim()).filter(Boolean)) {
	            const modeMatch = part.match(/(?:=|:|：)\s*(启用|忽略|关闭|0|2|4)\s*$/);
	            if (!modeMatch) continue;
	            const idMatch = part.match(/\[(\d+)\]/) || part.match(/节点\s*(\d+)/);
	            const name = part.replace(/\s*\[\d+\].*$/, "").replace(/\s*(?:=|:|：).*$/, "").trim();
	            const target = (idMatch ? tagged.find((item) => functionNodeId(item) === idMatch[1]) : null)
	                || tagged.find((item) => String(item.title || item.type || "").trim() === name);
	            if (target) parsed[functionNodeId(target)] = NODE_MODE_VALUES[modeMatch[1]];
	        }
	        return Object.keys(parsed).length ? parsed : null;
	    };
	    const parseSamplingSelection = (value) => {
	        const text = String(value || "").trim();
	        if (!text || text === "默认") return "";
	        const tagged = functionTaggedNodes("sampling");
	        const idMatch = text.match(/\[(\d+)\]/) || text.match(/节点\s*(\d+)/);
	        if (idMatch && tagged.some((item) => functionNodeId(item) === idMatch[1])) return idMatch[1];
	        const name = text.replace(/\s*\[\d+\].*$/, "").trim();
	        const target = tagged.find((item) => String(item.title || item.type || "").trim() === name);
	        return target ? functionNodeId(target) : "";
	    };
	    const parseNodeSelectionIds = (value, category) => {
	        const text = String(value || "").trim();
	        if (!text) return [];
	        const tagged = functionTaggedNodes(category);
	        const ids = [];
	        for (const part of text.split(/[；;]/).map((item) => item.trim()).filter(Boolean)) {
	            const idMatch = part.match(/\[(\d+)\]/) || part.match(/节点\s*(\d+)/);
	            const name = part.replace(/\s*\[\d+\].*$/, "").trim();
	            const target = (idMatch ? tagged.find((item) => functionNodeId(item) === idMatch[1]) : null)
	                || tagged.find((item) => String(item.title || item.type || "").trim() === name);
	            if (target) ids.push(functionNodeId(target));
	        }
	        return [...new Set(ids)];
	    };
	    const applyImportedGlobalNodeModes = (rows, valueAt, category, ...headers) => {
	        const text = rows.map((row) => valueAt(row, ...headers)).find((value) => value && value !== "默认");
	        const modes = parseNodeModeSelection(text, category);
	        if (!modes) return;
	        for (const item of functionTaggedNodes(category)) {
	            const id = functionNodeId(item);
	            if (Object.prototype.hasOwnProperty.call(modes, id)) commitNodeMode(item, normalizedNodeMode(modes[id], normalizedNodeMode(item.mode)));
	        }
	        ensureFunctionSelectionDefaults()[`${category}NodeModes`] = { ...currentFunctionNodeModes(category) };
	    };
    const normalizeSamplingSelection = (tagged, preferred = null) => {
        if (!tagged.length) return;
        const enabled = tagged.filter((item) => Number(item.mode || 0) === 0);
        const selected = preferred || enabled[0] || tagged[0];
        commitNodeMode(selected, 0);
        for (const item of enabled) {
            if (item !== selected) commitNodeMode(item, 4);
        }
    };
    const samplerNameOf = (item) => {
        const widget = (item?.widgets || []).find((candidate) => String(candidate?.name || "").toLowerCase() === "sampler_name");
        return String(widget?.value || "").trim().toLowerCase();
    };
    const samplerChoiceNodes = () => {
        const graph = node.graph || app.graph;
        const scope = workbenchGraphScope(graph, node.id).ids;
        const all = (graph?._nodes || []).filter((item) => item !== node
            && scope.has(String(item.id))
            && samplerNameOf(item)
            && (item.outputs || []).some((output) => String(output?.type || "").toUpperCase() === "SAMPLER"));
        const graphLink = (linkId) => graph?.links instanceof Map ? graph.links.get(linkId) : graph?.links?.[linkId];
        const connected = all.filter((item) => (item.outputs || []).some((output) => (output?.links || []).some((linkId) => {
            const link = graphLink(linkId);
            const targetId = Array.isArray(link) ? link[3] : link?.target_id;
            const target = graph?.getNodeById?.(targetId) || (graph?._nodes || []).find((candidate) => String(candidate?.id) === String(targetId));
            return String(target?.comfyClass || target?.type || "") === "XiantuSamplerConditionalRelay";
        })));
        return connected;
    };
    const ensureSamplerPairMappings = (tagged, candidates = samplerChoiceNodes()) => {
        const candidateIds = new Set(candidates.map(functionNodeId));
        samplingSamplerPairs = Object.fromEntries(Object.entries(samplingSamplerPairs).filter(([samplingId, samplerId]) =>
            tagged.some((item) => functionNodeId(item) === samplingId) && candidateIds.has(String(samplerId))));
        const usedSamplerIds = new Set(Object.values(samplingSamplerPairs));
        for (let index = 0; index < tagged.length; index += 1) {
            const samplingId = functionNodeId(tagged[index]);
            if (samplingSamplerPairs[samplingId]) continue;
            let paired = null;
            if (index < 3) paired = candidates.find((item) => samplerNameOf(item) === "er_sde") || null;
            else if (index === 3) paired = candidates.find((item) => samplerNameOf(item) === "res_multistep") || null;
            if (!paired) paired = candidates.find((item) => !usedSamplerIds.has(functionNodeId(item))) || null;
            if (!paired) paired = candidates[0] || null;
            if (paired) {
                samplingSamplerPairs[samplingId] = functionNodeId(paired);
                usedSamplerIds.add(functionNodeId(paired));
            }
        }
        return samplingSamplerPairs;
    };
    const samplerPairFor = (selected, tagged, candidates = samplerChoiceNodes()) => {
        if (!selected) return null;
        ensureSamplerPairMappings(tagged, candidates);
        const pairedId = samplingSamplerPairs[functionNodeId(selected)];
        return candidates.find((item) => functionNodeId(item) === String(pairedId || "")) || null;
    };
    const samplerPairKeyFor = (selected, tagged) => samplerNameOf(samplerPairFor(selected, tagged));
    const syncSamplerPairForSamplingSelection = (tagged) => {
        const selected = tagged.find((item) => Number(item.mode || 0) === 0) || tagged[0] || null;
        const candidates = samplerChoiceNodes();
        const paired = samplerPairFor(selected, tagged, candidates);
        const pairKey = samplerNameOf(paired);
        for (const candidate of candidates) commitNodeMode(candidate, candidate === paired ? 0 : 4);
        return { selected, pairKey, paired, candidates };
    };
    const applyShotFunctionSelections = (shot) => {
        if (!shot) return;
        ensureModePrompts(shot);
        const defaults = ensureFunctionSelectionDefaults();
        const samplingNodes = functionTaggedNodes("sampling");
        const requestedSamplingId = !functionSelectionScopes.samplingGlobal && shotHasSamplingOverride(shot)
            ? String(shot.functionSelections.samplingNodeId)
            : String(defaults.samplingNodeId || "");
        const selectedSampling = samplingNodes.find((item) => functionNodeId(item) === requestedSamplingId)
            || samplingNodes.find((item) => functionNodeId(item) === String(defaults.samplingNodeId || ""))
            || samplingNodes[0]
            || null;
        normalizeSamplingSelection(samplingNodes, selectedSampling);
        syncSamplerPairForSamplingSelection(samplingNodes);
	        const loraModes = shot?.functionSelections?.loraNodeModes && typeof shot.functionSelections.loraNodeModes === "object" ? shot.functionSelections.loraNodeModes : {};
        for (const item of functionTaggedNodes("lora")) {
            const id = functionNodeId(item);
	            const mode = functionSelectionScopes.loraGlobalByNode?.[id]
	                ? normalizedNodeMode(defaults.loraNodeModes?.[id], normalizedNodeMode(item.mode))
	                : normalizedNodeMode(loraModes[id], normalizedNodeMode(defaults.loraNodeModes?.[id], normalizedNodeMode(item.mode)));
	            commitNodeMode(item, mode);
	        }
	        for (const category of ["speed", "optimization"]) {
	            const key = `${category}NodeModes`;
	            const modes = !functionSelectionScopes.speedOptimizationGlobal && shot?.functionSelections?.[key] && typeof shot.functionSelections[key] === "object" ? shot.functionSelections[key] : {};
	            for (const item of functionTaggedNodes(category)) {
	                const id = functionNodeId(item);
	                commitNodeMode(item, normalizedNodeMode(modes[id], normalizedNodeMode(defaults[key]?.[id], normalizedNodeMode(item.mode))));
	            }
	        }
    };
    const rememberShotSamplingSelection = (shot) => {
        if (!shot) return;
        ensureModePrompts(shot);
        const selected = functionTaggedNodes("sampling").find((item) => Number(item.mode || 0) === 0);
        if (!selected) return;
        const id = functionNodeId(selected);
        if (functionSelectionScopes.samplingGlobal) {
            ensureFunctionSelectionDefaults().samplingNodeId = id;
            for (const item of shots) delete ensureModePrompts(item).functionSelections.samplingNodeId;
        } else {
            shot.functionSelections.samplingNodeId = id;
        }
    };
	    const rememberShotLoraSelection = (shot, item) => {
        if (!shot) return;
        ensureModePrompts(shot);
	        const id = functionNodeId(item);
	        const mode = normalizedNodeMode(item.mode);
	        const defaults = ensureFunctionSelectionDefaults();
	        if (functionSelectionScopes.loraGlobalByNode?.[id]) {
	            defaults.loraNodeModes[id] = mode;
	            for (const target of shots) {
	                ensureModePrompts(target);
	                if (target.functionSelections.loraNodeModes) delete target.functionSelections.loraNodeModes[id];
	            }
	        } else {
	            shot.functionSelections.loraNodeModes ??= {};
	            shot.functionSelections.loraNodeModes[id] = mode;
	        }
	    };
	    const rememberShotSpeedOptimizationSelection = (shot, category) => {
	        if (!shot || !["speed", "optimization"].includes(category)) return;
	        ensureModePrompts(shot);
	        const key = `${category}NodeModes`;
	        const modes = currentFunctionNodeModes(category);
	        if (functionSelectionScopes.speedOptimizationGlobal) {
	            ensureFunctionSelectionDefaults()[key] = modes;
	            for (const target of shots) delete ensureModePrompts(target).functionSelections[key];
	        } else {
	            shot.functionSelections[key] = modes;
	        }
	    };
    const renderShotFunctionSelectionStatus = () => {
        const shot = activeShot();
        const samplingState = q("[data-sampling-shot-state]");
        const samplingDefault = q("[data-sampling-use-default]");
        const loraState = q("[data-lora-shot-state]");
        const loraDefault = q("[data-lora-use-default]");
        const samplingGlobal = q("[data-sampling-global]");
        const speedOptimizationGlobal = q("[data-speed-optimization-global]");
        if (samplingGlobal) samplingGlobal.checked = Boolean(functionSelectionScopes.samplingGlobal);
        if (speedOptimizationGlobal) speedOptimizationGlobal.checked = Boolean(functionSelectionScopes.speedOptimizationGlobal);
        if (samplingState) samplingState.textContent = functionSelectionScopes.samplingGlobal
            ? "全局设置"
            : (shotHasSamplingOverride(shot) ? "当前分镜：独立设置" : "当前分镜：默认设置");
        if (samplingDefault) samplingDefault.disabled = functionSelectionScopes.samplingGlobal || !shotHasSamplingOverride(shot);
        if (loraState) loraState.textContent = shotHasLoraOverride(shot) ? "当前分镜含独立设置" : "当前分镜：默认设置";
        if (loraDefault) loraDefault.disabled = !shotHasLoraOverride(shot);
    };
    const renderSamplerPairing = () => {
        const list = q("[data-sampler-pair-list]");
        if (!list) return;
        const tagged = functionTaggedNodes("sampling");
        const { pairKey, paired, candidates } = syncSamplerPairForSamplingSelection(tagged);
        list.replaceChildren();
        const ruleFor = (name) => name === "er_sde"
            ? "上方 3 个 SIGMAS 专用"
            : (name === "res_multistep" ? "原最下方 SIGMAS 专用" : "与新增 SIGMAS 动态配对");
        const definitions = candidates.map((item) => ({ name: samplerNameOf(item), rule: ruleFor(samplerNameOf(item)), item }));
        for (const definition of definitions) {
            const item = definition.item || candidates.find((candidate) => samplerNameOf(candidate) === definition.name) || null;
            const active = pairKey === definition.name && paired === item;
            const row = document.createElement("article");
            row.className = `xve-sampler-pair-row${active ? " active" : ""}${item ? "" : " missing"}`;
            row.innerHTML = `<div><b>${escapeHtml(definition.name)}</b><span>${escapeHtml(definition.rule)}${item ? ` · 节点 ${escapeHtml(String(item.id ?? "-"))}` : " · 未找到对应采样器节点"}</span></div><button type="button" disabled>${item ? (active ? "已自动匹配" : "未匹配") : "未找到"}</button>`;
            list.appendChild(row);
        }
        if (!definitions.length) {
            const empty = document.createElement("div");
            empty.className = "xve-function-tag-empty";
            empty.textContent = "暂无接入采样器中转的采样器选择节点";
            list.appendChild(empty);
        }
    };
    const fillFunctionTaggedNodeList = (list, category) => {
        if (!list) return;
        const tagged = functionTaggedNodes(category);
        if (category === "sampling") {
            normalizeSamplingSelection(tagged);
            ensureSamplerPairMappings(tagged);
        }
        list.replaceChildren();
        for (const item of tagged) {
            const tag = readFunctionTag(item);
            const row = document.createElement("article");
            row.className = "xve-function-tag-row";
            let savedNote = String(tag?.note || "").trim().slice(0, 160);
            const loraGlobalControl = category === "lora"
                ? `<label class="xve-row-global"><input type="checkbox" data-lora-node-global${functionSelectionScopes.loraGlobalByNode?.[functionNodeId(item)] ? " checked" : ""}> 全局</label>`
                : "";
            const samplingPairControl = category === "sampling"
                ? `<label class="xve-sampling-pair">搭配<select data-sampling-pair>${samplerChoiceNodes().map((sampler) => `<option value="${escapeHtml(functionNodeId(sampler))}"${samplingSamplerPairs[functionNodeId(item)] === functionNodeId(sampler) ? " selected" : ""}>${escapeHtml(samplerNameOf(sampler))}</option>`).join("")}</select></label>`
                : "";
            row.classList.toggle("has-row-global", category === "lora");
            row.classList.toggle("has-sampling-pair", category === "sampling");
            row.innerHTML = `<div><b>${escapeHtml(String(item.title || item.type || "未命名节点"))}</b><span>${escapeHtml(functionTagDisplayName(tag))} · 节点 ${escapeHtml(String(item.id ?? "-"))}</span></div><div class="xve-function-tag-note-box"><span class="xve-function-tag-note-text${savedNote ? "" : " empty"}" data-node-note-text>${escapeHtml(savedNote || "暂无备注")}</span><input class="xve-function-tag-note" type="text" maxlength="160" value="${escapeHtml(savedNote)}" placeholder="备注这个节点的功能" hidden></div>${samplingPairControl}${loraGlobalControl}<button type="button" class="xve-function-tag-note-edit" data-node-note-edit>编辑</button><div class="xve-function-tag-modes"><button type="button" data-node-mode="0">启用</button><button type="button" data-node-mode="4">忽略</button><button type="button" data-node-mode="2">关闭</button></div>`;
            const noteText = row.querySelector("[data-node-note-text]");
            const noteInput = row.querySelector(".xve-function-tag-note");
            const noteEdit = row.querySelector("[data-node-note-edit]");
            let editingNote = false;
            const finishNoteEdit = (commit) => {
                if (!editingNote) return;
                editingNote = false;
                let nextNote = savedNote;
                if (commit) nextNote = String(noteInput.value || "").trim().slice(0, 160);
                noteInput.value = nextNote;
                noteInput.hidden = true;
                noteText.hidden = false;
                noteText.textContent = nextNote || "暂无备注";
                noteText.classList.toggle("empty", !nextNote);
                noteEdit.textContent = "编辑";
                if (!commit || nextNote === savedNote) return;
                item.properties ??= {};
                const currentTag = readFunctionTag(item) || { category, note: "" };
                item.properties[FUNCTION_TAG] = { ...currentTag, note: nextNote };
                savedNote = nextNote;
                item.graph?.change?.();
                item.graph?.setDirtyCanvas?.(true, true);
            };
            noteEdit.onclick = () => {
                if (editingNote) { finishNoteEdit(true); return; }
                editingNote = true;
                noteText.hidden = true;
                noteInput.hidden = false;
                noteEdit.textContent = "保存";
                noteInput.focus();
                noteInput.select();
            };
            noteInput.onkeydown = (event) => {
                if (event.key === "Enter") { event.preventDefault(); finishNoteEdit(true); }
                if (event.key === "Escape") { event.preventDefault(); finishNoteEdit(false); }
            };
            const loraGlobal = row.querySelector("[data-lora-node-global]");
            if (loraGlobal) {
                loraGlobal.onchange = () => {
                    const id = functionNodeId(item);
                    functionSelectionScopes.loraGlobalByNode[id] = Boolean(loraGlobal.checked);
                    if (loraGlobal.checked) {
                        const defaults = ensureFunctionSelectionDefaults();
                        defaults.loraNodeModes[id] = normalizedNodeMode(item.mode);
                        for (const target of shots) {
                            ensureModePrompts(target);
                            if (target.functionSelections.loraNodeModes) delete target.functionSelections.loraNodeModes[id];
                        }
                    }
                    renderLoraTaggedNodes();
                    save();
                };
            }
            const samplingPair = row.querySelector("[data-sampling-pair]");
            if (samplingPair) {
                samplingPair.onchange = () => {
                    samplingSamplerPairs[functionNodeId(item)] = String(samplingPair.value || "");
                    syncSamplerPairForSamplingSelection(tagged);
                    renderSamplingTaggedNodes();
                    save();
                };
            }
            row.querySelectorAll("[data-node-mode]").forEach((button) => {
                const mode = Number(button.dataset.nodeMode);
                button.classList.toggle("active", Number(item.mode || 0) === mode);
                button.onclick = () => {
                    if (category === "sampling" && mode === 0) {
                        for (const candidate of tagged) commitNodeMode(candidate, candidate === item ? 0 : 4);
                    } else {
                        const wasEnabled = Number(item.mode || 0) === 0;
                        commitNodeMode(item, mode);
                        if (category === "sampling" && wasEnabled && mode !== 0) {
                            const replacement = tagged.find((candidate) => candidate !== item && Number(candidate.mode || 0) === 0)
                                || tagged.find((candidate) => candidate !== item);
                            if (replacement) commitNodeMode(replacement, 0);
                            else commitNodeMode(item, 0);
                        }
                    }
                    if (activeFunctionTagFilter === category) renderFunctionTaggedNodes();
                    if (category === "sampling") {
                        rememberShotSamplingSelection(activeShot());
                        renderSamplingTaggedNodes();
                        save();
                    }
	                    if (category === "lora") {
	                        rememberShotLoraSelection(activeShot(), item);
	                        renderLoraTaggedNodes();
	                        save();
	                    }
	                    if (["speed", "optimization"].includes(category)) {
	                        rememberShotSpeedOptimizationSelection(activeShot(), category);
	                        renderFunctionTaggedNodes();
	                        save();
	                    }
	                };
            });
            list.appendChild(row);
        }
        if (!tagged.length) {
            const empty = document.createElement("div");
            empty.className = "xve-function-tag-empty";
            empty.textContent = `暂无“${FUNCTION_TAG_LABELS[category]}”标记节点，请在节点右键菜单中添加闲兔功能标记。`;
            list.appendChild(empty);
        }
    };
	    const renderFunctionTaggedNodes = () => {
	        root.querySelectorAll("[data-function-tag-filter]").forEach((button) => button.classList.toggle("active", button.dataset.functionTagFilter === activeFunctionTagFilter));
        fillFunctionTaggedNodeList(q("[data-function-tag-list]"), activeFunctionTagFilter);
        renderShotFunctionSelectionStatus();
    };
    const renderSamplingTaggedNodes = () => {
        fillFunctionTaggedNodeList(q("[data-sampling-tag-list]"), "sampling");
        renderSamplerPairing();
        renderShotFunctionSelectionStatus();
    };
    const renderLoraTaggedNodes = () => {
        fillFunctionTaggedNodeList(q("[data-lora-tag-list]"), "lora");
        renderShotFunctionSelectionStatus();
    };
	    const openPlaceholderDialog = () => {
	        const title = "速度性能优化";
	        q("[data-placeholder-title]").textContent = title;
	        applyShotFunctionSelections(activeShot());
	        renderFunctionTaggedNodes();
        placeholderDialog.hidden = false;
        q("[data-placeholder-close]")?.focus();
    };
	    root.querySelectorAll("[data-function-tag-filter]").forEach((button) => {
	        button.onclick = () => { activeFunctionTagFilter = button.dataset.functionTagFilter; renderFunctionTaggedNodes(); };
	    });
    q("[data-speed-optimization-global]").onchange = (event) => {
        functionSelectionScopes.speedOptimizationGlobal = Boolean(event.target.checked);
        if (functionSelectionScopes.speedOptimizationGlobal) {
            const defaults = ensureFunctionSelectionDefaults();
            for (const category of ["speed", "optimization"]) {
                const key = `${category}NodeModes`;
                defaults[key] = currentFunctionNodeModes(category);
                for (const shot of shots) delete ensureModePrompts(shot).functionSelections[key];
            }
        }
        renderFunctionTaggedNodes();
        save();
    };
    root.querySelectorAll("[data-open-placeholder]").forEach((button) => {
        button.onclick = () => openPlaceholderDialog();
    });
    root.querySelectorAll("[data-placeholder-close]").forEach((button) => { button.onclick = closePlaceholderDialog; });
    placeholderDialog.onclick = (event) => { if (event.target === placeholderDialog) closePlaceholderDialog(); };
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
        updatePrompt(true);
        const endRange = document.createRange();
        endRange.selectNodeContents(promptEditor);
        endRange.collapse(false);
        selection?.removeAllRanges();
        selection?.addRange(endRange);
        refreshMentionMenu();
    };
    promptEditor.oninput = () => {
        updatePrompt(true);
        refreshMentionMenu();
    };
    promptEditor.oncompositionend = refreshMentionMenu;
    promptEditor.onkeyup = (event) => {
        if (["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)) return;
        refreshMentionMenu();
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
        syncContinuityUI(); syncModeUI(); renderTimeline(); save();
    };
    q("[data-continuity-frames]").onchange = (event) => { continuityOverlapFrames = snapContinuityFrames(event.target.value); syncContinuityUI(); renderTimeline(); save(); };
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
    const sigmaDialog = q("[data-sigma-dialog]");
    const closeSigmaDialog = () => { sigmaDialog.hidden = true; };
    q("[data-sigma-open]").onclick = () => {
        applyShotFunctionSelections(activeShot());
        renderSamplingTaggedNodes();
        sigmaDialog.hidden = false;
        q("[data-sigma-close]")?.focus();
    };
    q("[data-sampling-global]").onchange = (event) => {
        functionSelectionScopes.samplingGlobal = Boolean(event.target.checked);
        if (functionSelectionScopes.samplingGlobal) {
            const selected = functionTaggedNodes("sampling").find((item) => Number(item.mode || 0) === 0);
            if (selected) ensureFunctionSelectionDefaults().samplingNodeId = functionNodeId(selected);
            for (const shot of shots) delete ensureModePrompts(shot).functionSelections.samplingNodeId;
        }
        applyShotFunctionSelections(activeShot());
        renderSamplingTaggedNodes();
        save();
    };
    q("[data-sampling-use-default]").onclick = () => {
        const shot = activeShot();
        if (!shot) return;
        ensureModePrompts(shot);
        delete shot.functionSelections.samplingNodeId;
        applyShotFunctionSelections(shot);
        renderSamplingTaggedNodes();
        save();
    };
    root.querySelectorAll("[data-sigma-close]").forEach((button) => { button.onclick = closeSigmaDialog; });
    sigmaDialog.onclick = (event) => { if (event.target === sigmaDialog) closeSigmaDialog(); };
    const loraDialog = q("[data-lora-dialog]");
    const closeLoraDialog = () => { loraDialog.hidden = true; };
    q("[data-lora-open]").onclick = () => { applyShotFunctionSelections(activeShot()); renderLoraTaggedNodes(); loraDialog.hidden = false; q("[data-lora-close]")?.focus(); };
    q("[data-lora-use-default]").onclick = () => {
        const shot = activeShot();
        if (!shot) return;
        ensureModePrompts(shot);
        delete shot.functionSelections.loraNodeModes;
        applyShotFunctionSelections(shot);
        renderLoraTaggedNodes();
        save();
    };
    root.querySelectorAll("[data-lora-close]").forEach((button) => { button.onclick = closeLoraDialog; });
    loraDialog.onclick = (event) => { if (event.target === loraDialog) closeLoraDialog(); };
    root.querySelectorAll("[data-mode]").forEach((button) => button.onclick = () => {
        const shot = activeShot();
        if (!shot || shot.mode === button.dataset.mode) return;
        updatePrompt();
        ensureModePrompts(shot);
        shot.mode = button.dataset.mode;
        shot.prompt = shot.prompts[shot.mode] || "";
        root.querySelectorAll("[data-mode]").forEach((item) => item.classList.toggle("active", item.dataset.mode === shot.mode));
        syncModeUI();
        renderPromptContent(shot.prompt);
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
            if (runtime.progressTrace.length > 160) runtime.progressTrace.splice(0, runtime.progressTrace.length - 160);
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
        if (/xiantuvideolatentcacheload/.test(key)) action = "读取上一分镜 Latent";
        else if (/minimaxh3finitelatentcontinuation/.test(key)) action = "安装分镜续接条件";
        else if (/xiantuvideolatentcachesave/.test(key)) action = "保存当前分镜 Latent";
        else if (/xiantuvideocontinuationtrim/.test(key)) action = "裁剪续接重叠帧";
        else if (/xiantuvideofacerepair/.test(key)) action = "人脸修复";
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
    const onDirectorInternalStage = (event) => {
        const detail = event?.detail || {};
        const eventNode = String(detail.node ?? detail.node_id ?? "");
        if (eventNode && eventNode !== String(node.id)) return;
        const label = String(detail.label || "导演台内部处理");
        const phase = String(detail.phase || "start");
        const rawPercent = Number(detail.percent);
        const internalPercent = Number.isFinite(rawPercent) ? Math.max(0, Math.min(100, rawPercent)) : null;
        const currentInternalPercent = Math.max(0, Math.min(100, Number(runtime.directorStagePercent) || 0));
        const completedInternalPercent = phase === "start" || internalPercent === null
            ? currentInternalPercent
            : Math.max(currentInternalPercent, internalPercent);
        runtime.directorStagePercent = completedInternalPercent;
        // The workbench node owns the 13%-18% execution range. Keep its
        // nested stages inside that range so the top-level "executing" event
        // and the first backend stage can never make the bar jump backwards.
        const overallPercent = runtimeOverallPercent(13 + completedInternalPercent * .05);
        const elapsed = Math.max(0, Number(detail.elapsed_ms || 0));
        const elapsedText = elapsed ? `耗时 ${(elapsed / 1000).toFixed(elapsed >= 10000 ? 1 : 2)} 秒` : "";
        const suppliedDetail = String(detail.detail || "");
        const actionDetail = phase === "complete"
            ? [suppliedDetail, elapsedText].filter(Boolean).join(" · ")
            : suppliedDetail;
        runtime.externalBusy = true;
        setGenerationProgress({
            title: phase === "complete" ? `${label}完成` : phase === "error" ? `${label}失败` : label,
            actionDetail,
            batchDetail: runtimeBatchDetail(),
            percent: overallPercent,
            phase: phase === "error" ? "prepare" : /读取|解码|VAE|Qwen|条件|Latent/.test(label) ? "load" : "prepare",
            phasePercent: completedInternalPercent,
            traceKey: `director:${String(detail.stage || label)}:${phase}`,
            traceLabel: phase === "complete" ? `${label}完成` : label,
        });
    };
    api.addEventListener?.("xiantu_video_editor_stage", onDirectorInternalStage);
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
    const historyNodeBelongsToWorkbench = (nodes, id, seen = new Set()) => {
        id = String(id);
        if (id === String(node.id)) return true;
        if (seen.has(id)) return false;
        seen.add(id);
        return Object.values(nodes[id]?.inputs || {}).some((value) => Array.isArray(value)
            && value.length === 2 && historyNodeBelongsToWorkbench(nodes, value[0], seen));
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
        const promptNodes = history?.prompt?.[2];
        if (promptNodes?.[String(node.id)] && history.outputs) {
            for (const [id, output] of Object.entries(history.outputs)) {
                if (historyNodeBelongsToWorkbench(promptNodes, id)) visit(output);
            }
        } else visit(history?.outputs || history);
        const unique = new Map();
        candidates.forEach((item) => unique.set(`${item.type}/${item.subfolder}/${item.filename}`, item));
        return [...unique.values()];
    };
    const expectedVideoOutputCount = (history) => {
        const promptNodes = history?.prompt?.[2];
        if (!promptNodes || typeof promptNodes !== "object") return 0;
        return Object.entries(promptNodes).filter(([id, item]) => (
            /(?:CreateVideo|VHS_VideoCombine|SaveVideo|VideoCombine)/i.test(String(item?.class_type || ""))
            && item?.inputs?.save_output !== false
            && (!promptNodes[String(node.id)] || historyNodeBelongsToWorkbench(promptNodes, id))
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
        if (sameOutputLocation(shot?.successfulOutput, previous)) {
            shot.successfulOutput = { ...shot.successfulOutput, filename: result.filename, subfolder: result.subfolder, type: result.type };
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
                if (shot?.successfulOutput?.filename === oldFilename && String(shot.successfulOutput.subfolder || "") === String(result.subfolder || "")) {
                    shot.successfulOutput = { ...shot.successfulOutput, filename: result.filename, subfolder: result.subfolder, type: result.type };
                }
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
        // A later failed attempt can already have written the stable filename.
        // Its file must not be mistaken for the earlier committed generation.
        if (["error", "stopped"].includes(String(shot.status || "")) && shot.successfulLatentCache?.promptId
            && shot.lastPromptId && String(shot.lastPromptId) !== String(shot.successfulLatentCache.promptId)) return null;
        if (shot.successfulOutput?.filename && await outputRecordExists(shot.successfulOutput)) {
            shot.lastOutput = { ...shot.successfulOutput };
            return shot.lastOutput;
        }
        if (["error", "stopped", "queued", "running"].includes(String(shot.status || ""))) return null;
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
    const continuityCacheKey = (shot) => {
        const committed = shot?.successfulLatentCache;
        return committed?.promptId && String(committed.key || "").startsWith("visible-tail-v3:") ? String(committed.key) : "";
    };
    const latentCacheStatus = async (shot) => {
        if (!shot?.id) return null;
        const key = continuityCacheKey(shot);
        if (!key) return false;
        try {
            const response = await api.fetchApi(`/xiantu/video-editor/latent-cache-status?key=${encodeURIComponent(key)}`);
            if (!response.ok) return null;
            return Boolean((await response.json())?.exists);
        } catch {
            return null;
        }
    };
    const injectContinuationPipeline = (prompt, shot, previousShot, useLatentContinuation = true, attemptKey = `visible-tail-v3:${makeId()}`) => {
        const nodes = prompt?.output;
        if (!nodes || typeof nodes !== "object") throw new Error("无法读取当前工作流，不能安装视频时长规范链路");
        const workbenchId = String(node.id);
        if (String(nodes[workbenchId]?.class_type || "") !== NODE) throw new Error("工作流中没有找到当前闲兔视频导演台节点");
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

        const usesLatentContinuation = Boolean(shot?.inheritPrevious);
        const cacheCandidates = [];
        const visibleEndFrames = 0;
        let continuationCount = 0;
        let cacheSaveCount = 0;
        let previousCacheId = null;
        if (usesLatentContinuation) {
            if (!previousShot) throw new Error("承接已开启，但没有找到上一分镜");
            previousCacheId = allocateId();
            nodes[previousCacheId] = {
                class_type: "XiantuVideoLatentCacheLoad",
                inputs: {
                    // Every inherited shot reads the same saved AV source.
                    // Cache availability must never select a different path.
                    cache_key: "",
                    previous_output: (previousShot.lastOutput || previousShot.successfulOutput)?.filename
                        ? JSON.stringify(previousShot.lastOutput || previousShot.successfulOutput) : "",
                    overlap_frames: Number(shot.contextTrimFrames || continuityOverlapFrames),
                },
            };
            for (const [inputName, sourceName] of [["video_vae", "VAE"], ["audio_vae", "音频 VAE"]]) {
                const link = nodes[workbenchId]?.inputs?.[sourceName];
                if (Array.isArray(link)) nodes[previousCacheId].inputs[inputName] = [...link];
            }
        }

        // Queueing remains one storyboard shot per ComfyUI prompt. Each
        // supported H3 sampler receives the preceding sampled AV latent through
        // this plugin's own continuation data node, then writes its
        // new sampled latent for the following independent prompt.
        for (const [samplerId, sampler] of Object.entries({ ...nodes })) {
            const samplerType = String(sampler?.class_type || "");
            if (!dependsOn(samplerId, workbenchId)) continue;
            sampler.inputs ||= {};
            let installed = false;

            if (/SelfLift.*H3.*Sampler|MiniMaxH3TimelineSelfLiftSampler/i.test(samplerType)) {
                const { model, positive, latent_image: targetLatent, sigmas } = sampler.inputs;
                if (![model, positive, targetLatent, sigmas].every(Array.isArray)) continue;
                if (usesLatentContinuation) {
                    const continuationId = allocateId();
                    nodes[continuationId] = {
                        class_type: "XiantuH3LatentContinuation",
                        inputs: {
                            positive,
                            target_latent: targetLatent,
                            overlap_frames: Number(shot.contextTrimFrames || continuityOverlapFrames),
                            continue_audio_latent: true,
                            model,
                            sigmas,
                            previous_latent: [previousCacheId, 0],
                        },
                    };
                    sampler.inputs.positive = [continuationId, 0];
                    sampler.inputs.latent_image = [continuationId, 1];
                    sampler.inputs.model = [continuationId, 3];
                    continuationCount += 1;
                }
                installed = true;
            } else if (samplerType === "SamplerCustomAdvanced") {
                const guiderLink = sampler.inputs.guider;
                const targetLatent = sampler.inputs.latent_image;
                const sigmas = sampler.inputs.sigmas;
                if (![guiderLink, targetLatent, sigmas].every(Array.isArray)) continue;
                const guider = nodes[String(guiderLink[0])];
                const positiveKey = Array.isArray(guider?.inputs?.conditioning) ? "conditioning" : Array.isArray(guider?.inputs?.positive) ? "positive" : "";
                if (!positiveKey || !Array.isArray(guider.inputs.model)) continue;
                if (usesLatentContinuation) {
                    const continuationId = allocateId();
                    nodes[continuationId] = {
                        class_type: "XiantuH3LatentContinuation",
                        inputs: {
                            positive: guider.inputs[positiveKey],
                            target_latent: targetLatent,
                            overlap_frames: Number(shot.contextTrimFrames || continuityOverlapFrames),
                            continue_audio_latent: true,
                            model: guider.inputs.model,
                            sigmas,
                            previous_latent: [previousCacheId, 0],
                        },
                    };
                    guider.inputs[positiveKey] = [continuationId, 0];
                    guider.inputs.model = [continuationId, 3];
                    sampler.inputs.latent_image = [continuationId, 1];
                    continuationCount += 1;
                }
                installed = true;
            }

            if (!installed) continue;
            const cacheSaveId = allocateId();
            nodes[cacheSaveId] = {
                class_type: "XiantuVideoLatentCacheSave",
                inputs: {
                    latent: [String(samplerId), 0],
                    cache_key: `${attemptKey}:${samplerId}`,
                    visible_end_frames: visibleEndFrames,
                },
            };
            cacheSaveCount += 1;
            cacheCandidates.push({ samplerId: String(samplerId), key: `${attemptKey}:${samplerId}` });
        }
        if (!cacheSaveCount) throw new Error("没有找到连接到导演台且支持AV Latent缓存的H3采样器");
        if (usesLatentContinuation && !continuationCount) throw new Error("没有找到连接本导演台且支持H3续接的采样器");

        let trimCount = 0;
        const trimIds = [];
        const saveTargets = Object.entries({ ...nodes })
            .filter(([targetId, target]) => /(?:CreateVideo|VHS_VideoCombine|SaveVideo|VideoCombine)/i.test(String(target?.class_type || "")) && dependsOn(targetId, workbenchId))
            .sort(([leftId], [rightId]) => dependsOn(rightId, leftId) ? -1 : dependsOn(leftId, rightId) ? 1 : 0);
        const preferredTarget = saveTargets.find(([, target]) => Object.values(target.inputs || {}).some((value) =>
            Array.isArray(value) && String(value[0]) === workbenchId && Number(value[1]) === 2)) || saveTargets[0];
        const eligibleCaches = cacheCandidates.filter((item) => preferredTarget && dependsOn(preferredTarget[0], item.samplerId));
        const terminalCache = eligibleCaches.find((item) => !eligibleCaches.some((other) =>
            other !== item && dependsOn(other.samplerId, item.samplerId)));
        if (runtime.currentBatch) runtime.currentBatch.cacheKey = terminalCache?.key || "";
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
            // branch a second time. Native H3 context occupies the complete
            // 22/39/56-frame prefix, so remove that complete prefix once.
            if (trimIds.some((trimId) => dependsOn(String(imageLink[0]), trimId))) continue;
            const trimId = allocateId();
            const contextFrames = Boolean(shot?.inheritPrevious) ? Number(shot.contextTrimFrames || 0) : 0;
            const trimInputs = {
                images: imageLink,
                trim_frames: contextFrames > 0 ? contextFrames : 0,
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
        const workbenchId = String(node.id);
        if (String(nodes[workbenchId]?.class_type || "") !== NODE) throw new Error("工作流中没有找到当前闲兔视频导演台节点");
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
        const dependsOnWorkbench = (nodeId, seen = new Set()) => {
            nodeId = String(nodeId);
            if (nodeId === String(node.id)) return true;
            if (seen.has(nodeId)) return false;
            seen.add(nodeId);
            return Object.values(nodes[nodeId]?.inputs || {}).some((value) => Array.isArray(value)
                && value.length === 2 && dependsOnWorkbench(value[0], seen));
        };
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
        for (const [targetId, target] of Object.entries(nodes)) {
            if (String(target?.class_type || "") !== "VHS_VideoCombine") continue;
            if (!dependsOnWorkbench(targetId)) continue;
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
    const promptExecutionError = (detail = {}, fallback = "分镜执行失败") => {
        if (detail?.response && typeof detail.response === "object") {
            const response = detail.response, top = response.error;
            const messages = [typeof top === "string" ? top : [top?.message, top?.details].filter(Boolean).join("：")];
            for (const [id, item] of Object.entries(response.node_errors || {})) {
                for (const error of item.errors || []) {
                    messages.push(`节点 ${id}${item.class_type ? ` (${item.class_type})` : ""}：${[error.message, error.details].filter(Boolean).join("：")}`);
                }
            }
            return new Error(messages.filter(Boolean).join("；") || detail.message || fallback);
        }
        const nodeId = String(detail?.node_id ?? detail?.node ?? "");
        const nodeType = String(detail?.node_type || "");
        const reason = String(detail?.exception_message || detail?.message || detail?.error || detail?.exception_type || fallback);
        const location = nodeType ? `${nodeType}${nodeId ? `（节点 ${nodeId}）` : ""}` : (nodeId ? `节点 ${nodeId}` : "");
        const error = new Error([reason, location].filter(Boolean).join(" · "));
        error.code = String(detail?.eventType || "execution_error");
        error.nodeId = nodeId;
        error.nodeType = nodeType;
        return error;
    };
    const promptHistoryError = (record) => {
        const messages = Array.isArray(record?.status?.messages) ? record.status.messages : [];
        for (let index = messages.length - 1; index >= 0; index -= 1) {
            const entry = messages[index];
            const eventType = String(Array.isArray(entry) ? entry[0] : entry?.type || "");
            const detail = (Array.isArray(entry) ? entry[1] : entry?.detail) || {};
            if (eventType === "execution_error") return promptExecutionError({ ...detail, eventType });
            if (eventType === "execution_interrupted") {
                return promptExecutionError({ ...detail, eventType, exception_message: "分镜执行被中断" });
            }
        }
        return promptExecutionError({}, "分镜执行失败，请查看 ComfyUI 任务错误");
    };
    const waitForPrompt = (promptId, onProgress) => new Promise((resolve, reject) => {
        let finished = false;
        let executionEventReceived = false;
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
        const onError = (event) => { if (matches(event)) { cleanup(); reject(promptExecutionError({ ...(event?.detail || {}), eventType: "execution_error" })); } };
        const onInterrupted = (event) => { if (matches(event)) { cleanup(); reject(promptExecutionError({ ...(event?.detail || {}), eventType: "execution_interrupted", exception_message: "分镜执行被中断" })); } };
        const onNodeProgress = (event) => {
            const raw = event?.detail || {};
            const detail = raw.progress || raw;
            const eventPrompt = detail.prompt_id ?? detail.promptId ?? raw.prompt_id ?? raw.promptId;
            if (eventPrompt != null && String(eventPrompt) !== String(promptId)) return;
            if (eventPrompt == null && String(runtime.currentBatch?.promptId || "") !== String(promptId)) return;
            executionEventReceived = true;
            const value = Number(detail.value || 0), max = Math.max(1, Number(detail.max || 1));
            onProgress?.({ phase: "progress", value, max, node: detail.node ?? detail.node_id ?? raw.node ?? raw.node_id ?? "" });
        };
        const onExecuting = (event) => {
            const detail = event?.detail || {};
            const eventPrompt = detail.prompt_id ?? detail.promptId;
            if (eventPrompt != null && String(eventPrompt) !== String(promptId)) return;
            if (eventPrompt == null && String(runtime.currentBatch?.promptId || "") !== String(promptId)) return;
            const nodeId = detail.node ?? detail.node_id;
            if (nodeId != null) { executionEventReceived = true; onProgress?.({ phase: "node", node: nodeId }); }
        };
        const onExecuted = (event) => {
            const detail = event?.detail || {};
            const eventPrompt = detail.prompt_id ?? detail.promptId;
            if (eventPrompt != null && String(eventPrompt) !== String(promptId)) return;
            if (eventPrompt == null && String(runtime.currentBatch?.promptId || "") !== String(promptId)) return;
            const nodeId = detail.node ?? detail.node_id;
            if (nodeId != null) { executionEventReceived = true; onProgress?.({ phase: "executed", node: nodeId }); }
        };
        const onCached = (event) => {
            const detail = event?.detail || {};
            const eventPrompt = detail.prompt_id ?? detail.promptId;
            if (eventPrompt != null && String(eventPrompt) !== String(promptId)) return;
            if (eventPrompt == null && String(runtime.currentBatch?.promptId || "") !== String(promptId)) return;
            const nodes = Array.isArray(detail.nodes) ? detail.nodes : [];
            if (nodes.length) executionEventReceived = true;
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
                if (!executionEventReceived) {
                    const queueResponse = await api.fetchApi("/queue");
                    if (queueResponse.ok) {
                        const queue = await queueResponse.json();
                        const entryPromptId = (entry) => String(Array.isArray(entry) ? (entry[1] ?? "") : (entry?.prompt_id ?? entry?.promptId ?? ""));
                        const running = Array.isArray(queue?.queue_running) ? queue.queue_running : [];
                        const pending = Array.isArray(queue?.queue_pending) ? queue.queue_pending : [];
                        const runningIndex = running.findIndex((entry) => entryPromptId(entry) === String(promptId));
                        const pendingIndex = pending.findIndex((entry) => entryPromptId(entry) === String(promptId));
                        if (!executionEventReceived) {
                            if (runningIndex >= 0) onProgress?.({ phase: "queued", queueState: "running", position: runningIndex + 1, ahead: 0 });
                            else if (pendingIndex >= 0) onProgress?.({ phase: "queued", queueState: "pending", position: pendingIndex + 1, ahead: pendingIndex });
                            else onProgress?.({ phase: "queued", queueState: "accepted", position: 0, ahead: 0 });
                        }
                    }
                }
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
                else if (status === "error") { cleanup(); reject(promptHistoryError(record)); }
            } catch {}
        }, 1000);
    });
    const startGenerate = async () => {
        showDirectorError();
        if (runtime.busy) return;
        updatePrompt();
        applyShotFunctionSelections(activeShot());
        const originalShotId = activeShotId;
        const selected = shots.filter((shot) => shot.selected);
        const jobs = selected.length ? selected : [activeShot()];
        const useAutomaticCompatibility = selfLiftCompatibility;
        const button = q("[data-generate]");
        runtime.busy = true;
        runtime.cancelRequested = false;
        runtime.progressTrace = [];
        runtime.directorStagePercent = 0;
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
                if (!shot.successfulOutput && shot.status === "done" && shot.lastOutput?.filename) {
                    shot.successfulOutput = { ...shot.lastOutput };
                }
                runtime.currentBatch = { index, total: jobs.length, promptId: "" };
                runtime.directorStagePercent = 0;
                // The top-right timer is for the current storyboard item, not
                // the whole batch. Reset as soon as control moves to a new item.
                startGenerationClock();
                const preparationSteps = 18;
                await reportPreparationStep(1, preparationSteps, "读取分镜任务", shot.title || `分镜 ${index + 1}`);
                activeShotId = shot.id;
                applyShotFunctionSelections(shot);
                syncSelfLiftCanvasBridges(node.graph || app.graph, node.id, useAutomaticCompatibility);
                await reportPreparationStep(2, preparationSteps, "切换当前分镜", shot.title || `分镜 ${index + 1}`);
                const position = shots.findIndex((item) => item.id === shot.id);
                const previous = position > 0 ? shots[position - 1] : null;
                await reportPreparationStep(3, preparationSteps, "读取分镜顺序", `第 ${position + 1} 个分镜`);
                const generationResolution = resolutionFor();
                await reportPreparationStep(4, preparationSteps, "读取生成参数", `${generationResolution.width}×${generationResolution.height} · ${resolutionState.fps} FPS · ${shot.seconds} 秒`);
                await reportPreparationStep(5, preparationSteps, "读取提示词", `${String(shot.prompt || "").length} 个字符`);
                await reportPreparationStep(6, preparationSteps, "校验承接关系", shot.inheritPrevious ? "检查上一分镜输出" : "本分镜不承接");
                const useLatentContinuation = Boolean(shot.inheritPrevious);
                const usesContextContinuation = Boolean(shot.inheritPrevious) && (shot.mode !== "frames" || useLatentContinuation);
                shot.contextTrimFrames = usesContextContinuation ? continuityOverlapFrames : 0;
                await reportPreparationStep(7, preparationSteps, "写入承接参数", shot.inheritPrevious ? (usesContextContinuation ? `取上一分镜末尾 ${shot.contextTrimFrames} 帧作为 H3 原生上下文` : "取上一分镜最后一帧作为首帧") : "不使用承接");
                const generationAssets = effectiveAssetsForShot(shot);
                const previousOutput = shot.inheritPrevious ? await recoverPreviousShotOutput(previous) : null;
                const needsPreviousVideo = Boolean(shot.inheritPrevious);
                if (needsPreviousVideo && !previousOutput?.filename) {
                    throw new Error(`${shot.title || `分镜 ${position + 1}`} 要承接上一分镜，但上一分镜还没有已保存的成功输出`);
                }
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
                const shotSeed = refreshWorkflowSeed(node.id, node.graph || app.graph);
                shot.lastSeed = shotSeed;
                await reportPreparationStep(12, preparationSteps, "读取工作流节点", `收集节点与连接 · 随机种子 ${shotSeed}`);
                const fullEditorState = buildEditorState();
                const executionRecord = (record) => record ? {
                    filename: String(record.filename || record.name || ""),
                    name: String(record.name || record.filename || ""),
                    subfolder: String(record.subfolder || ""),
                    type: String(record.type || record.sourceType || "output"),
                    sourceType: String(record.sourceType || record.type || "output"),
                } : null;
                const executionShot = {
                    id: String(shot.id),
                    title: String(shot.title || `分镜 ${position + 1}`),
                    prompt: String(shot.prompt || ""),
                    mode: String(shot.mode || "reference"),
                    seconds: Number(shot.seconds || 5),
                    inheritPrevious: Boolean(shot.inheritPrevious),
                    referenceSize: shot.referenceSize === "max" ? "max" : "match",
                    sequenceNumber: position + 1,
                    previousOutput: needsPreviousVideo ? executionRecord(previousOutput) : null,
                };
                // Only values consumed by video_editor.py belong in the node's
                // cache key. Timeline editing, progress, results, selection,
                // cleanup UI and random sampler seeds must not invalidate H3
                // conditioning when the actual shot inputs are unchanged.
                const executionState = {
                    version: 3,
                    activeShotId: executionShot.id,
                    filenamePrefix: String(filenamePrefix || ""),
                    resolution: { width: Number(generationResolution.width), height: Number(generationResolution.height) },
                    continuityMode: useLatentContinuation ? "latent" : "video",
                    continuityOverlapFrames: Number(continuityOverlapFrames),
                    shots: [executionShot],
                    assets: generationAssets.map((asset) => ({
                        id: String(asset.id || ""),
                        shotId: String(asset.shotId || ""),
                        global: Boolean(asset.global),
                        name: String(asset.name || asset.serverName || ""),
                        serverName: String(asset.serverName || asset.name || ""),
                        subfolder: String(asset.subfolder || ""),
                        type: String(asset.type || ""),
                        sourceType: String(asset.sourceType || "input"),
                        contentHash: String(asset.sourceContentHash || asset.contentHash || ""),
                    })),
                };
                // Old backends locate a previous video by list position. They
                // need only its successful output record, never its prompts/assets.
                if (needsPreviousVideo && previous && previousOutput) {
                    executionState.shots.unshift({ id: String(previous.id), lastOutput: executionRecord(previousOutput) });
                }
                const fullSerializedState = JSON.stringify(fullEditorState);
                let graphPrompt;
                try {
                    if (editorStateWidget) editorStateWidget.value = JSON.stringify(executionState);
                    graphPrompt = await app.graphToPrompt();
                } finally {
                    if (editorStateWidget) editorStateWidget.value = fullSerializedState;
                }
                // Serialization hooks from an older saved node must never
                // replace the execution payload with the complete editor state.
                const submittedWorkbench = graphPrompt.output?.[String(node.id)];
                if (submittedWorkbench?.inputs) submittedWorkbench.inputs.editor_state = JSON.stringify(executionState);
                const workflowWorkbench = graphPrompt.workflow?.nodes?.find((item) => String(item.id) === String(node.id));
                if (workflowWorkbench) {
                    const stateIndex = (node.widgets || []).findIndex((widget) => widget.name === "editor_state");
                    if (stateIndex >= 0 && Array.isArray(workflowWorkbench.widgets_values)) workflowWorkbench.widgets_values[stateIndex] = JSON.stringify(executionState);
                    if (workflowWorkbench.properties) delete workflowWorkbench.properties.xiantuVideoEditorState;
                }
                injectWorkflowSeed(graphPrompt, shotSeed, node.id);
                await reportPreparationStep(13, preparationSteps, "序列化工作流", `${Object.keys(graphPrompt?.output || {}).length} 个执行节点`);
                await reportPreparationStep(14, preparationSteps, "安装承接链路", shot.inheritPrevious ? (usesContextContinuation ? `${shot.contextTrimFrames} 帧 H3 原生上下文承接` : "最后一帧首帧承接") : "无需承接，保持原工作流");
                const continuityPrompt = injectContinuationPipeline(graphPrompt, shot, previous, useLatentContinuation);
                await reportPreparationStep(15, preparationSteps, "安装人脸修复链路", faceRepairSettings.enabled ? "远景人脸修复已接入" : "人脸修复未开启");
                const prompt = injectEncoderCompatibility(injectPostProcessingPipeline(continuityPrompt), generationResolution);
                await reportPreparationStep(16, preparationSteps, "写入后处理参数", faceRepairSettings.enabled ? "人脸检测、修复和输出参数" : "保持原始生成结果");
                prompt.workflow ??= {};
                prompt.workflow.extra ??= {};
                prompt.workflow.extra.VHS_KeepIntermediate = false;
                prompt.workflow.extra.VHS_MetadataImage = false;
                await reportPreparationStep(17, preparationSteps, "设置输出规则", "仅保留最终视频，不保存中间文件");
                const isCurrentOutput = (id, seen = new Set()) => {
                    id = String(id);
                    if (id === String(node.id)) return true;
                    if (seen.has(id)) return false;
                    seen.add(id);
                    return Object.values(prompt.output?.[id]?.inputs || {}).some((value) => Array.isArray(value)
                        && value.length === 2 && isCurrentOutput(value[0], seen));
                };
                Object.entries(prompt.output || {}).forEach(([id, promptNode]) => {
                    if (String(promptNode?.class_type || "") === "VHS_VideoCombine" && promptNode.inputs && isCurrentOutput(id)) {
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
                const historyPromise = waitForPrompt(response.prompt_id, ({ phase, value = 0, max = 1, node = "", queueState = "", position = 0, ahead = 0 }) => {
                    if (phase === "queued") {
                        const queuedTitle = queueState === "pending" ? "工作流排队中" : queueState === "running" ? "ComfyUI 正在启动工作流" : "工作流已提交";
                        const queuedDetail = queueState === "pending"
                            ? (ahead > 0 ? `队列第 ${position} 位 · 前面 ${ahead} 个任务` : "即将进入运行队列")
                            : queueState === "running" ? "正在检查缓存并准备执行节点" : "正在同步调度状态";
                        setGenerationProgress({ title: queuedTitle, actionDetail: queuedDetail, batchDetail: `分镜 ${index + 1}/${jobs.length}`, percent: runtimeOverallPercent(8), phase: "prepare", phasePercent: null, traceKey: `internal:${index}:queue:${queueState}`, traceLabel: queuedTitle });
                        return;
                    }
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
                const history = await historyPromise;
                if (runtime.cancelRequested) throw new Error("用户停止生成");
                shot.lastPromptId = String(response.prompt_id);
                setGenerationProgress({ title: "读取生成结果", actionDetail: "解析本次任务输出", batchDetail: `分镜 ${index + 1}/${jobs.length}`, percent: runtimeOverallPercent(99), phase: "save", phasePercent: 30, traceKey: `internal:${index}:history` });
                setGenerationProgress({ title: "整理最终文件名", actionDetail: "保留最终视频并同步预览", batchDetail: `分镜 ${index + 1}/${jobs.length}`, percent: runtimeOverallPercent(99.4), phase: "save", phasePercent: 60, traceKey: `internal:${index}:filename` });
                const { stageOutputs } = await ingestHistoryVideos(history, shot, { showPreview: true });
                if (!stageOutputs.size) throw new Error("当前分镜没有成功的视频输出，未更新续接缓存");
                shot.successfulOutput = { ...shot.lastOutput };
                shot.successfulLatentCache = runtime.currentBatch.cacheKey
                    ? { key: runtime.currentBatch.cacheKey, promptId: String(response.prompt_id) } : null;
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
            const failureMessage = promptExecutionError(error).message;
            const failedShot = jobs[runtime.currentBatch?.index] || activeShot();
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
                button.title = failureMessage;
                showDirectorError(failureMessage);
                setGenerationProgress({ title: `生成失败：${failureMessage}`, actionDetail: "", batchDetail: `分镜 ${done}/${jobs.length}`, percent: done / Math.max(1, jobs.length) * 100, phase: "prepare", phasePercent: 0 });
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
        const resultForShot = (shotId) => [...results].reverse().find((result) => String(result.shotId) === String(shotId) && resultKind(result) === mergeKind && result.filename);
        const videoLayout = timelineLayout();
        if (!videoLayout.length) { q("[data-result-merge]").title = "视频时间线没有可导出的片段"; return; }
        const missing = videoLayout.find(({ segment }) => !resultForShot(segment.shotId));
        if (missing) { q("[data-result-merge]").title = "时间线中有分镜尚未生成当前列表对应的视频"; return; }
        const audioLayout = audioTimelineLayout(videoLayout);
        const { width, height } = resolutionFor();
        const recordOf = (result) => ({ filename: result.filename, subfolder: result.subfolder || "", type: result.type || "output" });
        const timelinePayload = {
            width, height, fps: resolutionState.fps,
            video: videoLayout.map(({ segment, duration, overlap }) => ({ record: recordOf(resultForShot(segment.shotId)), sourceStart: editSegmentBounds(segment).sourceStart, duration, overlap })),
            audio: audioLayout.map(({ segment, duration, start, sourceStart }) => ({ record: recordOf(resultForShot(segment.shotId)), sourceStart, duration, timelineStart: start, muted: segment.muted, volume: segment.volume, fadeIn: segment.fadeIn, fadeOut: segment.fadeOut })),
        };
        const button = q("[data-result-merge]");
        button.disabled = true; button.textContent = "剪辑导出中";
        try {
            const response = await api.fetchApi("/xiantu/video-editor/merge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ timeline: timelinePayload }) });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(payload.error || "剪辑导出失败");
            const url = api.apiURL(`/view?${new URLSearchParams({ filename: payload.filename, subfolder: payload.subfolder || "", type: payload.type || "output" }).toString()}`);
            const mergedDuration = Number(payload.duration || videoLayout.reduce((maximum, item) => Math.max(maximum, item.end), 0));
            results.push({ shotId: "", name: payload.filename.replace(/\.mp4$/i, ""), filename: payload.filename, subfolder: payload.subfolder || "", type: payload.type || "output", url, duration: mergedDuration, actualDuration: mergedDuration, resolution: `${width} × ${height}`, created: new Date().toLocaleString(), selected: false, merged: true });
            resultView = "merged";
            renderResults(); save();
        } catch (error) { button.title = String(error?.message || error); }
        finally { button.disabled = false; button.textContent = "▦ 导出成片"; }
    };
    const setTimelineScale = (value) => { timelineScale = Math.max(20, Math.min(100, Number(value) || 38)); renderTimeline(); save(); };
    q("[data-edit-split]").onclick = splitSelectedVideoSegment;
    q("[data-edit-delete]").onclick = deleteSelectedEditSegment;
    q("[data-edit-link]").onclick = () => {
        const segment = selectedAudioEditSegment();
        if (!segment) return;
        const current = audioTimelineLayout().find((item) => String(item.segment.id) === String(segment.id));
        if (segment.linked) {
            segment.timelineStart = current?.start || 0;
            segment.linked = false;
        } else if (videoEditSegments.some((item) => String(item.id) === String(segment.videoSegmentId))) segment.linked = true;
        renderTimeline(); syncEditToolbar(); save();
    };
    q("[data-edit-mute]").onclick = () => {
        const segment = selectedAudioEditSegment();
        if (!segment) return;
        segment.muted = !segment.muted;
        renderTimeline(); syncEditToolbar(); save();
    };
    q("[data-edit-volume]").oninput = (event) => {
        const segment = selectedAudioEditSegment();
        if (!segment) return;
        segment.volume = Math.max(0, Math.min(2, Number(event.target.value || 100) / 100));
        q("[data-edit-volume-value]").textContent = `${Math.round(segment.volume * 100)}%`;
        save();
    };
    q("[data-edit-fade-in]").onchange = (event) => {
        const segment = selectedAudioEditSegment();
        if (!segment) return;
        segment.fadeIn = Math.max(0, Math.min(editSegmentBounds(segment).duration, Number(event.target.value || 0)));
        syncEditToolbar(); save();
    };
    q("[data-edit-fade-out]").onchange = (event) => {
        const segment = selectedAudioEditSegment();
        if (!segment) return;
        segment.fadeOut = Math.max(0, Math.min(editSegmentBounds(segment).duration, Number(event.target.value || 0)));
        syncEditToolbar(); save();
    };
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
    let compatibilitySyncError = "";
    const refreshSelfLiftCompatibility = () => {
        const input = q("[data-selflift-compat]");
        const label = q("[data-selflift-compat-label]");
        if (!runtime.busy) {
            try {
                syncSelfLiftCanvasBridges(node.graph || app.graph, node.id, selfLiftCompatibility);
                compatibilitySyncError = "";
            } catch (error) {
                if (compatibilitySyncError !== error.message) showDirectorError(error);
                compatibilitySyncError = error.message;
            }
        }
        const count = connectedSelfLiftNodes(node.graph || app.graph, node.id).length;
        input.disabled = count === 0 || runtime.busy;
        input.checked = count > 0 && selfLiftCompatibility;
        label.classList.toggle("available", count > 0);
        label.title = count > 0
            ? `检测到 ${count} 个当前导演台连接的 SelfLift 二采节点；勾选自动添加并连线，取消恢复原连线并移除数据兼容桥`
            : "当前导演台未连接启用的 SelfLift 二采节点";
    };
    q("[data-selflift-compat]").onchange = (event) => {
        const enabled = Boolean(event.target.checked);
        try {
            syncSelfLiftCanvasBridges(node.graph || app.graph, node.id, enabled);
            selfLiftCompatibility = enabled;
        } catch (error) { showDirectorError(error); }
        refreshSelfLiftCompatibility();
        save();
    };
    const close = () => {
        video.pause();
        clearInterval(hardwareTimer);
        clearInterval(selfLiftCompatibilityTimer);
        clearInterval(generationElapsedTimer);
        runtime.listeners.delete(renderGenerationProgress);
        api.removeEventListener?.("xiantu_video_editor_stage", onDirectorInternalStage);
        Object.entries(globalExecutionHandlers).forEach(([name, handler]) => api.removeEventListener?.(name, handler));
        assetList.forEach((asset) => URL.revokeObjectURL(asset.url));
        libraryAssets.splice(0);
        root.remove(); node._xveWorkbench = null;
    };
    q("[data-close-workbench]").onclick = close;
    root.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        if (!placeholderDialog.hidden) {
            closePlaceholderDialog();
            event.stopPropagation();
            return;
        }
        if (!sigmaDialog.hidden) {
            closeSigmaDialog();
            event.stopPropagation();
            return;
        }
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

    renderSigmaGroups(); syncContinuityUI(); renderShots(); loadShot(); renderResults(); syncEditToolbar(); save();
    refreshSelfLiftCompatibility();
    selfLiftCompatibilityTimer = setInterval(refreshSelfLiftCompatibility, 1000);
    refreshGeneratedResults().catch((error) => console.warn("视频结果实时同步失败", error));
    hydrateLegacyAssets().catch((error) => console.warn("旧参考素材恢复失败", error));
    setTimeout(() => root.focus(), 0);
    return root;
}

app.registerExtension({
    name: "Xiantu.VideoEditorWorkbench",
    async beforeRegisterNodeDef(nodeType) {
        if (nodeType.prototype.__xiantuFunctionTagMenuInstalled) return;
        nodeType.prototype.__xiantuFunctionTagMenuInstalled = true;
        const previousMenu = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function (_, options) {
            const result = previousMenu?.apply(this, arguments);
            if (!Array.isArray(options) || String(this.comfyClass || this.type) === NODE) return result;
            const current = readFunctionTag(this);
            const applyTag = (category) => {
                this.properties ??= {};
                if (category === "custom") {
                    const legacyName = current?.category === "custom" && current.note !== FUNCTION_TAG_LABELS.custom ? current.note : "";
                    const value = window.prompt("请输入自定义功能标记名称", current?.label || legacyName || "");
                    if (value === null) return;
                    const label = String(value).trim().slice(0, 30);
                    if (!label) { window.alert("自定义功能标记名称不能为空"); return; }
                    const existingNote = current?.category === "custom" && current?.label ? current.note : "";
                    this.properties[FUNCTION_TAG] = { category, label, note: existingNote };
                } else {
                    this.properties[FUNCTION_TAG] = { category, label: "", note: FUNCTION_TAG_LABELS[category] };
                }
                this.graph?.change?.();
                this.graph?.setDirtyCanvas?.(true, true);
            };
            const clearTag = () => {
                this.properties ??= {};
                delete this.properties[FUNCTION_TAG];
                this.graph?.change?.();
                this.graph?.setDirtyCanvas?.(true, true);
            };
            const tagOptions = Object.entries(FUNCTION_TAG_LABELS).map(([category, label]) => ({
                content: `${current?.category === category ? "✓ " : ""}${label}`,
                callback: () => applyTag(category),
            }));
            if (current) tagOptions.push(null, { content: "取消功能标记", callback: clearTag });
            options.unshift({
                content: `闲兔功能标记${current ? `：${functionTagDisplayName(current)}` : ""}`,
                has_submenu: true,
                submenu: { options: tagOptions },
            });
            return result;
        };
        const previousDrawForeground = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (ctx) {
            previousDrawForeground?.apply(this, arguments);
            const tag = readFunctionTag(this);
            if (!tag || String(this.comfyClass || this.type) === NODE || this.flags?.collapsed) return;
            const label = functionTagDisplayName(tag);
            ctx.save();
            ctx.font = "bold 12px sans-serif";
            const width = Math.min(Math.max(70, ctx.measureText(label).width + 18), Math.max(70, Number(this.size?.[0] || 180) - 70));
            const x = Math.max(4, Number(this.size?.[0] || 180) - width - 8);
            const y = -25;
            ctx.fillStyle = "#07343b";
            ctx.strokeStyle = "#18dfe2";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.rect(x, y, width, 19);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = "#8bfff8";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(label, x + width / 2, y + 9.5, width - 10);
            ctx.restore();
        };
    },
    async nodeCreated(node) {
        const nodeClass = String(node.comfyClass || node.type);
        if (nodeClass !== NODE) return;
        const previousSerialize = node.onSerialize;
        node.onSerialize = function (data) {
            const result = previousSerialize?.apply(this, arguments);
            compactDirectorNodeSnapshot(this, data);
            return result;
        };
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
        const open = async () => {
            if (node._xveWorkbench?.isConnected) return;
            await videoEditorStyleReady;
            const recoveryKey = `xiantu.video-editor.state:${location.hash || location.pathname}:${node.id}`;
            node._xveRecoveredState = await Promise.race([
                readDirectorRecovery(recoveryKey),
                new Promise((resolve) => setTimeout(() => resolve(null), 1000)),
            ]);
            document.querySelector(".xve-overlay")?.remove();
            node._xveWorkbench = createWorkbench(node);
            document.body.appendChild(node._xveWorkbench);
        };
        node.__xveOpen = open;
        node.addWidget("button", "打开视频编辑工作台", null, open, { serialize: false });
        requestAnimationFrame(() => {
            const computed = node.computeSize?.() || [300, 150];
            node.setSize?.([Math.max(300, Number(computed[0]) || 300), Math.max(150, Number(computed[1]) || 150)]);
            node.graph?.setDirtyCanvas?.(true, true);
        });
    },
});
