import { app } from "/scripts/app.js";

const NODE_CLASS = "XiantuSamplerConditionalRelay";
const MIN_INPUTS = 3;
const MAX_INPUTS = 128;

function normalizeInputs(node) {
    if (!Array.isArray(node.inputs)) return;

    let highestConnected = -1;
    node.inputs.forEach((input, index) => {
        if (input?.link != null) highestConnected = index;
    });
    const desired = Math.min(MAX_INPUTS, Math.max(MIN_INPUTS, highestConnected + 2));

    while (node.inputs.length > desired) {
        const last = node.inputs[node.inputs.length - 1];
        if (last?.link != null) break;
        node.removeInput(node.inputs.length - 1);
    }
    while (node.inputs.length < desired) {
        node.addInput(`sampler_${node.inputs.length + 1}`, "SAMPLER");
    }
    node.inputs.forEach((input, index) => {
        input.name = `sampler_${index + 1}`;
        input.type = "SAMPLER";
    });
    node.setSize?.(node.computeSize?.() || node.size);
    app.graph?.setDirtyCanvas?.(true, true);
}

app.registerExtension({
    name: "Xiantu.DynamicSamplerRelayInputs",
    async nodeCreated(node) {
        if (String(node.comfyClass || node.type) !== NODE_CLASS) return;
        node.title = "闲兔｜采样器条件中转";

        const previousConnectionsChange = node.onConnectionsChange;
        node.onConnectionsChange = function (...args) {
            const result = previousConnectionsChange?.apply(this, args);
            queueMicrotask(() => normalizeInputs(this));
            return result;
        };

        const previousConfigure = node.onConfigure;
        node.onConfigure = function (...args) {
            const result = previousConfigure?.apply(this, args);
            queueMicrotask(() => normalizeInputs(this));
            return result;
        };

        normalizeInputs(node);
    },
});
