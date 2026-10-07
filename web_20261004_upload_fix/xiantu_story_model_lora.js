import { app } from "/scripts/app.js";

const NODE_NAME = "XiantuStoryModelLora";
const STYLE_ID = "xiantu-story-model-lora-style";
const EMPTY_MODEL = "未检测到 GGUF 主模型";
const EMPTY_LORA = "未检测到 llama LoRA";

function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .xsml{box-sizing:border-box;width:100%;padding:10px;color:#e9f1fa;font-family:Inter,"Microsoft YaHei",sans-serif}.xsml *{box-sizing:border-box}.xsml-card{overflow:hidden;border:1px solid #3a4b61;border-radius:9px;background:#182330}.xsml-head{display:flex;align-items:center;justify-content:space-between;padding:9px 10px;border-bottom:1px solid #304054}.xsml-head strong{font-size:12px}.xsml-tag{padding:2px 7px;border-radius:999px;color:#c7eeff;background:#174f70;font-size:9px}.xsml-body{padding:10px}.xsml-field{display:flex;flex-direction:column;gap:4px;margin-bottom:8px}.xsml-field label{color:#93a5b9;font-size:9px}.xsml-select,.xsml-input{width:100%;border:1px solid #40526a;border-radius:6px;padding:7px 8px;color:#edf5fd;background:#101a25;font-size:10px}.xsml-row{display:grid;grid-template-columns:1fr 1fr;gap:8px}.xsml-toolbar{display:flex;justify-content:space-between;gap:7px;margin:8px 0}.xsml-btn{border:1px solid #465a73;border-radius:6px;padding:6px 9px;color:#e8f1fa;background:#263548;font-size:9px;cursor:pointer}.xsml-btn.primary{border-color:#367ab0;background:#205c83}.xsml-list{display:flex;max-height:220px;flex-direction:column;gap:7px;overflow:auto}.xsml-item{display:grid;grid-template-columns:20px minmax(0,1fr) 62px 27px;gap:6px;align-items:center;padding:7px;border:1px solid #34475d;border-radius:7px;background:#121e2a}.xsml-item select,.xsml-item input{min-width:0;width:100%;border:1px solid #3d5067;border-radius:5px;padding:5px;color:#e9f1fa;background:#0c1620;font-size:9px}.xsml-note{grid-column:2/4}.xsml-remove{width:27px;height:27px;border:1px solid #75424b;border-radius:5px;color:#ffc2c7;background:#472a30;cursor:pointer}.xsml-empty{padding:12px;text-align:center;color:#73879d;font-size:9px}
    `;
    document.head.appendChild(style);
}

function findWidget(node, name) { return (node.widgets || []).find((item) => item.name === name); }
function hideWidget(item) { if (!item) return; item.type = "converted-widget"; item.hidden = true; item.computeSize = () => [0, -4]; item.draw = () => {}; item.mouse = () => false; item.serializeValue = async () => item.value; if (item.element) item.element.style.display = "none"; }
function parseStack(value) { try { const data = JSON.parse(String(value || "[]")); return Array.isArray(data) ? data : []; } catch { return []; } }

app.registerExtension({
    name: "Xiantu.StoryModelLora",
    async nodeCreated(node) {
        if (String(node.comfyClass || node.type || "") !== NODE_NAME) return;
        ensureStyles(); node.title = "闲兔｜故事模型与 LoRA";
        const modelWidget = findWidget(node, "model_name"), contextWidget = findWidget(node, "context_length"), gpuWidget = findWidget(node, "gpu_layers"), catalogWidget = findWidget(node, "lora_catalog"), stackWidget = findWidget(node, "lora_stack");
        [modelWidget, contextWidget, gpuWidget, catalogWidget, stackWidget].forEach(hideWidget);
        const modelNames = [...(modelWidget?.options?.values || [])].filter((name) => name && name !== EMPTY_MODEL);
        const loraNames = [...(catalogWidget?.options?.values || [])].filter((name) => name && name !== EMPTY_LORA);
        let entries = parseStack(stackWidget?.value);
        const root = document.createElement("div"); root.className = "xsml";
        root.innerHTML = `<section class="xsml-card"><div class="xsml-head"><strong>故事分镜语言模型</strong><span class="xsml-tag">llama.cpp</span></div><div class="xsml-body"><div class="xsml-field"><label>GGUF 主模型</label><select class="xsml-select" data-model></select></div><div class="xsml-row"><div class="xsml-field"><label>上下文长度</label><input class="xsml-input" data-context type="number" min="4096" max="131072" step="1024"></div><div class="xsml-field"><label>GPU 层数</label><input class="xsml-input" data-gpu type="number" min="0" max="999"></div></div><div class="xsml-toolbar"><strong>LoRA Adapter</strong><button class="xsml-btn primary" data-add>＋ 添加 LoRA</button></div><div class="xsml-list" data-list></div></div></section>`;
        const model = root.querySelector("[data-model]"), context = root.querySelector("[data-context]"), gpu = root.querySelector("[data-gpu]"), list = root.querySelector("[data-list]");
        modelNames.forEach((name) => { const option = document.createElement("option"); option.value = name; option.textContent = name; model.appendChild(option); });
        const savedModel = String(modelWidget?.value || "");
        model.value = modelNames.includes(savedModel) ? savedModel : (modelNames[0] || "");
        context.value = contextWidget?.value ?? 32768; gpu.value = gpuWidget?.value ?? 99;
        const save = () => { if (modelWidget) modelWidget.value = model.value; if (contextWidget) contextWidget.value = Number(context.value || 32768); if (gpuWidget) gpuWidget.value = Number(gpu.value || 99); if (stackWidget) stackWidget.value = JSON.stringify(entries); node.graph?.setDirtyCanvas(true, true); };
        const render = () => { list.replaceChildren(); if (!entries.length) { const empty = document.createElement("div"); empty.className = "xsml-empty"; empty.textContent = loraNames.length ? "可添加多个故事 LoRA，并分别设置强度" : "请把 llama LoRA 放入 ComfyUI/models/llm_loras"; list.appendChild(empty); return; } entries.forEach((entry, index) => { const item = document.createElement("div"); item.className = "xsml-item"; item.innerHTML = `<input type="checkbox" ${entry.enabled !== false ? "checked" : ""} title="启用"><select></select><input type="number" min="-4" max="4" step="0.05" value="${Number(entry.strength ?? 1)}" title="强度"><button class="xsml-remove" title="移除">×</button><input class="xsml-note" value="" placeholder="备注：这个 LoRA 用来做什么">`; const enabled = item.children[0], select = item.children[1], strength = item.children[2], remove = item.children[3], note = item.children[4]; loraNames.forEach((name) => { const option = document.createElement("option"); option.value = name; option.textContent = name; select.appendChild(option); }); select.value = entry.name || loraNames[0] || ""; note.value = entry.note || ""; enabled.onchange = () => { entry.enabled = enabled.checked; save(); }; select.onchange = () => { entry.name = select.value; save(); }; strength.onchange = () => { entry.strength = Math.max(-4, Math.min(4, Number(strength.value || 1))); save(); }; note.oninput = () => { entry.note = note.value.slice(0, 500); save(); }; remove.onclick = () => { entries.splice(index, 1); save(); render(); }; list.appendChild(item); }); };
        root.querySelector("[data-add]").onclick = () => { if (!loraNames.length) return; entries.push({ name: loraNames[0], strength: 1, enabled: true, note: "" }); save(); render(); };
        [model, context, gpu].forEach((element) => element.onchange = save); render(); save();
        const dom = node.addDOMWidget("xiantu_story_model_lora_ui", "div", root, { serialize: false, hideOnZoom: false, getMinHeight: () => Math.ceil(root.scrollHeight || 270), getMaxHeight: () => Math.ceil(root.scrollHeight || 270), getValue: () => undefined, setValue: () => {} });
        dom.computeSize = (width) => [Math.max(10, width), Math.ceil(root.scrollHeight || 270)];
        requestAnimationFrame(() => node.setSize?.([390, Math.max(320, root.scrollHeight + 65)]));
    },
});
