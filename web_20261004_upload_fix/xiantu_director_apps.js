import { app } from "../../scripts/app.js";

const WORKBENCHES = Object.freeze([
    ["XiantuVideoEditorWorkbench", "漫剧导演台", "分镜、素材、视频承接与时间线", "▶"],
    ["XiantuImageAssetWorkbench", "生图工作台", "图片素材、提示词与分镜生图", "▣"],
]);

function ensureStyles() {
    if (document.querySelector("style[data-xiantu-director-apps]")) return;
    const style = document.createElement("style");
    style.dataset.xiantuDirectorApps = "1";
    style.textContent = `.xiantu-director-sidebar-icon:before{content:"🎥";color:#53f5ed;font-family:"Segoe UI Emoji","Segoe UI Symbol",sans-serif;font-size:16px}button[data-testid="xiantu-director-apps-tab-button"] .side-bar-button-content:after{content:"闲兔\\A导演台";white-space:pre-line;color:#d7e6e8;font-size:9px;line-height:1.05;text-align:center}.xiantu-workflow-director-shortcut{height:30px;display:inline-flex;align-items:center;gap:5px;border:1px solid #22636a;border-radius:6px;padding:0 9px;background:#0b3035;color:#68eee8;font-size:11px;white-space:nowrap;cursor:pointer}.xiantu-workflow-director-shortcut:hover{border-color:#00dce6;background:#0b454b;color:#fff}.xiantu-app-panel{height:100%;display:grid;grid-template-rows:auto 48px minmax(0,1fr) auto;background:#111416;color:#eaf4f5}.xiantu-app-panel>header{display:flex;align-items:center;justify-content:space-between;padding:0 15px;border-bottom:1px solid #30363b}.xiantu-app-panel>header b{font-size:16px}.xiantu-app-panel>header span{padding:2px 7px;border-radius:10px;background:#087f86;font-size:10px}.xiantu-app-panel>input{margin:9px 14px;height:32px;border:1px solid #343b40;border-radius:6px;padding:0 10px;background:#272a2e;color:#edf6f7;outline:0}.xiantu-app-panel>input:focus{border-color:#10cbd2}.xiantu-app-grid{display:grid;align-content:start;gap:9px;overflow:auto;padding:8px 14px}.xiantu-app-entry{display:grid;border:1px solid #343b40;border-radius:8px;overflow:hidden;background:#1a1e21}.xiantu-app-entry:has(.xiantu-app-card:hover){border-color:#12cbd2;background:#123036}.xiantu-app-card{min-height:68px;display:grid;grid-template-columns:38px minmax(0,1fr) auto;align-items:center;gap:10px;border:0;padding:9px;background:transparent;color:#eaf5f6;text-align:left;cursor:pointer}.xiantu-app-card i{width:36px;height:36px;display:grid;place-items:center;border-radius:6px;background:#0a4c53;color:#6bfff5;font-style:normal}.xiantu-app-card div{min-width:0;display:grid;gap:3px}.xiantu-app-card small{overflow:hidden;color:#929ea3;text-overflow:ellipsis;white-space:nowrap}.xiantu-app-card>span{color:#62eee8;font-size:11px}.xiantu-relay-toggle{height:34px;display:flex;align-items:center;gap:8px;border-top:1px solid #30383d;padding:0 11px;color:#aab7bb;font-size:11px;cursor:pointer}.xiantu-relay-toggle input{width:15px;height:15px;accent-color:#00dce6}.xiantu-relay-toggle:has(input:checked){color:#68eee8;background:#0c292e}.xiantu-app-status{min-height:18px;margin:8px 14px 12px;color:#78b7bb;font-size:11px}.xiantu-app-status.error{color:#ff9bad}`;
    style.textContent += `button[data-testid="xiantu-director-apps-tab-button"]{white-space:normal!important}button[data-testid="xiantu-director-apps-tab-button"] .side-bar-button-content:after{content:none!important}.xiantu-workflow-director-shortcut{min-width:126px!important;height:32px!important;justify-content:center!important;gap:7px!important;border-color:#b58a2b!important;border-radius:7px!important;padding:0 15px!important;background:linear-gradient(180deg,#4a3a14 0%,#2f2714 100%)!important;box-shadow:inset 0 1px 0 rgba(255,226,137,.18);color:#ffe28a!important;font-size:12px!important}.xiantu-workflow-director-shortcut i{width:15px;height:15px;color:#ffd75e}.xiantu-workflow-director-shortcut:hover{border-color:#f0c64d!important;background:linear-gradient(180deg,#66501b 0%,#3b3016 100%)!important;color:#fff2ba!important}`;
    document.head.appendChild(style);
}

