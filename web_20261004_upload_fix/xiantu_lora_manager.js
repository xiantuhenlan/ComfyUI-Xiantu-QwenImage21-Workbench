import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

const NODE_NAME = "XiantuLoraManager";
const STYLE_ID = "xiantu-lora-manager-style";
const EMPTY_LORA_LABEL = "未找到 LoRA 文件";

function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .xlm-root{box-sizing:border-box;width:100%;min-width:540px;padding:10px;color:#e8edf5;font-family:Inter,"Microsoft YaHei",sans-serif}.xlm-root *{box-sizing:border-box}
      .xlm-panel{overflow:hidden;border:1px solid #344052;border-radius:10px;background:#1c222c}.xlm-head,.xlm-actions{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 10px}.xlm-head{border-bottom:1px solid #303a49}.xlm-head strong{font-size:13px}.xlm-head small{margin-left:7px;color:#8e9bad;font-size:10px}.xlm-badge{padding:2px 7px;border-radius:999px;color:#c8baff;background:#3a3159;font-size:9px}
      .xlm-list{display:flex;flex-direction:column;gap:7px;padding:10px}.xlm-empty{padding:22px;text-align:center;color:#79879a;font-size:11px}.xlm-row{display:grid;grid-template-columns:24px minmax(180px,1fr) 78px minmax(150px,1fr) auto;align-items:center;gap:6px;padding:7px;border:1px solid #354153;border-radius:7px;background:#242b36}.xlm-row.off{opacity:.55}.xlm-row input,.xlm-row select{min-width:0;width:100%;height:30px;border:1px solid #435066;border-radius:5px;padding:4px 6px;color:#e9eef6;background:#161c24;font-size:10px}.xlm-row input[type=checkbox]{width:15px;height:15px}.xlm-row input[type=number]{text-align:center}.xlm-tools{display:flex;gap:3px}.xlm-tools button,.xlm-actions button{border:1px solid #405069;border-radius:5px;color:#d7dfeb;background:#293342;cursor:pointer}.xlm-tools button{width:25px;height:27px;padding:0}.xlm-tools button.danger{color:#efb0b3;background:#3a252a}.xlm-actions{border-top:1px solid #303a49}.xlm-actions div{display:flex;align-items:center;gap:6px}.xlm-actions button{padding:6px 9px;font-size:10px}.xlm-actions button.primary{border-color:#39795e;color:#eafff4;background:#276047}.xlm-status{padding:0 10px 9px;color:#8f9bad;font-size:10px}.xlm-status.error{color:#ff9b9f}
      @media(max-width:700px){.xlm-row{grid-template-columns:24px 1fr 72px}.xlm-row .xlm-note{grid-column:2/4}.xlm-tools{grid-column:2/4}}
    `;
    document.head.appendChild(style);
}

function findWidget(node, name) { return (node.widgets || []).find((widget) => widget.name === name); }
function hideWidget(widget) {
    if (!widget || widget.__xlmHidden) return;
    widget.__xlmHidden = true; widget.origType ??= widget.type; widget.type = "converted-widget"; widget.hidden = true;
    widget.computeSize = () => [0, -4]; widget.draw = () => {}; widget.mouse = () => false; widget.serializeValue = async () => widget.value;
    if (widget.element) widget.element.style.display = "none";
}
function parseStack(value) {
    try { const parsed = JSON.parse(String(value || "[]")); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
function normalizeEntry(entry = {}, fallback = "") {
    return {
        enabled: entry.enabled !== false,
        name: String(entry.name || fallback),
        strength_model: Number.isFinite(Number(entry.strength_model)) ? Number(entry.strength_model) : 1,
        note: String(entry.note || ""),
    };
}

function createManagerUi(node) {
    ensureStyles();
    const catalogWidget = findWidget(node, "lora_catalog"), stackWidget = findWidget(node, "lora_stack");
    [catalogWidget, stackWidget].forEach(hideWidget);
    let catalog = [...(catalogWidget?.options?.values || [])].filter((name) => name && name !== EMPTY_LORA_LABEL);
    let entries = parseStack(stackWidget?.value).map((entry) => normalizeEntry(entry));

    const root = document.createElement("div"); root.className = "xlm-root";
    root.innerHTML = `<div class="xlm-panel"><div class="xlm-head"><div><strong>闲兔 LoRA 管理器</strong><small>按列表顺序应用，可记录每个 LoRA 的用途</small></div><span class="xlm-badge" data-count>0 个</span></div><div class="xlm-list" data-list></div><div class="xlm-actions"><div><button type="button" class="primary" data-add>＋ 添加 LoRA</button><button type="button" data-refresh>刷新列表</button></div><button type="button" data-clear>清空</button></div><div class="xlm-status" data-status></div></div>`;
    const list = root.querySelector("[data-list]"), count = root.querySelector("[data-count]"), status = root.querySelector("[data-status]");
    const markDirty = () => { node.graph?.setDirtyCanvas(true, true); node.setDirtyCanvas?.(true, true); };
    const setStatus = (message, error = false) => { status.textContent = message; status.classList.toggle("error", error); };
    const persist = () => { if (stackWidget) stackWidget.value = JSON.stringify(entries); node.properties ??= {}; node.properties.xiantuLoraStack = JSON.parse(JSON.stringify(entries)); markDirty(); };
    const scheduleSize = () => requestAnimationFrame(() => { const height = Math.max(210, Math.ceil(root.scrollHeight + 105)); const width = Math.max(570, Number(node.size?.[0] || 570)); if (!node.size || Math.abs(node.size[1] - height) > 3) node.setSize?.([width, height]); });
    const move = (index, offset) => { const target = index + offset; if (target < 0 || target >= entries.length) return; const [item] = entries.splice(index, 1); entries.splice(target, 0, item); persist(); render(); };
    const render = () => {
        list.replaceChildren(); count.textContent = `${entries.length} 个`;
        if (!entries.length) { const empty = document.createElement("div"); empty.className = "xlm-empty"; empty.textContent = catalog.length ? "点击“添加 LoRA”建立加载列表" : "没有扫描到 LoRA 文件，请把模型放入 ComfyUI/models/loras 后刷新"; list.appendChild(empty); scheduleSize(); return; }
        entries.forEach((entry, index) => {
            const row = document.createElement("div"); row.className = `xlm-row${entry.enabled ? "" : " off"}`;
            const enabled = document.createElement("input"); enabled.type = "checkbox"; enabled.checked = entry.enabled; enabled.title = "启用/停用"; enabled.onchange = () => { entry.enabled = enabled.checked; persist(); render(); };
            const select = document.createElement("select"); const names = catalog.includes(entry.name) || !entry.name ? catalog : [entry.name, ...catalog]; names.forEach((name) => { const option = document.createElement("option"); option.value = name; option.textContent = name; select.appendChild(option); }); select.value = entry.name; select.onchange = () => { entry.name = select.value; persist(); };
            const modelStrength = document.createElement("input"); modelStrength.type = "number"; modelStrength.min = "-100"; modelStrength.max = "100"; modelStrength.step = "0.01"; modelStrength.value = String(entry.strength_model); modelStrength.title = "MODEL 强度"; modelStrength.onchange = () => { entry.strength_model = Number(modelStrength.value); persist(); };
            const note = document.createElement("input"); note.className = "xlm-note"; note.type = "text"; note.placeholder = "用途备注，例如：东方人像、服装材质、电影光影"; note.value = entry.note; note.oninput = () => { entry.note = note.value; persist(); };
            const tools = document.createElement("div"); tools.className = "xlm-tools";
            [["↑", () => move(index, -1), "上移"], ["↓", () => move(index, 1), "下移"], ["×", () => { entries.splice(index, 1); persist(); render(); }, "删除"]].forEach(([label, action, title], toolIndex) => { const button = document.createElement("button"); button.type = "button"; button.textContent = label; button.title = title; if (toolIndex === 2) button.className = "danger"; button.onclick = action; tools.appendChild(button); });
            row.append(enabled, select, modelStrength, note, tools); list.appendChild(row);
        });
        scheduleSize();
    };
    const refreshCatalog = async () => {
        setStatus("正在刷新 LoRA 列表…");
        try {
            const response = await api.fetchApi(`/object_info/${NODE_NAME}`); const payload = await response.json();
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            catalog = [...(payload?.[NODE_NAME]?.input?.required?.lora_catalog?.[0] || [])].filter((name) => name && name !== EMPTY_LORA_LABEL);
            if (catalogWidget) { catalogWidget.options ??= {}; catalogWidget.options.values = catalog.length ? catalog : [EMPTY_LORA_LABEL]; catalogWidget.value = catalog[0] || EMPTY_LORA_LABEL; }
            setStatus(`已读取 ${catalog.length} 个 LoRA 文件`); render();
        } catch (error) { setStatus(`刷新失败：${String(error?.message || error)}`, true); }
    };
    root.querySelector("[data-add]").onclick = () => { if (!catalog.length) return setStatus("没有可添加的 LoRA，请放入模型后点击刷新列表。", true); entries.push(normalizeEntry({}, catalog.find((name) => !entries.some((entry) => entry.name === name)) || catalog[0])); persist(); render(); };
    root.querySelector("[data-refresh]").onclick = refreshCatalog;
    root.querySelector("[data-clear]").onclick = () => { entries = []; persist(); render(); };
    root.__xlmSync = () => { entries = parseStack(stackWidget?.value || JSON.stringify(node.properties?.xiantuLoraStack || [])).map((entry) => normalizeEntry(entry)); render(); };
    render(); return root;
}

app.registerExtension({
    name: "Xiantu.QwenImage21LoraManager",
    async nodeCreated(node) {
        if (String(node.comfyClass || node.type || "") !== NODE_NAME) return;
        node.title = "闲兔 LoRA 管理器";
        const root = createManagerUi(node);
        const widget = node.addDOMWidget("xiantu_lora_manager_ui", "div", root, { serialize: false, hideOnZoom: false, getMinHeight: () => Math.ceil(root.scrollHeight || 210), getMaxHeight: () => Math.ceil(root.scrollHeight || 210), getValue: () => undefined, setValue: () => {} });
        widget.computeSize = (width) => [Math.max(10, width), Math.ceil(root.scrollHeight || 210)];
        const observer = new ResizeObserver(() => node.setDirtyCanvas?.(true, true)); observer.observe(root);
        const previousConfigure = node.onConfigure; node.onConfigure = function () { previousConfigure?.apply(this, arguments); this.title = "闲兔 LoRA 管理器"; requestAnimationFrame(() => root.__xlmSync?.()); };
        const previousRemoved = node.onRemoved; node.onRemoved = function () { observer.disconnect(); previousRemoved?.apply(this, arguments); };
        requestAnimationFrame(() => root.__xlmSync?.());
    },
});
