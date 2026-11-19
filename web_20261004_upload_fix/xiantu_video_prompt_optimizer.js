import { api } from "../../scripts/api.js";

const PROMPT_ROUTE = "/xiantu/video-editor/prompt";
const PROGRESS_EVENT = "xiantu-video-prompt-progress";
const OFFICIAL_SKILL = { id: "builtin-h3", name: "闲兔 MiniMax H3 官方技能", content: "" };
const DEFAULT_SETTINGS = {
    model: "", mmproj: "", output_language: "zh", skill_id: OFFICIAL_SKILL.id,
    mmproj_model: "",
    context_length: 8192, gpu_layers: -1, max_tokens: 1200, temperature: 0.25,
};

async function readResponse(path, options) {
    const response = await api.fetchApi(path, options);
    if (response.status === 404) throw new Error("导演台的提示词服务尚未加载，请重启 ComfyUI。");
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || `请求失败（${response.status}）`);
    return data;
}

const post = (path, body) => readResponse(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

export function mountVideoPromptOptimizer({ root, node, activeShot, getShots, getShotContext, writePrompt, isGenerating }) {
    const q = (selector) => root.querySelector(selector);
    const open = q("[data-xve-opt-open]");
    const modal = q("[data-xve-opt-dialog]");
    const panel = modal.querySelector("section");
    const field = (name) => modal.querySelector(`[name="${name}"]`);
    const action = (name) => modal.querySelector(`[data-xve-opt="${name}"]`);
    const model = field("model");
    const projector = field("mmproj");
    const skill = field("skill_id");
    const skillFile = q("[data-xve-opt-skill-files]");
    const progress = q("[data-xve-opt-progress]");
    const status = q("[data-xve-opt-status]");
    const source = q("[data-xve-opt-source]");
    const settings = { ...DEFAULT_SETTINGS, ...node.properties?.xiantuVideoPromptSettings };
    const skills = new Map((node.properties?.xiantuVideoPromptSkills || []).map((item) => [item.id, item]));
    let catalog = null;
    let loadingCatalog = false;
    let busy = false;
    let currentTask = "";
    let taskStarted = false;
    let cancelled = false;
    let cancelling = null;
    const selectedScope = () => modal.querySelector('[name="optimization_scope"]:checked')?.value;
    const targetsForScope = () => {
        const scope = selectedScope();
        if (scope === "all") return getShots();
        return scope === "shot" ? [activeShot()].filter(Boolean) : [];
    };

    function persistSettings() {
        node.properties ??= {};
        node.properties.xiantuVideoPromptSettings = { ...settings };
        node.properties.xiantuVideoPromptSkills = [...skills.values()];
        node.graph?.change?.();
    }

    function setStatus(message, percent, error = false) {
        status.textContent = message;
        status.classList.toggle("error", error);
        if (percent === undefined) progress.removeAttribute("value");
        else progress.value = percent;
    }

    function fillOptions(select, entries, selected) {
        select.replaceChildren(...entries.map(([value, name]) => new Option(name, value)));
        select.value = entries.some(([value]) => value === selected) ? selected : entries[0][0];
    }

    function renderProjectors(restoreSaved = false) {
        const installed = catalog?.mmproj_models || [];
        const suggested = catalog?.projectors_by_model?.[model.value] || [];
        const saved = restoreSaved && (
            (settings.mmproj_model === model.value && !settings.mmproj)
            || (installed.some((item) => item.path === settings.mmproj)
                && (settings.mmproj_model === model.value
                    || (settings.model === model.value && (!suggested.length || suggested.includes(settings.mmproj)))))
        );
        fillOptions(projector, [["", "纯文字"], ...installed.map((item) => [item.path, item.name])],
            saved ? settings.mmproj : suggested[0] || "");
    }

    function renderSettings() {
        const models = catalog?.models || [];
        const expected = models.find((item) => item.display === settings.model)?.display
            || models.find((item) => item.display === catalog?.selected_model)?.display
            || models.find((item) => item.name === "Qwen3.8-27B-Q4_K_M.gguf")?.display
            || models[0]?.display || "";
        const modelPlaceholder = !catalog ? "正在读取本地模型…" : models.length ? "选择本地 GGUF" : "未检测到本地 GGUF";
        fillOptions(model, [["", modelPlaceholder], ...models.map((item) => [item.display, item.name])], expected);
        renderProjectors(true);
        for (const name of ["output_language", "context_length", "gpu_layers", "max_tokens", "temperature"]) {
            field(name).value = settings[name];
        }
        fillOptions(skill, [[OFFICIAL_SKILL.id, OFFICIAL_SKILL.name], ...[...skills.values()].map((item) => [item.id, item.name])], settings.skill_id);
        renderActions();
    }

    function renderActions() {
        const shot = activeShot();
        const original = shot?.promptBeforeOptimize?.[shot.mode];
        const skillEditable = skill.value !== OFFICIAL_SKILL.id && skills.has(skill.value);
        for (const control of panel.querySelectorAll("input, select")) control.disabled = busy;
        model.disabled = busy || !catalog?.models?.length;
        projector.disabled = busy || projector.options.length < 2;
        const hasPrompt = targetsForScope().some((item) => item.prompt.trim());
        action("confirm").disabled = busy || loadingCatalog || !catalog?.dependency_installed || !model.value || !hasPrompt;
        action("confirm").title = !selectedScope() ? "请先选择优化范围" : hasPrompt ? "" : "所选范围内没有可优化的提示词";
        action("undo").disabled = busy || typeof original !== "string";
        action("original").hidden = typeof original !== "string";
        q("[data-xve-opt-original]").hidden = true;
        q("[data-xve-opt-original]").textContent = original || "";
        action("remove-skill").disabled = busy || !skillEditable;
        action("install").hidden = Boolean(catalog?.dependency_installed);
        action("install").disabled = busy || loadingCatalog || !catalog?.runtime_package_available;
        action("download-model").hidden = !catalog?.model_url || Boolean(catalog.installed);
        action("download-projector").hidden = !catalog?.mmproj_url || Boolean(catalog.mmproj_installed);
        action("add-skill").disabled = busy;
        for (const name of ["refresh", "download-model", "download-projector"]) action(name).disabled = busy || loadingCatalog;
        action("stop").hidden = !currentTask;
        action("stop").disabled = cancelled;
        open.disabled = busy;
    }

    function readSettings(rememberProjector = true) {
        for (const name of ["model", "mmproj", "output_language", "skill_id"]) settings[name] = field(name).value;
        if (rememberProjector) settings.mmproj_model = settings.model;
        for (const name of ["context_length", "gpu_layers", "max_tokens", "temperature"]) {
            const control = field(name);
            const fallback = DEFAULT_SETTINGS[name];
            const min = control.min === "" ? -Infinity : Number(control.min);
            const max = control.max === "" ? Infinity : Number(control.max);
            settings[name] = Math.min(max, Math.max(min, Number.isFinite(control.valueAsNumber) ? control.valueAsNumber : fallback));
        }
        persistSettings();
    }

    async function refreshCatalog() {
        if (loadingCatalog) return;
        loadingCatalog = true;
        setStatus("正在读取本地模型列表…");
        renderActions();
        try {
            const inventory = await readResponse(`${PROMPT_ROUTE}/models?inventory=1`);
            if (inventory.pairings_verified === false) {
                catalog = { ...inventory, projectors_by_model: catalog?.projectors_by_model || {} };
                renderSettings();
                setStatus("正在匹配视觉投影…");
                catalog = await readResponse(`${PROMPT_ROUTE}/models`);
            } else {
                catalog = inventory;
            }
            renderSettings();
            if (!catalog.dependency_installed) setStatus(catalog.dependency_error || "缺少导演台本地语言运行时。", 0, true);
            else if (!model.value) setStatus("未找到本地语言模型。", 0, true);
            else setStatus(projector.value ? "本地文字和视觉优化已就绪" : "本地文字优化已就绪", 0);
        } catch (error) {
            if (!catalog) model.options[0].text = "读取本地模型失败";
            setStatus(String(error.message || error), 0, true);
        } finally {
            loadingCatalog = false;
            renderActions();
        }
    }

    async function runAction(callback) {
        if (busy) return;
        busy = true;
        cancelled = false;
        renderActions();
        try { await callback(); }
        catch (error) { setStatus(cancelled ? "已停止" : String(error.message || error), 0, !cancelled); }
        finally {
            if (cancelling) await cancelling;
            cancelling = null;
            currentTask = "";
            taskStarted = false;
            busy = false;
            renderActions();
        }
    }

    async function optimize(targets) {
        if (isGenerating()) throw new Error("请在当前生成结束后优化提示词。");
        readSettings();
        const selectedSkill = skills.get(settings.skill_id);
        const jobs = targets.filter((shot) => shot.prompt.trim());
        let completed = 0;
        try {
            for (const shot of jobs) {
                const mode = shot.mode;
                const before = shot.prompt;
                const context = getShotContext(shot);
                const taskId = currentTask = globalThis.crypto?.randomUUID?.() || `manga-prompt-${Date.now()}-${Math.random()}`;
                taskStarted = false;
                renderActions();
                const prefix = jobs.length > 1 ? `${completed + 1}/${jobs.length} · ${shot.title} · ` : "";
                let percent = 0;
                const onProgress = ({ detail }) => {
                    if (detail?.task_id !== taskId) return;
                    taskStarted = true;
                    percent = Math.max(percent, Number(detail.percent) || 0);
                    if (!cancelled) setStatus(`${prefix}${[detail.stage, detail.detail].filter(Boolean).join(" · ")}`, (completed * 100 + percent) / jobs.length);
                };
                setStatus(`${prefix}等待本地优化引擎`, completed * 100 / jobs.length);
                api.addEventListener(PROGRESS_EVENT, onProgress);
                let response;
                try {
                    response = await post(`${PROMPT_ROUTE}/optimize`, {
                        ...settings, ...context, prompt: before.trim(), task_id: taskId, custom_skill: selectedSkill || null,
                    });
                } finally { api.removeEventListener(PROGRESS_EVENT, onProgress); }
                if (cancelled) break;
                const prompt = String(response.prompt || "").trim();
                if (!prompt) throw new Error("优化器没有返回提示词。");
                if (shot.mode !== mode || shot.prompt !== before || !getShots().includes(shot)) {
                    throw new Error(`${shot.title} 已被修改，已保留当前原文。`);
                }
                shot.promptBeforeOptimize ??= {};
                shot.promptBeforeOptimize[mode] = before;
                writePrompt(shot, prompt);
                completed++;
                if (Array.isArray(response.validation_warnings) && response.validation_warnings.length) {
                    source.textContent = response.validation_warnings.join("；");
                }
            }
        } catch (error) {
            throw new Error(`${completed > 0 ? `已完成 ${completed}/${jobs.length} 个分镜。 ` : ""}${error.message || error}`);
        }
        setStatus(cancelled ? `已停止，已完成 ${completed}/${jobs.length} 个分镜` : `已优化 ${completed} 个分镜`, completed * 100 / Math.max(1, jobs.length));
    }

    async function installResource(kind) {
        const taskId = globalThis.crypto?.randomUUID?.() || `manga-resource-${Date.now()}-${Math.random()}`;
        const onProgress = ({ detail }) => {
            if (detail?.task_id === taskId) setStatus(detail.stage, detail.percent);
        };
        api.addEventListener(PROGRESS_EVENT, onProgress);
        setStatus("正在准备下载", 0);
        try {
            await post(`${PROMPT_ROUTE}/resource`, { kind, task_id: taskId });
            await refreshCatalog();
        } finally {
            api.removeEventListener(PROGRESS_EVENT, onProgress);
        }
    }

    function close() {
        if (modal.hidden) return false;
        if (!busy) { modal.hidden = true; open.focus(); }
        return true;
    }

    open.onclick = () => {
        modal.hidden = false;
        for (const option of modal.querySelectorAll('[name="optimization_scope"]')) option.checked = false;
        renderSettings();
        action("close").focus();
        source.textContent = "";
        if (!busy) void refreshCatalog();
    };
    panel.onchange = (event) => {
        if (event.target.name === "optimization_scope" && event.target.checked) {
            for (const option of modal.querySelectorAll('[name="optimization_scope"]')) {
                if (option !== event.target) option.checked = false;
            }
        }
        if (event.target === model) {
            settings.mmproj_model = "";
            renderProjectors();
        }
        if (Object.hasOwn(DEFAULT_SETTINGS, event.target.name)) readSettings(event.target === projector);
        renderActions();
        if (!loadingCatalog && (event.target === model || event.target === projector)) {
            setStatus(model.value ? (projector.value ? "本地文字和视觉优化已就绪" : "本地文字优化已就绪") : "请选择本地语言模型", 0);
        }
    };
    action("close").onclick = close;
    modal.onclick = (event) => { if (event.target === modal) close(); };
    action("confirm").onclick = () => runAction(() => optimize(targetsForScope()));
    action("refresh").onclick = () => { if (!busy) void refreshCatalog(); };
    action("install").onclick = () => runAction(() => installResource("runtime"));
    action("download-model").onclick = () => runAction(() => installResource("model"));
    action("download-projector").onclick = () => runAction(() => installResource("projector"));
    action("stop").onclick = () => {
        cancelled = true;
        action("stop").disabled = true;
        setStatus("正在停止优化…");
        if (taskStarted) cancelling = post(`${PROMPT_ROUTE}/cancel`, { task_id: currentTask }).catch((error) => setStatus(error.message, 0, true));
    };
    action("original").onclick = () => {
        const original = q("[data-xve-opt-original]");
        original.hidden = !original.hidden;
    };
    action("undo").onclick = () => {
        const shot = activeShot();
        const original = shot.promptBeforeOptimize?.[shot.mode];
        if (typeof original !== "string") return;
        delete shot.promptBeforeOptimize[shot.mode];
        writePrompt(shot, original);
        renderActions();
        setStatus("已恢复当前分镜的原文", 0);
    };
    action("add-skill").onclick = () => skillFile.click();
    skillFile.onchange = () => {
        const files = [...skillFile.files];
        skillFile.value = "";
        runAction(async () => {
            let skipped = 0;
            for (const file of files) {
                if (file.size > 524288) { skipped++; continue; }
                const content = (await file.text()).trim();
                if (!content) { skipped++; continue; }
                const id = `skill-${Date.now()}-${Math.random().toString(36).slice(2)}`;
                skills.set(id, { id, name: file.name.replace(/\.[^.]+$/, ""), content });
                settings.skill_id = id;
            }
            persistSettings();
            renderSettings();
            setStatus(`已导入 ${files.length - skipped} 个技能${skipped ? `，跳过 ${skipped} 个空文件或超过 512 KB 的文件` : ""}`, 0);
        });
    };
    action("remove-skill").onclick = () => {
        if (!skills.delete(skill.value)) return;
        settings.skill_id = OFFICIAL_SKILL.id;
        persistSettings();
        renderSettings();
    };

    return { close, isBusy: () => busy };
}