function installWorkflowPanelShortcut() {
    const search = document.querySelector('input[placeholder="搜索 工作流..."]');
    const header = search?.closest(".comfy-vue-side-bar-header");
    const topRow = header?.firstElementChild;
    const actions = topRow?.lastElementChild;
    if (!actions || actions.querySelector("[data-xiantu-director-shortcut]")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "xiantu-workflow-director-shortcut";
    button.dataset.xiantuDirectorShortcut = "1";
    button.innerHTML = '<i class="icon-[lucide--video]"></i><b>闲兔导演台</b>';
    button.onclick = () => document.querySelector('button[data-testid="xiantu-director-apps-tab-button"]')?.click();
    actions.prepend(button);
}

function findNode(nodeType) {
    return (activeGraph()?._nodes || []).find((item) => String(item?.comfyClass || item?.type || "") === nodeType);
}

const activeGraph = () => app.canvas?.graph || app.graph;

function openNode(nodeType) {
    const existing = findNode(nodeType);
    let target = existing;
    const graph = activeGraph();
    if (!target && graph && typeof globalThis.LiteGraph?.createNode === "function") {
        target = globalThis.LiteGraph.createNode(nodeType);
        if (target) {
            target.pos = [120, 120];
            graph.add(target);
            graph.change?.();
        }
    }
    if (target) {
        app.canvas?.selectNode?.(target);
        app.canvas?.centerOnNode?.(target);
    }
    return { target, created: Boolean(target && !existing) };
}

function setWorkbenchMode(nodeType, enabled) {
    const graph = activeGraph();
    if (!graph) return { target: null, enabled: false, error: "当前工作流画布不可用" };
    const beforeCount = Array.isArray(graph._nodes) ? graph._nodes.length : 0;
    const snapshot = typeof graph.serialize === "function" ? graph.serialize() : null;
    let target = findNode(nodeType);
    try {
        graph.beforeChange?.();
        if (enabled) {
            if (!target && typeof globalThis.LiteGraph?.createNode === "function") {
                target = globalThis.LiteGraph.createNode(nodeType);
                if (target) {
                    target.pos = [120, 120];
                    target.properties ||= {};
                    target.properties.xiantuSidebarManaged = true;
                    graph.add(target);
                }
            }
            const afterCount = Array.isArray(graph._nodes) ? graph._nodes.length : 0;
            if (afterCount < beforeCount || (target && !graph._nodes?.includes(target))) throw new Error("添加节点时检测到工作流节点异常减少");
            if (!target) return { target: null, enabled: false, error: "导演台节点创建失败" };
            graph.change?.();
            app.canvas?.selectNode?.(target);
            app.canvas?.centerOnNode?.(target);
            return { target, enabled: true };
        }
        const protectedExisting = Boolean(target && target.properties?.xiantuSidebarManaged !== true);
        if (target?.properties?.xiantuSidebarManaged === true) graph.remove?.(target);
        const afterCount = Array.isArray(graph._nodes) ? graph._nodes.length : 0;
        const expectedMinimum = beforeCount - (target?.properties?.xiantuSidebarManaged === true ? 1 : 0);
        if (afterCount < expectedMinimum) throw new Error("移除导演台节点时检测到其他工作流节点丢失");
        graph?.change?.();
        const remaining = findNode(nodeType);
        return { target: remaining, enabled: Boolean(remaining), protectedExisting };
    } catch (error) {
        if (snapshot && typeof graph.configure === "function") graph.configure(snapshot);
        graph.change?.();
        graph.setDirtyCanvas?.(true, true);
        return { target: findNode(nodeType), enabled: Boolean(findNode(nodeType)), error: String(error?.message || error) };
    } finally {
        graph.afterChange?.();
    }
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

async function openWorkbench(nodeType) {
    const result = openNode(nodeType);
    if (!result.target) return { ...result, opened: false };
    for (let attempt = 0; attempt < 60; attempt += 1) {
        const open = nodeType === "XiantuVideoEditorWorkbench"
            ? result.target.__xveOpen
            : result.target.__xiawOpen;
        if (typeof open === "function") {
            await open();
            return { ...result, opened: true };
        }
        await nextFrame();
    }
    return { ...result, opened: false };
}

function renderPanel(container) {
    ensureStyles();
    if (container._xiantuRelaySyncTimer) clearInterval(container._xiantuRelaySyncTimer);
    container.innerHTML = `<section class="xiantu-app-panel"><header><b>闲兔导演台</b><span>工作台</span></header><input type="search" placeholder="搜索工作台…"><div class="xiantu-app-grid"></div><p class="xiantu-app-status"></p></section>`;
    const search = container.querySelector("input");
    const grid = container.querySelector(".xiantu-app-grid");
    const status = container.querySelector(".xiantu-app-status");
    const draw = () => {
        const keyword = search.value.trim().toLowerCase();
        grid.replaceChildren();
        for (const [nodeType, title, description, icon] of WORKBENCHES.filter((item) => `${item[1]} ${item[2]}`.toLowerCase().includes(keyword))) {
            const entry = document.createElement("article");
            entry.className = "xiantu-app-entry";
            const button = document.createElement("button");
            button.type = "button";
            button.className = "xiantu-app-card";
            button.innerHTML = `<i>${icon}</i><div><b>${title}</b><small>${description}</small></div><span>打开</span>`;
            button.onclick = async () => {
                button.disabled = true;
                const result = await openWorkbench(nodeType);
                button.disabled = false;
                status.classList.toggle("error", !result.opened);
                status.textContent = result.opened ? `已打开：${title}` : `无法打开 ${title}，请确认插件节点已加载。`;
            };
            const relay = document.createElement("label");
            relay.className = "xiantu-relay-toggle";
            const checked = Boolean(findNode(nodeType));
            relay.innerHTML = `<input type="checkbox" data-workbench-node="${nodeType}" ${checked ? "checked" : ""}><span>当前工作流使用导演台节点</span>`;
            relay.querySelector("input").onchange = (event) => {
                const result = setWorkbenchMode(nodeType, event.target.checked);
                event.target.checked = result.enabled;
                status.classList.toggle("error", Boolean(result.error) || (event.target.checked && !result.target));
                status.textContent = result.error
                    ? `未修改工作流：${result.error}`
                    : result.protectedExisting
                    ? `已保留：${title}原有节点（侧栏不会删除工作流已有节点）`
                    : event.target.checked
                    ? `已添加：${title}节点`
                    : `已移除：${title}节点`;
            };
            entry.append(button, relay);
            grid.appendChild(entry);
        }
    };
    const syncWorkbenchSwitches = () => {
        container.querySelectorAll("[data-workbench-node]").forEach((input) => {
            input.checked = Boolean(findNode(input.dataset.workbenchNode));
        });
    };
    search.oninput = draw;
    draw();
    container._xiantuRelaySyncTimer = setInterval(() => {
        if (!container.isConnected) {
            clearInterval(container._xiantuRelaySyncTimer);
            container._xiantuRelaySyncTimer = null;
            return;
        }
        syncWorkbenchSwitches();
    }, 300);
}

ensureStyles();
const workflowShortcutObserver = new MutationObserver(() => installWorkflowPanelShortcut());
workflowShortcutObserver.observe(document.body, { childList: true, subtree: true });
installWorkflowPanelShortcut();
app.extensionManager?.registerSidebarTab?.({ id: "xiantu-director-apps", title: "闲兔 导演台", icon: "icon-[lucide--video]", type: "custom", render: renderPanel });
