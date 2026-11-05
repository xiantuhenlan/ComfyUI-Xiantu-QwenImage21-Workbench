import { app } from "/scripts/app.js";

const NODE_CLASS = "XiantuUniversalRelay";

function normalizeInputs(node) {
    if (!Array.isArray(node.inputs) || !Array.isArray(node.outputs)) return;
    if (node.title === "中转节点") node.title = "闲兔中转器";
    let lastConnected = -1;
    node.inputs.forEach((input, index) => {
        if (input?.link != null) lastConnected = index;
    });
    const desired = Math.min(128, Math.max(3, lastConnected + 2));
    while (node.inputs.length > desired) {
        if (node.inputs[node.inputs.length - 1]?.link != null) break;
        node.removeInput(node.inputs.length - 1);
    }
    while (node.inputs.length < desired) {
        node.addInput(`input_${node.inputs.length + 1}`, "*");
    }
    while (node.outputs.length > 1) {
        node.removeOutput(node.outputs.length - 1);
    }
    if (node.outputs.length === 0) {
        node.addOutput("输出 1", "*");
    }
    node.inputs.forEach((input, index) => {
        input.name = `input_${index + 1}`;
        input.label = `输入 ${index + 1}`;
        input.type = "*";
    });
    node.outputs.forEach((output, index) => {
        output.name = `输出 ${index + 1}`;
        output.type = "*";
    });
    node.setSize?.(node.computeSize?.() || node.size);
    app.graph?.setDirtyCanvas?.(true, true);
}

app.registerExtension({
    name: "Xiantu.IndependentUniversalRelay",
    nodeCreated(node) {
        if (String(node.comfyClass || node.type) !== NODE_CLASS) return;
        for (const hook of ["onConnectionsChange", "onConfigure"]) {
            const previous = node[hook];
            node[hook] = function (...args) {
                const result = previous?.apply(this, args);
                queueMicrotask(() => normalizeInputs(this));
                return result;
            };
        }
        normalizeInputs(node);
    },
});
