import { app } from "/scripts/app.js";

const NODE_NAME = "XiantuGroupSwitch";
const MODE_NORMAL = 0;
const MODE_IGNORE = 4;
const STYLE_ID = "xiantu-group-switch-style";

function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .xgs-root{box-sizing:border-box;width:100%;min-width:390px;padding:8px;color:#dffcff;font-family:Inter,"Microsoft YaHei",sans-serif}.xgs-root *{box-sizing:border-box}
      .xgs-panel{overflow:hidden;border:1px solid #185466;border-radius:9px;background:#061b23;box-shadow:0 8px 24px #0005}
      .xgs-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 11px;border-bottom:1px solid #164655;background:#08232c}.xgs-head strong{font-size:14px;color:#e7fdff}.xgs-head small{display:block;margin-top:2px;color:#77aeb8;font-size:10px}.xgs-refresh{height:28px;padding:0 10px;border:1px solid #237083;border-radius:5px;color:#a9f7ff;background:#0b3541;cursor:pointer}.xgs-refresh:hover{border-color:#00d9ec;color:#fff}
      .xgs-list{display:flex;max-height:320px;overflow:auto;flex-direction:column;gap:5px;padding:7px}.xgs-empty{padding:22px 12px;text-align:center;color:#719ca5;font-size:12px}
      .xgs-row{display:grid;grid-template-columns:minmax(120px,1fr) auto;align-items:center;gap:8px;min-height:38px;padding:5px 7px;border:1px solid #174653;border-radius:7px;background:#09252e}.xgs-row.ignored{border-color:#6f5360;background:#291d24}.xgs-info{min-width:0}.xgs-info b{display:block;overflow:hidden;color:#e5fbff;font-size:12px;text-overflow:ellipsis;white-space:nowrap}
      .xgs-toggle{display:grid;grid-template-columns:1fr 1fr;overflow:hidden;border:1px solid #285865;border-radius:6px}.xgs-toggle button{min-width:50px;height:26px;border:0;color:#8db7bf;background:#0b303a;cursor:pointer}.xgs-toggle button+button{border-left:1px solid #285865}.xgs-toggle button.active.normal{color:#00191e;background:#28d5e4}.xgs-toggle button.active.ignore{color:#fff;background:#a64962}.xgs-toggle button:disabled{cursor:not-allowed;opacity:.4}
      .xgs-foot{padding:0 10px 9px;color:#608f99;font-size:10px}.xgs-foot.error{color:#ff9ca8}
    `;
    document.head.appendChild(style);
}

function hideWidget(widget) {
    if (!widget) return;
    widget.hidden = true;
    widget.computeSize = () => [0, -4];
    widget.draw = () => {};
    widget.mouse = () => false;
    if (widget.element) widget.element.style.display = "none";
}

function groupMembers(group, controller) {
    group.recomputeInsideNodes?.();
    const direct = group._nodes;
    if (direct && typeof direct[Symbol.iterator] === "function") {
        return [...direct].filter((item) => item && item !== controller);
    }
    const [gx, gy] = group.pos || [0, 0];
    const [gw, gh] = group.size || [0, 0];
    return (controller.graph?._nodes || []).filter((item) => {
        if (!item || item === controller) return false;
        const [x, y] = item.pos || [0, 0];
        const [w, h] = item.size || [0, 0];
        const cx = x + w / 2;
        const cy = y + h / 2;
        return cx >= gx && cx <= gx + gw && cy >= gy && cy <= gy + gh;
    });
}

function groupKey(group, index) {
    return String(group.id ?? `${group.title || "未命名组"}@${Math.round(group.pos?.[0] || 0)},${Math.round(group.pos?.[1] || 0)}#${index}`);
}

function createGroupSwitchUi(node) {
    ensureStyles();
    const stateWidget = (node.widgets || []).find((widget) => widget.name === "group_states");
    hideWidget(stateWidget);
    const root = document.createElement("div");
    root.className = "xgs-root";
    root.innerHTML = `<div class="xgs-panel"><header class="xgs-head"><div><strong>闲兔｜组开关管理</strong><small>自动读取工作流分组</small></div><button type="button" class="xgs-refresh" data-refresh>刷新组</button></header><div class="xgs-list" data-list></div><div class="xgs-foot" data-status>正在读取分组…</div></div>`;
    const list = root.querySelector("[data-list]");
    const status = root.querySelector("[data-status]");
    let lastSignature = "";

    const groups = () => [...(node.graph?._groups || [])];
    const describe = () => groups().map((group, index) => {
        const members = groupMembers(group, node);
        return {
            group,
            index,
            key: groupKey(group, index),
            title: String(group.title || `未命名组 ${index + 1}`),
            members,
            modes: members.map((member) => Number(member.mode ?? MODE_NORMAL)),
        };
    });
    const signature = (items) => JSON.stringify(items.map((item) => [item.key, item.title, item.members.map((member) => member.id), item.modes]));
    const setStatus = (text, error = false) => { status.textContent = text; status.classList.toggle("error", error); };
    const persist = (items) => {
        if (!stateWidget) return;
        stateWidget.value = JSON.stringify(Object.fromEntries(items.map((item) => [item.key, item.modes.every((mode) => mode === MODE_IGNORE) ? "忽略" : item.modes.every((mode) => mode === MODE_NORMAL) ? "正常" : "混合"])));
    };
    const resize = () => requestAnimationFrame(() => {
        const height = Math.max(130, Math.min(500, Math.ceil(root.scrollHeight + 52)));
        const width = Math.max(420, Number(node.size?.[0] || 420));
        if (!node.size || Math.abs(node.size[0] - width) > 2 || Math.abs(node.size[1] - height) > 2) node.setSize?.([width, height]);
    });
    const applyMode = (item, mode) => {
        if (!item.members.length) return;
        node.graph?.beforeChange?.();
        for (const member of item.members) member.mode = mode;
        node.graph?.afterChange?.();
        node.graph?.change?.();
        node.graph?.setDirtyCanvas?.(true, true);
        app.canvas?.setDirty?.(true, true);
        lastSignature = "";
        render(true);
    };
    const render = (force = false) => {
        const items = describe();
        const nextSignature = signature(items);
        if (!force && nextSignature === lastSignature) return;
        lastSignature = nextSignature;
        list.replaceChildren();
        if (!items.length) {
            const empty = document.createElement("div");
            empty.className = "xgs-empty";
            empty.textContent = "当前工作流没有分组";
            list.appendChild(empty);
            setStatus("新增分组后会自动显示");
            persist(items);
            resize();
            return;
        }
        for (const item of items) {
            const allNormal = item.members.length > 0 && item.modes.every((mode) => mode === MODE_NORMAL);
            const allIgnored = item.members.length > 0 && item.modes.every((mode) => mode === MODE_IGNORE);
            const row = document.createElement("div");
            row.className = `xgs-row${allIgnored ? " ignored" : ""}`;
            row.innerHTML = `<div class="xgs-info"><b></b></div><div class="xgs-toggle"><button type="button" class="normal">开</button><button type="button" class="ignore">关</button></div>`;
            row.querySelector("b").textContent = item.title;
            const normal = row.querySelector(".normal");
            const ignore = row.querySelector(".ignore");
            normal.classList.toggle("active", allNormal);
            ignore.classList.toggle("active", allIgnored);
            normal.disabled = ignore.disabled = item.members.length === 0;
            normal.onclick = () => applyMode(item, MODE_NORMAL);
            ignore.onclick = () => applyMode(item, MODE_IGNORE);
            list.appendChild(row);
        }
        persist(items);
        setStatus(`已读取 ${items.length} 个组；忽略 = Bypass，不执行组内节点`);
        resize();
    };

    root.querySelector("[data-refresh]").onclick = () => render(true);
    const timer = window.setInterval(() => render(false), 750);
    root.__xgsCleanup = () => window.clearInterval(timer);
    root.__xgsRender = () => render(true);
    render(true);
    return root;
}

app.registerExtension({
    name: "Xiantu.GroupSwitch",
    async nodeCreated(node) {
        if (String(node.comfyClass || node.type || "") !== NODE_NAME) return;
        node.title = "闲兔｜组开关管理";
        const root = createGroupSwitchUi(node);
        const widget = node.addDOMWidget("xiantu_group_switch_ui", "div", root, {
            serialize: false,
            hideOnZoom: false,
            getMinHeight: () => Math.ceil(root.scrollHeight || 130),
            getMaxHeight: () => Math.ceil(root.scrollHeight || 500),
            getValue: () => undefined,
            setValue: () => {},
        });
        widget.computeSize = (width) => [Math.max(10, width), Math.ceil(root.scrollHeight || 130)];
        const previousConfigure = node.onConfigure;
        node.onConfigure = function () {
            previousConfigure?.apply(this, arguments);
            this.title = "闲兔｜组开关管理";
            requestAnimationFrame(() => root.__xgsRender?.());
        };
        const previousRemoved = node.onRemoved;
        node.onRemoved = function () {
            root.__xgsCleanup?.();
            previousRemoved?.apply(this, arguments);
        };
    },
});
